import assert from 'node:assert/strict';
import { test, afterEach } from 'node:test';
import { BodyExecutionRuntime, BodyAdmissionError } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/execution/bodyExecutionRuntime.js';
import { ExecutionAuthority } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/execution/executionAuthority.js';
import { __setTuningOverride } from '../../../../../../../apps/minecraft-companion/src/bot/v2/infra/tuning.js';
import type { ExecutionOwner, OperationCommand, OperationIntent } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/contracts/bodyOperation.js';
import type { ExecutionClock, ExecutionGrant } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/execution/ports/bodyExecution.js';
import type { BodyOperationDriver, ControlledExecutionContext, OperationOutcome } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/execution/ports/controlledExecution.js';

afterEach(() => __setTuningOverride(null));
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

class Clock implements ExecutionClock {
  time = 1000;
  private seq = 0;
  private timers = new Map<number, { at: number; callback(): void }>();
  now() { return this.time; }
  setTimeout(callback: () => void, ms: number) { const id = ++this.seq; this.timers.set(id, { at: this.time + ms, callback }); return id; }
  clearTimeout(id: unknown) { this.timers.delete(id as number); }
  get timerCount() { return this.timers.size; }
  advance(ms: number) {
    this.time += ms;
    for (const [id, timer] of [...this.timers]) if (timer.at <= this.time && this.timers.delete(id)) timer.callback();
  }
}

const owners: ExecutionOwner[] = [
  { kind: 'goal', taskId: 'task', sessionId: 'session', epoch: 1, planRevision: 2 },
  { kind: 'task', taskId: 'task', generation: 1 },
  { kind: 'safety', policyId: 'policy', generation: 1 },
];
const command = (id = 'move'): OperationCommand => ({ ref: { id, version: '1' }, args: { position: { x: 1, y: 64, z: 1 } } });
const intent = (id = 'op', patch: Partial<OperationIntent> = {}): OperationIntent => ({
  operationId: id, owner: owners[0], command: command(),
  scope: { dimension: 'overworld', targetRefs: ['plot'], bindings: [] },
  deadlineAt: 11000, budget: { maxActions: 20 }, priority: 10, preemption: 'none', ...patch,
});
const resources: Record<string, string[]> = { move: ['movement'], equip: ['inventory'], compose: ['movement', 'inventory'], observe: [] };

function fixture(bind: BodyOperationDriver['bind'] = () => ({ async run(context) { await context.effect(() => undefined); return { ok: true }; }, async stop() {} })) {
  const clock = new Clock(), authority = new ExecutionAuthority();
  let current = true, childAllowed = true, binds = 0;
  const driver: BodyOperationDriver = { resources: cmd => resources[cmd.ref.id], bind: (identity, cmd) => { binds++; return bind(identity, cmd); } };
  const runtime = new BodyExecutionRuntime({ driver, authority, clock });
  const authorize = (value: OperationIntent) => ({ intent: value, grant: authority.issue(value, { isCurrent: () => current, allowsChild: () => childAllowed }) });
  return { runtime, clock, authority, authorize, binds: () => binds, stale: () => { current = false; }, denyChildren: () => { childAllowed = false; } };
}

for (const owner of owners) test(`S07: ${owner.kind} owner receives immutable runtime identity and a real stop acknowledgement`, async () => {
  let seen!: ControlledExecutionContext;
  const f = fixture(() => ({ async run(ctx) { seen = ctx; await ctx.effect(() => undefined); return { ok: true }; }, async stop() {} }));
  const handle = f.runtime.submit(f.authorize(intent('op', { owner })));
  const result = await handle.result;
  assert.equal(result.status, 'succeeded'); assert.equal(result.schema, 'mineclaw.operation-receipt/v2');
  assert.deepEqual(result.owner, owner); assert.ok(result.leaseRef); assert.equal(result.generation, 1);
  assert.equal(result.stop?.state, 'quiesced'); assert.deepEqual(await handle.quiesced(), result.stop);
  assert.equal(result.noOp, false); assert.equal(f.runtime.inspect('op')?.state, 'settled');
  assert.equal(f.clock.timerCount, 0); assert.throws(() => seen.assertCurrent(), /operation_closed/);
  assert.ok(Object.isFrozen(result.owner)); assert.ok(Object.isFrozen(seen.command.args));
});

test('S07: forged grants and changes to owner, args, scope, budget, deadline or priority cannot start work', () => {
  const f = fixture(), original = intent(), request = f.authorize(original);
  assert.throws(() => f.runtime.submit({ intent: original, grant: {} as ExecutionGrant }), /operation_not_authorized/);
  for (const changed of [
    { ...original, owner: owners[1] }, { ...original, operationId: 'different' },
    { ...original, command: command('equip') }, { ...original, scope: { ...original.scope, targetRefs: ['other'] } },
    { ...original, budget: { maxActions: 999 } }, { ...original, deadlineAt: 22000 }, { ...original, priority: 100 },
  ]) assert.throws(() => f.runtime.submit({ ...request, intent: changed }), /operation_not_authorized/);
  assert.equal(f.binds(), 0); assert.equal(f.runtime.inspect('op'), null);
});

test('S07: identical intent reuses the handle; changed identity is rejected; same args with new ID execute again', async () => {
  const f = fixture(), first = f.authorize(intent());
  const one = f.runtime.submit(first);
  assert.equal(f.runtime.submit(first), one);
  await one.result;
  assert.equal(f.runtime.submit(first), one);
  const changed = f.authorize(intent('op', { command: command('equip') }));
  assert.throws(() => f.runtime.submit(changed), /operation_identity_conflict/);
  const two = f.runtime.submit(f.authorize(intent('op-2')));
  assert.equal((await two.result).status, 'succeeded'); assert.equal(f.binds(), 2);
  assert.notEqual((await one.result).leaseRef, (await two.result).leaseRef);
});

test('S07: cancellation before run starts fences the driver without leaking a lease', async () => {
  const f = fixture(), handle = f.runtime.submit(f.authorize(intent()));
  handle.cancel('owner_stop'); handle.cancel('duplicate');
  assert.equal((await handle.result).status, 'cancelled');
  assert.equal(f.binds(), 0); assert.equal(f.runtime.active().length, 0); assert.equal(f.clock.timerCount, 0);
});

test('S07: normal result waits for cleanup; cleanup timeout quarantines resources and never resolves quiesced early', async () => {
  const cleanup = deferred<void>();
  const f = fixture(() => ({ async run(ctx) { await ctx.effect(() => undefined); return { ok: true }; }, stop: () => cleanup.promise }));
  const handle = f.runtime.submit(f.authorize(intent()));
  let stopped = false, resulted = false;
  void handle.result.then(() => { resulted = true; }); void handle.quiesced().then(() => { stopped = true; });
  await flush(); assert.equal(resulted, false); assert.equal(stopped, false);
  f.clock.advance(2000); await flush();
  assert.equal((await handle.result).status, 'in_doubt'); assert.equal(stopped, false);
  assert.equal(f.runtime.inspect('op')?.state, 'quarantined');
  assert.throws(() => f.runtime.submit(f.authorize(intent('next'))), /body_resources_busy/);
  cleanup.resolve(); await handle.quiesced();
  assert.equal(f.runtime.inspect('op')?.state, 'settled'); assert.equal((await handle.result).status, 'in_doubt');
});

for (const interruptible of [true, false]) test(`S07 shared driver contract: ${interruptible ? 'interruptible' : 'draining'} work cannot be replaced before quiescence`, async () => {
  const native = deferred<void>(), cleanup = deferred<void>(); let old!: ControlledExecutionContext, stops = 0, effects = 0;
  const f = fixture((_identity, cmd) => ({
    async run(ctx) {
      if (ctx.operationId === 'op') { old = ctx; await ctx.effect(() => native.promise); }
      else await ctx.effect(() => { effects++; });
      return { ok: true };
    },
    async stop() { stops++; if (interruptible) native.resolve(); await cleanup.promise; },
  }));
  const one = f.runtime.submit(f.authorize(intent())); await flush();
  const next = f.authorize(intent('next', { priority: 100, preemption: 'request' }));
  assert.throws(() => f.runtime.submit(next), error => error instanceof BodyAdmissionError && error.conflicts[0] === 'op');
  await flush(); assert.equal(stops, 1); assert.equal(old.signal.aborted, true);
  assert.equal(f.runtime.inspect('op')?.state, 'cancelling');
  assert.throws(() => old.execute(command('move')), /preempted_by/);
  assert.throws(() => old.effect(() => { effects++; }), /preempted_by/);
  cleanup.resolve(); await flush();
  if (!interruptible) {
    assert.throws(() => f.runtime.submit(next), /body_resources_busy/);
    f.clock.advance(2000); assert.equal((await one.result).status, 'in_doubt');
    native.resolve();
  }
  await one.quiesced();
  const two = f.runtime.submit(next); assert.equal((await two.result).status, 'succeeded'); assert.equal(effects, 1);
  assert.throws(() => old.effect(() => { effects = 99; }), /preempted_by/); assert.equal(effects, 1);
});

test('S07: independent resources may run concurrently; equal-priority requests cannot interrupt', async () => {
  const pending = deferred<OperationOutcome>(); let cancels = 0;
  const f = fixture((_identity, cmd) => ({ run: () => cmd.ref.id === 'move' ? pending.promise : Promise.resolve({ ok: true }), async stop() { cancels++; } }));
  const one = f.runtime.submit(f.authorize(intent())); await flush();
  assert.throws(() => f.runtime.submit(f.authorize(intent('blocked', { preemption: 'request' }))), /body_resources_busy/);
  assert.equal(cancels, 0);
  const equipment = f.runtime.submit(f.authorize(intent('equip', { command: command('equip') })));
  assert.equal((await equipment.result).status, 'succeeded');
  assert.equal(f.runtime.inspect('op')?.state, 'running');
  pending.resolve({ ok: true }); await one.quiesced();
});

test('S07: child steps share identity, scope and budget; cleanup finishes before the next child starts', async () => {
  const contexts: ControlledExecutionContext[] = [], order: string[] = [];
  const cleanup = deferred<void>();
  const f = fixture((_identity, cmd) => ({
    async run(ctx) {
      contexts.push(ctx); order.push('run:' + cmd.ref.id);
      if (cmd.ref.id === 'compose') { await ctx.execute(command('move')); await ctx.execute(command('equip')); }
      else await ctx.effect(() => undefined);
      return { ok: true };
    },
    async stop() { if (cmd.ref.id === 'move') await cleanup.promise; order.push('stop:' + cmd.ref.id); },
  }));
  const handle = f.runtime.submit(f.authorize(intent('op', { command: command('compose') })));
  await flush(); assert.equal(contexts.length, 2);
  cleanup.resolve(); assert.equal((await handle.result).status, 'succeeded');
  assert.deepEqual(order, ['run:compose', 'run:move', 'stop:move', 'run:equip', 'stop:equip', 'stop:compose']);
  assert.equal(f.runtime.inspect('op')?.actionsStarted, 3);
  for (const ctx of contexts) { assert.equal(ctx.leaseRef, contexts[0].leaseRef); assert.equal(ctx.signal, contexts[0].signal); assert.equal(ctx.scope, contexts[0].scope); }
  assert.equal(new Set(contexts.map(ctx => ctx.stepId)).size, 3);
});

test('S07: child authorization cannot widen resources or escape revocation after an await', async () => {
  for (const mode of ['resource', 'permission', 'stale'] as const) {
    const gate = deferred<void>();
    const f = fixture(() => ({ async run(ctx) { await gate.promise; return ctx.execute(command('equip')); }, async stop() {} }));
    const handle = f.runtime.submit(f.authorize(intent('op', { command: command(mode === 'resource' ? 'move' : 'compose') })));
    await flush();
    if (mode === 'permission') f.denyChildren(); if (mode === 'stale') f.stale();
    gate.resolve(); assert.equal((await handle.result).status, 'cancelled');
    assert.equal(f.binds(), 1); await handle.quiesced();
  }
});

test('S07: hot budget applies cumulatively to children, rather than resetting per step', async () => {
  const f = fixture((_identity, cmd) => ({ async run(ctx) {
    if (cmd.ref.id === 'compose') {
      await ctx.execute(command('move'));
      __setTuningOverride({ controlledExecution: { maxSubActions: 2 } });
      await ctx.execute(command('equip'));
    }
    return { ok: true };
  }, async stop() {} }));
  const handle = f.runtime.submit(f.authorize(intent('op', { command: command('compose') })));
  const result = await handle.result;
  assert.equal(result.status, 'cancelled'); assert.equal(result.failure?.code, 'action_budget_exceeded');
  assert.equal(f.binds(), 2); assert.equal(f.runtime.inspect('op')?.actionsStarted, 2);
});

test('S07: deadline interrupts waiting and never allows the next effect; timers are removed', async () => {
  let effects = 0;
  const f = fixture(() => ({ async run(ctx) { await ctx.wait(5000); await ctx.effect(() => { effects++; }); return { ok: true }; }, async stop() {} }));
  const handle = f.runtime.submit(f.authorize(intent('op', { deadlineAt: 1100 })));
  await flush(); f.clock.advance(100);
  const result = await handle.result;
  assert.equal(result.status, 'cancelled'); assert.equal(result.failure?.code, 'deadline_exceeded');
  assert.equal(effects, 0); assert.equal(f.clock.timerCount, 0);
});

test('S07: run failures can quiesce, but stop failures keep the body quarantined', async () => {
  const failed = fixture(() => ({ async run() { throw new Error('run_failure'); }, async stop() {} }));
  const one = failed.runtime.submit(failed.authorize(intent()));
  assert.equal((await one.result).status, 'failed'); await one.quiesced();
  const unsafe = fixture(() => ({ async run() { return { ok: true }; }, async stop() { throw new Error('cleanup_failure'); } }));
  const two = unsafe.runtime.submit(unsafe.authorize(intent()));
  assert.equal((await two.result).status, 'in_doubt');
  assert.equal(unsafe.runtime.inspect('op')?.state, 'quarantined');
  assert.match(unsafe.runtime.inspect('op')!.stopErrors[0], /cleanup_failure/);
  assert.throws(() => unsafe.runtime.submit(unsafe.authorize(intent('next'))), /body_resources_busy/);
});

test('S07: cancelOwner closes only that incarnation and returns in_doubt without inventing a stop', async () => {
  const pending = deferred<OperationOutcome>();
  const f = fixture(() => ({ run: () => pending.promise, async stop() {} }));
  const owner = owners[1], handle = f.runtime.submit(f.authorize(intent('op', { owner })));
  await flush(); const closing = f.runtime.cancelOwner(owner, 'owner_cancel');
  assert.throws(() => f.runtime.submit(f.authorize(intent('old', { owner }))), /operation_not_authorized/);
  f.clock.advance(2000); const report = await closing;
  assert.equal(report.status, 'in_doubt'); assert.equal(report.operations[0].stop, null);
  pending.resolve({ ok: true }); await handle.quiesced();
  const nextOwner: ExecutionOwner = { kind: 'task', taskId: 'task', generation: 2 };
  assert.equal((await f.runtime.submit(f.authorize(intent('new', { owner: nextOwner }))).result).status, 'succeeded');
});

test('S07: cancellation preserves observed effects and does not turn an empty result into world success', async () => {
  const gate = deferred<void>();
  const f = fixture(() => ({ async run(ctx) {
    await ctx.effect(() => undefined);
    ctx.recordEffect({ predicate: { id: 'test.crop', version: '1', args: { x: 1 } }, evidenceRefs: ['world:crop:one'] });
    await gate.promise; return { ok: true };
  }, async stop() {} }));
  const handle = f.runtime.submit(f.authorize(intent())); await flush(); handle.cancel('stop'); gate.resolve();
  const result = await handle.result;
  assert.equal(result.status, 'cancelled'); assert.equal(result.effects.length, 1); assert.equal(result.noOp, false);
  assert.deepEqual(result.evidenceRefs, ['world:crop:one']); assert.ok(Object.isFrozen(result.effects[0].predicate.args));
  const empty = fixture(() => ({ async run() { return { ok: true }; }, async stop() {} }));
  const noop = await empty.runtime.submit(empty.authorize(intent())).result;
  assert.equal(noop.noOp, true); assert.deepEqual(noop.effects, []);
});

test('S07: returning before a launched child finishes is a contract failure, not success', async () => {
  const pending = deferred<void>();
  const f = fixture((_identity, cmd) => ({ async run(ctx) {
    if (cmd.ref.id === 'compose') { void ctx.execute(command('move')); return { ok: true }; }
    await pending.promise; return { ok: true };
  }, async stop() {} }));
  const handle = f.runtime.submit(f.authorize(intent('op', { command: command('compose') })));
  await flush(); pending.resolve(); const result = await handle.result;
  assert.equal(result.status, 'cancelled'); assert.equal(result.failure?.code, 'unjoined_work');
});

test('S07: a child cleanup error stops every bound executor even if the parent is still waiting', async () => {
  const parent = deferred<void>(); let parentStops = 0;
  const f = fixture((_identity, cmd) => ({ async run(ctx) {
    if (cmd.ref.id === 'compose') { void ctx.execute(command('move')); await parent.promise; }
    return { ok: true };
  }, async stop() {
    if (cmd.ref.id === 'move') throw new Error('broken_child_cleanup');
    parentStops++; parent.resolve();
  } }));
  const handle = f.runtime.submit(f.authorize(intent('op', { command: command('compose') })));
  assert.equal((await handle.result).status, 'in_doubt'); await flush();
  assert.equal(parentStops, 1);
});

test('S07: forgotten native effect remains owned after stop returns, and its late completion cannot report success', async () => {
  const native = deferred<void>(); let effects = 0;
  const f = fixture(() => ({ async run(ctx) { void ctx.effect(async () => { effects++; await native.promise; }); return { ok: true }; }, async stop() {} }));
  const handle = f.runtime.submit(f.authorize(intent())); await flush();
  assert.equal(effects, 1); assert.equal(f.runtime.inspect('op')?.state, 'cancelling');
  assert.throws(() => f.runtime.submit(f.authorize(intent('next'))), /body_resources_busy/);
  f.clock.advance(2000); assert.equal((await handle.result).status, 'in_doubt');
  native.resolve(); await handle.quiesced();
  assert.equal((await handle.result).failure?.code, 'unjoined_work');
});

test('S07: malformed owner, missing scope, expired deadline and incomplete assembly fail before side effects', () => {
  const f = fixture();
  for (const value of [intent('op', { owner: { kind: 'task', taskId: 'task', generation: 0 } }),
    intent('op', { budget: { maxActions: 0 } }), intent('op', { deadlineAt: 999 }),
    intent('op', { scope: null as unknown as OperationIntent['scope'] })]) {
    assert.throws(() => f.runtime.submit(f.authorize(value)), /invalid_operation_intent|deadline_exceeded/);
  }
  assert.throws(() => new BodyExecutionRuntime({ driver: {} as BodyOperationDriver, authority: f.authority }), /ports_required/);
  assert.equal(f.binds(), 0); assert.equal(f.runtime.active().length, 0);
});
