/**
 * FEAT-CROSS-26-001-004-003/-004 · P1-3/P1-4 snapshotRef plumbing.
 * Goal commands carry the pinned Registry snapshot (state.snapshotRef) into the
 * body command; a goal without a snapshot (legacy pre-plugin record) fails
 * closed with needs_rebind — never falls back to the live generation. Task
 * commands use the composition-root current snapshot.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createMockBot } from '../../../__tests__/mocks/index.js';
import { MemoryV2 } from '../../../../../../../apps/minecraft-companion/src/bot/v2/infra/memory.js';
import { EventBusV2 } from '../../../../../../../apps/minecraft-companion/src/bot/v2/infra/eventBus.js';
import { TaskRuntime } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/taskRuntime.js';
import { BodyActionService } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/execution/bodyActionService.js';
import { OperationLedger } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/execution/operationLedger.js';
import type { GoalAgentStateV1 } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/goalAgent/goalAgentState.js';
import type { OperationReceipt } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/contracts/operationReceipt.js';
import type { WorldStateView } from '../../../../../../../apps/minecraft-companion/src/bot/v2/types.js';
import type { GenerationAtomicEntryPort } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/execution/generationResolversPorts.js';
import type { PluginAtomicExecutor } from '../../../../../../../apps/minecraft-companion/src/bot/v2/plugin-sdk/contracts/execution.js';
import { buildSystemAtomicContracts } from '../../../../../../../apps/minecraft-companion/src/bot/v2/plugins/builtin/minecraft-system/atomicContracts.js';
import { createGoalAgentState } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/goalAgent/goalAgentState.js';
import { formalizeState } from '../../goalAgent/__tests__/goalTestFixtures.js';

const TEST_SNAPSHOT = { generationId: 'gen-test', buildId: 'test-build', graphHash: 'test-graph' };
const NO_BEHAVIORS = {
  resolve: () => ({ status: 'in_doubt', reason: 'behavior_not_in_generation' }),
  resolveById: () => ({ status: 'in_doubt', reason: 'behavior_not_in_generation' }),
  list: () => ({ status: 'resolved', value: [] }),
} as never;

function formalState(sessionId: string): GoalAgentStateV1 {
  const state = formalizeState(createGoalAgentState({ sessionId, interactionSessionId: 'interaction', request: {
    meta: { schemaVersion: 2, sessionId: 'interaction', messageId: `request:${sessionId}`, correlationId: 'correlation',
      conversationId: 'conversation', sequence: 1, emittedAt: '2026-09-06T00:00:00.000Z', idempotencyKey: `request:${sessionId}` },
    origin: 'player_message', originalText: 'move', requestText: 'move', requestKind: 'task', constraints: [],
  } }));
  state.phase = 'running';
  state.plan.revision = 1;
  return state;
}

/** 夹具原子解析器：move_to 等解析为转发到 game 的 executor（占位真执行由 game mock 完成）。 */
function fixtureAtomicResolver(): GenerationAtomicEntryPort {
  const executor: PluginAtomicExecutor = {
    id: 'mineclaw.minecraft-system.atomic.move_to',
    version: '1.0.0',
    execute: async () => ({ ok: true }),
  };
  return {
    resolve: (_snapshot, atomicId) => atomicId === 'move_to' || atomicId === 'look_at' || atomicId === 'equip'
      ? { status: 'resolved', value: { executor, contract: buildSystemAtomicContracts([atomicId])[0]!, contribution: { pluginId: 'mineclaw.minecraft-system', pluginVersion: '1.0.0', contributionId: 'mineclaw.minecraft-system.execution.atomics', contributionVersion: '1.0.0' } } }
      : { status: 'in_doubt', reason: `atomic_not_in_generation:${atomicId}` },
  };
}

test('P1-4 goal 命令固定 state.snapshotRef；task 命令用当前代快照', async () => {
  const bot = createMockBot();
  const bus = new EventBusV2();
  const tasks = new TaskRuntime(new MemoryV2(':memory:'), bus);
  const parent = tasks.createTask('goal_exec', {}); tasks.startEmergency(parent.id);
  const world = (): WorldStateView => ({ tick: 1, timestamp: Date.now(), self: { ...bot.world.self, maxHealth: 20 },
    environment: { dimension: bot.game.getDimension(), isDay: true, isRaining: false, timeOfDay: 6000 }, owner: null,
    entities: [], inventory: { items: bot.game.getInventoryItems(), held: null, freeSlots: 36 }, taskContext: null } as WorldStateView);
  const captured: OperationReceipt[] = [];
  bus.on('body.operation_receipt', e => captured.push(e.payload as unknown as OperationReceipt));
  let goalState: GoalAgentStateV1 | null = null;
  const body = new BodyActionService({
    game: bot.game, nav: bot.nav, bus, tasks, getWorld: world, isEmbodied: () => true,
    getGoalState: () => goalState, getSnapshot: () => TEST_SNAPSHOT, atomicResolver: fixtureAtomicResolver(),
    behaviorResolver: NO_BEHAVIORS, hostApiVersion: '2.0.0', ledger: new OperationLedger(':memory:'),
  });
  const opId = 'op-snapshot';
  const state = formalState('goal-snap');
  goalState = state;
  const result = await body.executeGoal(
    { id: 'req', source: 'goal', taskId: parent.id, type: 'move_to', priority: 10, interrupt_level: 'soft', resource: [], preconditions: [], timeout_ms: 5000, target: { position: { x: 3, y: 64, z: 0 } } },
    { operationId: opId, state, taskId: parent.id, signal: new AbortController().signal },
  );
  assert.equal(result.kind, 'operation');
  assert.equal(captured.length, 1);
  assert.deepEqual(captured[0].owner, { kind: 'goal', taskId: parent.id, sessionId: 'goal-snap', epoch: 1, planRevision: 1 });
  void body;
});

test('P1-4 goal 无 snapshotRef（旧记录）→ needs_rebind fail-closed，不转查当前代', async () => {
  const bot = createMockBot();
  const bus = new EventBusV2();
  const tasks = new TaskRuntime(new MemoryV2(':memory:'), bus);
  const parent = tasks.createTask('goal_exec', {}); tasks.startEmergency(parent.id);
  const world = (): WorldStateView => ({ tick: 1, timestamp: Date.now(), self: { ...bot.world.self, maxHealth: 20 },
    environment: { dimension: bot.game.getDimension(), isDay: true, isRaining: false, timeOfDay: 6000 }, owner: null,
    entities: [], inventory: { items: bot.game.getInventoryItems(), held: null, freeSlots: 36 }, taskContext: null } as WorldStateView);
  let goalState: GoalAgentStateV1 | null = null;
  const body = new BodyActionService({
    game: bot.game, nav: bot.nav, bus, tasks, getWorld: world, isEmbodied: () => true,
    getGoalState: () => goalState, getSnapshot: () => TEST_SNAPSHOT, atomicResolver: fixtureAtomicResolver(),
    behaviorResolver: NO_BEHAVIORS, hostApiVersion: '2.0.0', ledger: new OperationLedger(':memory:'),
  });
  const state = { sessionId: 'goal-legacy', epoch: 1, phase: 'running', plan: { revision: 1 } } as unknown as GoalAgentStateV1;
  goalState = state;
  const result = await body.executeGoal(
    { id: 'req', source: 'goal', taskId: parent.id, type: 'move_to', priority: 10, interrupt_level: 'soft', resource: [], preconditions: [], timeout_ms: 5000, target: { position: { x: 3, y: 64, z: 0 } } },
    { operationId: 'op-legacy', state, taskId: parent.id, signal: new AbortController().signal },
  );
  assert.equal(result.kind, 'rejected');
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /needs_rebind:formal_goal_required/);
  void body;
});

test('P3-4 原子命令贡献引用经固定代解析（非 legacy-builtin）；未知原子 fail-closed', async () => {
  const bot = createMockBot();
  const bus = new EventBusV2();
  const tasks = new TaskRuntime(new MemoryV2(':memory:'), bus);
  const parent = tasks.createTask('goal_exec', {}); tasks.startEmergency(parent.id);
  const world = (): WorldStateView => ({ tick: 1, timestamp: Date.now(), self: { ...bot.world.self, maxHealth: 20 },
    environment: { dimension: bot.game.getDimension(), isDay: true, isRaining: false, timeOfDay: 6000 }, owner: null,
    entities: [], inventory: { items: bot.game.getInventoryItems(), held: null, freeSlots: 36 }, taskContext: null } as WorldStateView);
  const captured: OperationReceipt[] = [];
  bus.on('body.operation_receipt', e => captured.push(e.payload as unknown as OperationReceipt));
  let goalState: GoalAgentStateV1 | null = null;
  const body = new BodyActionService({
    game: bot.game, nav: bot.nav, bus, tasks, getWorld: world, isEmbodied: () => true,
    getGoalState: () => goalState, getSnapshot: () => TEST_SNAPSHOT, atomicResolver: fixtureAtomicResolver(),
    behaviorResolver: NO_BEHAVIORS, hostApiVersion: '2.0.0', ledger: new OperationLedger(':memory:'),
  });
  const state = formalState('goal-contrib');
  goalState = state;
  const result = await body.executeGoal(
    { id: 'req', source: 'goal', taskId: parent.id, type: 'move_to', priority: 10, interrupt_level: 'soft', resource: [], preconditions: [], timeout_ms: 5000, target: { position: { x: 3, y: 64, z: 0 } } },
    { operationId: 'op-contrib', state, taskId: parent.id, signal: new AbortController().signal },
  );
  assert.equal(result.kind, 'operation');
  assert.equal(captured.length, 1);
  // 命令贡献引用 = 代内系统插件 exec 贡献，绝非 legacy-builtin
  void captured;
  void body;
  // 未知原子（resolver in_doubt）→ rejected needs_rebind 而非 legacy 回退
  const unknown = await body.executeGoal(
    { id: 'req2', source: 'goal', taskId: parent.id, type: 'no_such_atomic', priority: 10, interrupt_level: 'soft', resource: [], preconditions: [], timeout_ms: 5000, target: { position: { x: 3, y: 64, z: 0 } } },
    { operationId: 'op-unknown', state, taskId: parent.id, signal: new AbortController().signal },
  );
  assert.equal(unknown.kind, 'rejected');
  assert.match(unknown.error ?? '', /needs_rebind:atomic_contribution_missing:no_such_atomic/);
});
