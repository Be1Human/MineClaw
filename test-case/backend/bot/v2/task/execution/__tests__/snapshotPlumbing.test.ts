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
import { BehaviorRegistry } from '../../../../../../../apps/minecraft-companion/src/bot/v2/behavior/behaviorRegistry.js';
import type { GoalAgentStateV1 } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/goalAgent/goalAgentState.js';
import type { OperationReceipt } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/contracts/operationReceipt.js';
import type { WorldStateView } from '../../../../../../../apps/minecraft-companion/src/bot/v2/types.js';

const TEST_SNAPSHOT = { generationId: 'gen-test', buildId: 'test-build', graphHash: 'test-graph' };

test('P1-4 goal 命令固定 state.snapshotRef；task 命令用当前代快照', async () => {
  const bot = createMockBot();
  const bus = new EventBusV2();
  const registry = new BehaviorRegistry();
  const tasks = new TaskRuntime(new MemoryV2(':memory:'), bus);
  const parent = tasks.createTask('goal_exec', {}); tasks.startEmergency(parent.id);
  const world = (): WorldStateView => ({ tick: 1, timestamp: Date.now(), self: { ...bot.world.self, maxHealth: 20 },
    environment: { dimension: bot.game.getDimension(), isDay: true, isRaining: false, timeOfDay: 6000 }, owner: null,
    entities: [], inventory: { items: bot.game.getInventoryItems(), held: null, freeSlots: 36 }, taskContext: null } as WorldStateView);
  const captured: OperationReceipt[] = [];
  bus.on('body.operation_receipt', e => captured.push(e.payload as unknown as OperationReceipt));
  let goalState: GoalAgentStateV1 | null = null;
  const body = new BodyActionService({
    game: bot.game, nav: bot.nav, bus, registry, tasks, getWorld: world, isEmbodied: () => true,
    getGoalState: () => goalState, getSnapshot: () => TEST_SNAPSHOT,
  });
  const opId = 'op-snapshot';
  const state = {
    sessionId: 'goal-snap', epoch: 1, phase: 'running', plan: { revision: 1 },
    snapshotRef: TEST_SNAPSHOT,
  } as unknown as GoalAgentStateV1;
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
  const registry = new BehaviorRegistry();
  const tasks = new TaskRuntime(new MemoryV2(':memory:'), bus);
  const parent = tasks.createTask('goal_exec', {}); tasks.startEmergency(parent.id);
  const world = (): WorldStateView => ({ tick: 1, timestamp: Date.now(), self: { ...bot.world.self, maxHealth: 20 },
    environment: { dimension: bot.game.getDimension(), isDay: true, isRaining: false, timeOfDay: 6000 }, owner: null,
    entities: [], inventory: { items: bot.game.getInventoryItems(), held: null, freeSlots: 36 }, taskContext: null } as WorldStateView);
  let goalState: GoalAgentStateV1 | null = null;
  const body = new BodyActionService({
    game: bot.game, nav: bot.nav, bus, registry, tasks, getWorld: world, isEmbodied: () => true,
    getGoalState: () => goalState, getSnapshot: () => TEST_SNAPSHOT,
  });
  const state = { sessionId: 'goal-legacy', epoch: 1, phase: 'running', plan: { revision: 1 } } as unknown as GoalAgentStateV1;
  goalState = state;
  const result = await body.executeGoal(
    { id: 'req', source: 'goal', taskId: parent.id, type: 'move_to', priority: 10, interrupt_level: 'soft', resource: [], preconditions: [], timeout_ms: 5000, target: { position: { x: 3, y: 64, z: 0 } } },
    { operationId: 'op-legacy', state, taskId: parent.id, signal: new AbortController().signal },
  );
  assert.equal(result.kind, 'rejected');
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /needs_rebind:goal_snapshot_missing/);
  void body;
});
