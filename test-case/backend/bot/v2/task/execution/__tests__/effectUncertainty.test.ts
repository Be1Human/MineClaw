import assert from 'node:assert/strict';
import { test, afterEach } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BodyActionService } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/execution/bodyActionService.js';
import { BodyExecutionRuntime } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/execution/bodyExecutionRuntime.js';
import { ExecutionAuthority } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/execution/executionAuthority.js';
import { OperationLedger } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/execution/operationLedger.js';
import { EventBusV2 } from '../../../../../../../apps/minecraft-companion/src/bot/v2/infra/eventBus.js';
import { __setTuningOverride } from '../../../../../../../apps/minecraft-companion/src/bot/v2/infra/tuning.js';
import { effectUnknown } from '../../../../../../../apps/minecraft-companion/src/bot/v2/plugin-sdk/contracts/executionResult.js';
import { createSystemAtomicExecutor } from '../../../../../../../apps/minecraft-companion/src/bot/v2/plugins/builtin/minecraft-system/index.js';
import { buildSystemAtomicContracts } from '../../../../../../../apps/minecraft-companion/src/bot/v2/plugins/builtin/minecraft-system/atomicContracts.js';
import { resolvePlacement } from '../../../../../../../apps/minecraft-companion/src/bot/v2/atomic/verifiers.js';
import type { ActionRequest, WorldStateView } from '../../../../../../../apps/minecraft-companion/src/bot/v2/types.js';
import type { RawBlock } from '../../../../../../../apps/minecraft-companion/src/bot/adapter/types.js';
import type { OperationIntent } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/contracts/bodyOperation.js';
import type { BodyOperationDriver } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/execution/ports/controlledExecution.js';
import { createMockBot } from '../../../__tests__/mocks/index.js';

const ledgers: OperationLedger[] = [];
afterEach(() => { __setTuningOverride(null); for (const ledger of ledgers.splice(0)) ledger.close(); });
const position = { x: 1, y: 64, z: 2 };
const block = (name: string, boundingBox: 'block' | 'empty' = 'block'): RawBlock => ({ name, position, boundingBox });
const snapshot = { generationId: 'gen-f20', buildId: 'build-f20', graphHash: 'graph-f20' };
const contribution = { pluginId: 'mineclaw.minecraft-system', pluginVersion: '1.0.0', contributionId: 'mineclaw.minecraft-system.execution.atomics', contributionVersion: '2.0.0' };
function fixture(before: RawBlock | null, after: RawBlock | null) {
  __setTuningOverride({ atomic: { verifyTimeoutMs: 8, verifyPollMs: 1 } });
  const bot = createMockBot(), bus = new EventBusV2(), ledger = new OperationLedger(':memory:'); ledgers.push(ledger);
  let current = before, calls = 0;
  bot.game.getBlockAt = () => current;
  bot.game.dig = async () => { calls++; current = after; };
  const events: string[] = [];
  for (const name of ['atomic.dig.start', 'atomic.dig.dispatched', 'atomic.dig.success', 'atomic.dig.fail', 'atomic.dig.dispatch_error', 'atomic.unverified']) bus.on(name, () => events.push(name));
  const world = (): WorldStateView => ({ timestamp: Date.now(), tick: 1, self: { ...bot.world.self, maxHealth: 20 },
    environment: { dimension: bot.game.getDimension(), isDay: true, isRaining: false, timeOfDay: 6000 }, owner: null,
    entities: [], inventory: { items: [], held: null, freeSlots: 36 }, taskContext: null } as WorldStateView);
  const resolver = { resolve: (_s: unknown, id: string) => ({ status: 'resolved' as const, value: {
    executor: createSystemAtomicExecutor(id, { game: bot.game, nav: bot.nav, bus, getWorld: world }),
    contract: buildSystemAtomicContracts([id])[0]!, contribution,
  } }) };
  const body = new BodyActionService({ game: bot.game, nav: bot.nav, bus, getWorld: world,
    tasks: { list: () => [{ id: 'task', state: 'running' }], isRunning: () => true } as never,
    isEmbodied: () => true, getGoalState: () => null, getSnapshot: () => snapshot,
    atomicResolver: resolver, behaviorResolver: { resolve: () => ({ status: 'in_doubt', reason: 'none' }) } as never,
    hostApiVersion: '2.0.0', ledger });
  const request = (): ActionRequest => ({ id: 'dig', taskId: 'task', source: 'contract-test', type: 'dig', priority: 10,
    interrupt_level: 'soft', resource: [], preconditions: [], timeout_ms: 1000, target: { position } });
  return { body, ledger, bot, bus, resolver, request, events, calls: () => calls, set: (value: RawBlock | null) => { current = value; } };
}

for (const before of [null, block('air', 'empty')]) test(`F20 AU01/04 AI01: ${before?.name ?? 'null'} preflight never dispatches or succeeds`, async () => {
  const f = fixture(before, block('air', 'empty')), result = await f.body.executeTask(f.request());
  assert.equal(result.ok, false); assert.equal(result.receipt?.status, 'failed'); assert.equal(result.receipt?.noOp, true);
  assert.equal(f.calls(), 0); assert.equal(f.events.includes('atomic.dig.success'), false);
});
for (const name of ['stone', 'short_grass']) test(`F20 AU02: known ${name} to air confirms only local block change, without inventory`, async () => {
  const f = fixture(block(name, name === 'short_grass' ? 'empty' : 'block'), block('air', 'empty'));
  const result = await f.body.executeTask(f.request());
  assert.equal(result.receipt?.status, 'succeeded'); assert.equal(f.calls(), 1);
  assert.deepEqual(f.events, ['atomic.dig.start', 'atomic.dig.dispatched', 'atomic.dig.success']);
  assert.equal(result.receipt?.details?.collection, 'unknown'); assert.equal(result.receipt?.details?.causality, 'unproven');
  assert.deepEqual(f.bot.game.getInventoryItems(), []);
});
for (const after of [null, block('stone')]) test(`F20 AU03/05/10 AI01: after=${after?.name ?? 'null'} remains in_doubt after real cleanup`, async () => {
  const f = fixture(block('stone'), after), result = await f.body.executeTask(f.request());
  assert.equal(result.receipt?.status, 'in_doubt'); assert.equal(result.receipt?.failure?.retryable, false);
  assert.equal(result.receipt?.stop?.state, 'quiesced'); assert.equal(f.body.busy(), false); assert.equal(f.calls(), 1);
  assert.equal(f.events.includes('atomic.dig.success'), false); assert.equal(result.receipt?.noOp, false);
  assert.deepEqual(f.ledger.get(result.receipt!.operationId)?.inDoubtReceipt, result.receipt);
  assert.equal((await f.body.executeTask(f.request())).ok, false); assert.equal(f.calls(), 1);
  f.bus.publish('task.resumed', 'info', { taskId: 'task' });
  assert.match((await f.body.executeTask(f.request())).error!, /operation_reconciliation_required/); assert.equal(f.calls(), 1);
});
test('F20 AU06: required verification cannot be disabled by runtime tuning', async () => {
  const f = fixture(block('stone'), null);
  __setTuningOverride({ atomic: { verifyEnabled: false, verifyMode: { dig: 'off' }, verifyTimeoutMs: 0 } });
  assert.equal((await f.body.executeTask(f.request())).receipt?.status, 'in_doubt'); assert.equal(f.calls(), 1);
});
test('F20 AU07: placement never chooses an unknown cell as air', () => {
  const f = fixture(null, null); assert.equal(resolvePlacement(f.bot.game, position), null);
});
test('F20 AU05: a device exception after dispatch is not a retryable ordinary failure', async () => {
  const f = fixture(block('stone'), null); f.bot.game.dig = async () => { throw new Error('native_result_lost'); };
  const result = await f.body.executeTask(f.request());
  assert.equal(result.receipt?.status, 'in_doubt'); assert.equal(result.receipt?.failure?.retryable, false);
  assert.match(result.receipt?.failure?.detail!, /native_result_lost/);
  assert.equal(f.events.includes('atomic.dig.fail'), false);
  assert.equal(f.events.includes('atomic.dig.dispatch_error'), true);
});
test('F20 AU11: a JavaScript ok-only executor cannot default to success', async () => {
  const f = fixture(block('stone'), null);
  f.resolver.resolve = () => ({ status: 'resolved', value: { executor: { id: 'bad', version: '2.0.0', execute: async () => ({ ok: true }) } as never,
    contract: buildSystemAtomicContracts(['dig'])[0]!, contribution } });
  const result = await f.body.executeTask(f.request());
  assert.equal(result.receipt?.status, 'in_doubt'); assert.equal(result.receipt?.failure?.code, 'execution.effect_unknown');
});

function intent(id: string): OperationIntent {
  return { operationId: id, owner: { kind: 'task', taskId: 'task', ownerEpoch: 1 },
    command: { ref: { id: 'root', contribution }, snapshot, args: {} },
    expectedEffects: [], scope: { dimension: 'overworld', targetRefs: [], bindings: [] },
    deadlineAt: Date.now() + 10000, budget: { maxActions: 10 }, priority: 1, preemption: 'none' };
}
for (const swallow of [true, false]) test(`F20 AU09/15: unknown child cannot be ${swallow ? 'swallowed' : 'retried'} by parent`, async () => {
  const ledger = new OperationLedger(':memory:'); ledgers.push(ledger); const authority = new ExecutionAuthority(); let writes = 0;
  const driver: BodyOperationDriver = { resources: () => ['body'], bind: (_i, cmd) => ({
    run: async ctx => {
      if (cmd.ref.id === 'root') {
        const child = await ctx.execute({ ...cmd, ref: { ...cmd.ref, id: 'child' } });
        if (!swallow) await ctx.effect(() => { writes++; });
        return { status: 'succeeded' };
      }
      await ctx.effect(() => { writes++; });
      ctx.recordEffect({ predicate: { id: 'partial', version: '1.0.0', args: {} }, evidenceRefs: ['fixture:partial'] });
      return { status: 'in_doubt', failure: effectUnknown('child unknown'), details: { child: true } };
    }, stop: async () => undefined,
  }) };
  const runtime = new BodyExecutionRuntime({ ledger, authority, driver }), operation = intent('nested');
  const handle = runtime.submit({ intent: operation, grant: authority.issue(operation, { isCurrent: () => true, allowsChild: () => true }) });
  const result = await handle.result; assert.equal(result.status, 'in_doubt'); assert.equal(writes, 1);
  assert.equal(result.effects.length, 1); assert.deepEqual(result.evidenceRefs, ['fixture:partial']);
  assert.equal((await handle.quiesced()).state, 'quiesced');
});
for (const ownerKind of ['task', 'goal'] as const) test(`F20 AU12–14: ${ownerKind} unknown survives restart; new ID/epoch is fenced until reconciliation`, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'f20-')); const file = join(dir, 'ledger.db');
  const authority = new ExecutionAuthority();
  const op: OperationIntent = { ...intent('persisted'), owner: ownerKind === 'goal'
    ? { kind: 'goal', taskId: 'task', sessionId: 'goal', epoch: 1, planRevision: 1 }
    : { kind: 'task', taskId: 'task', ownerEpoch: 1 } };
  let binds = 0;
  const driver: BodyOperationDriver = { resources: () => ['body'], bind: () => { binds++; return {
    run: async ctx => { await ctx.effect(() => undefined); return { status: 'in_doubt', failure: effectUnknown('after unknown'), details: { after: null } }; }, stop: async () => undefined,
  }; } };
  let ledger = new OperationLedger(file);
  try {
    const runtime = new BodyExecutionRuntime({ ledger, authority, driver });
    const grant = authority.issue(op, { isCurrent: () => true, allowsChild: () => true });
    const original = await runtime.submit({ intent: op, grant }).result; ledger.close(); ledger = new OperationLedger(file);
    const restored = new BodyExecutionRuntime({ ledger, authority, driver });
    assert.deepEqual(await restored.submit({ intent: op, grant }).result, original); assert.equal(binds, 1);
    const next: OperationIntent = { ...intent('fresh-id'), owner: ownerKind === 'goal'
      ? { kind: 'goal', taskId: 'other-plan-task', sessionId: 'goal', epoch: 2, planRevision: 2 }
      : { kind: 'task', taskId: 'task', ownerEpoch: 2 } };
    const authorized = { intent: next, grant: authority.issue(next, { isCurrent: () => true, allowsChild: () => true }) };
    assert.throws(() => restored.submit(authorized), /operation_reconciliation_required/);
    ledger.reconcile(op.operationId, { status: 'unknown', evidenceRefs: ['fixture:readback'], reason: 'still unknown', at: Date.now() });
    assert.throws(() => restored.submit(authorized), /operation_reconciliation_required/);
    assert.throws(() => ledger.reconcile(op.operationId, { status: 'not_started', evidenceRefs: ['fixture:readback'], reason: 'empty is insufficient', at: Date.now() }), /conflicts_with_effect_evidence/);
    ledger.reconcile(op.operationId, { status: 'completed', effects: [], evidenceRefs: ['fixture:independent-proof'], reason: 'verified', at: Date.now() });
    assert.deepEqual(ledger.get(op.operationId)?.inDoubtReceipt, original);
    assert.equal((await restored.submit(authorized).result).status, 'in_doubt'); assert.equal(binds, 2);
  } finally { ledger.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('F20 AU08: delayed readback may pass without a second dig', async () => {
  const f = fixture(block('stone'), block('air', 'empty')); let readsAfter = 0;
  f.bot.game.getBlockAt = () => f.calls() === 0 ? block('stone') : ++readsAfter === 1 ? null : block('air', 'empty');
  assert.equal((await f.body.executeTask(f.request())).receipt?.status, 'succeeded');
  assert.equal(f.calls(), 1); assert.equal(readsAfter, 2);
});
test('F20 AU15: cancellation during native dig retains uncertainty and true stop separately', async () => {
  const f = fixture(block('stone'), null); let release!: () => void;
  const native = new Promise<void>(resolve => { release = resolve; });
  f.bot.game.dig = async () => { await native; };
  const result = f.body.executeTask(f.request()); await new Promise<void>(resolve => setImmediate(resolve));
  const owner = f.body.runtime.active()[0]!.owner;
  const cancelling = f.body.runtime.cancelOwner(owner, 'stop-during-dig'); release();
  const receipt = (await result).receipt!;
  assert.equal(receipt.status, 'in_doubt'); assert.equal(receipt.noOp, false);
  assert.equal(receipt.stop?.state, 'quiesced'); assert.equal(receipt.details?.cancelReason, 'stop-during-dig');
  assert.equal((await cancelling).status, 'quiesced'); assert.equal(f.events.includes('atomic.dig.success'), false);
});
test('F20 AU10: cleanup timeout retains original unknown receipt when the device stops late', async () => {
  const f = fixture(block('stone'), null); let release!: () => void;
  const cleanup = new Promise<void>(resolve => { release = resolve; });
  __setTuningOverride({ atomic: { verifyTimeoutMs: 0 }, controlledExecution: { stopConfirmTimeoutMs: 5 } });
  const bind = f.bot.game.bind.bind(f.bot.game);
  f.bot.game.bind = scope => { const bound = bind(scope); return { ...bound, stop: async reason => { await cleanup; await bound.stop(reason); } }; };
  const work = f.body.executeTask(f.request()); const receipt = (await work).receipt!;
  assert.equal(receipt.status, 'in_doubt'); assert.equal(receipt.stop, null); assert.equal(f.body.busy(), true);
  release(); await new Promise<void>(resolve => setImmediate(resolve)); await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(f.body.busy(), false); assert.equal(receipt.stop, null);
  assert.equal(f.ledger.get(receipt.operationId)?.stop?.state, 'quiesced');
  assert.deepEqual(f.ledger.get(receipt.operationId)?.inDoubtReceipt, receipt);
});
test('F20 AI02: Activity cannot discard in_doubt and complete after swallowing child failure', async () => {
  const { ActivityRunner } = await import('../../../../../../../apps/minecraft-companion/src/bot/v2/task/execution/activityRunner.js');
  const { TaskRuntime } = await import('../../../../../../../apps/minecraft-companion/src/bot/v2/task/taskRuntime.js');
  const { MemoryV2 } = await import('../../../../../../../apps/minecraft-companion/src/bot/v2/infra/memory.js');
  const f = fixture(block('stone'), null), memory = new MemoryV2(':memory:');
  const tasks = new TaskRuntime(memory, f.bus); const seen: Readonly<Record<string, unknown>>[] = [];
  let done!: () => void; const finished = new Promise<void>(resolve => { done = resolve; });
  const runner = new ActivityRunner({ tasks, body: f.body, bus: f.bus, hostApiVersion: '2.0.0', getHostConfig: () => ({}),
    getWorld: () => ({ timestamp: Date.now(), tick: 1, self: { ...f.bot.world.self, maxHealth: 20 }, environment: { dimension: 'overworld', isDay: true, isRaining: false, timeOfDay: 1 },
      owner: null, entities: [], inventory: { items: [], held: null, freeSlots: 36 }, taskContext: null } as WorldStateView),
    activities: { resolve: () => ({ status: 'resolved', value: { contribution, factory: { id: 'uncertain', version: '1.0.0', create: () => ({
      instanceId: 'uncertain', contribution, settled: false,
      run: async (ctx: import('../../../../../../../apps/minecraft-companion/src/bot/v2/plugin-sdk/contracts/execution.js').PluginActivityContext) => { seen.push(await ctx.submitBody({ atomicId: 'dig', args: { position } }));
        seen.push(await ctx.submitBody({ atomicId: 'dig', args: { position } })); done(); return { ok: true, cancelled: false }; },
      halt: async () => undefined, close: async () => undefined,
    }) } } }) } as never,
  });
  try {
    const entry = runner.start({ snapshot, contribution, params: {}, label: 'uncertain', priority: 1 });
    await finished; await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(seen[0]!.status, 'in_doubt'); assert.equal((seen[0]!.receipt as { status: string }).status, 'in_doubt');
    assert.equal(seen[1]!.ok, false); assert.equal(f.calls(), 1);
    assert.equal(runner.inspect(entry.taskId)?.state, 'failed');
    assert.equal(runner.inspect(entry.taskId)?.error, 'operation_reconciliation_required');
  } finally { await runner.close(); memory.close(); }
});

test('F20 AU15: cancellation after known block change retains local readback in cancelled receipt', async () => {
  const f = fixture(block('stone'), block('air', 'empty')); let stopped: Promise<unknown> | undefined;
  f.bus.on('atomic.dig.success', () => { stopped = f.body.runtime.cancelOwner(f.body.runtime.active()[0]!.owner, 'after-readback'); });
  const receipt = (await f.body.executeTask(f.request())).receipt!;
  assert.equal(receipt.status, 'cancelled'); assert.equal(receipt.noOp, false);
  assert.equal(receipt.details?.kind, 'local_readback'); assert.equal(receipt.details?.cancelReason, 'after-readback');
  assert.equal((receipt.details?.after as { block: { name: string } }).block.name, 'air');
  assert.equal(receipt.stop?.state, 'quiesced'); await stopped;
});
test('F20 AU13: pre-F20 table migrates transactionally without inventing an unknown receipt', async () => {
  const { openSqliteDatabase } = await import('../../../../../../../apps/minecraft-companion/src/bot/v2/infra/sqliteDatabase.js');
  const dir = mkdtempSync(join(tmpdir(), 'f20-old-schema-')), file = join(dir, 'operations.db');
  try {
    let ledger = new OperationLedger(file); const op = intent('old-row');
    const identity = { operationId: op.operationId, owner: op.owner, operationEpoch: 1, leaseRef: 'old:1', deadlineAt: op.deadlineAt };
    ledger.begin({ intent: op, identity, grantHash: 'old-grant', startedAt: Date.now() }); ledger.close();
    const db = openSqliteDatabase(file); db.exec('ALTER TABLE operation_ledger DROP COLUMN in_doubt_receipt_json'); db.close();
    ledger = new OperationLedger(file);
    try {
      assert.equal(ledger.get(op.operationId)?.inDoubtReceipt, null);
      assert.equal(ledger.begin({ intent: op, identity, grantHash: 'old-grant', startedAt: Date.now() }).status, 'in_doubt');
      assert.equal(ledger.get(op.operationId)?.inDoubtReceipt, null);
    } finally { ledger.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
