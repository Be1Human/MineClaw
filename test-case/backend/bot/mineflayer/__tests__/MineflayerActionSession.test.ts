import assert from 'node:assert/strict';
import { test, afterEach } from 'node:test';
import type { Bot } from 'mineflayer';
import { MineflayerGameAdapter } from '../../../../../apps/minecraft-companion/src/bot/mineflayer/MineflayerGameAdapter.js';
import { SwitchableGameAdapter } from '../../../../../apps/minecraft-companion/src/bot/adapter/SwitchableGameAdapter.js';
import { NullGameAdapter } from '../../../../../apps/minecraft-companion/src/bot/adapter/NullGameAdapter.js';
import { BodyExecutionRuntime } from '../../../../../apps/minecraft-companion/src/bot/v2/task/execution/bodyExecutionRuntime.js';
import { ExecutionAuthority } from '../../../../../apps/minecraft-companion/src/bot/v2/task/execution/executionAuthority.js';
import { __setTuningOverride } from '../../../../../apps/minecraft-companion/src/bot/v2/infra/tuning.js';
import type { BoundGameActions, GameActions } from '../../../../../apps/minecraft-companion/src/bot/adapter/GameActions.js';
import type { GameAdapter } from '../../../../../apps/minecraft-companion/src/bot/adapter/GameAdapter.js';
import type { OperationIntent } from '../../../../../apps/minecraft-companion/src/bot/v2/task/contracts/bodyOperation.js';

afterEach(() => __setTuningOverride(null));
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const position = { x: 1, y: 64, z: 1 };
function fakeBot(overrides: Record<string, unknown> = {}): Bot {
  return {
    username: 'fixture', entity: { position, velocity: { x: 0, y: 0, z: 0 } },
    registry: { itemsByName: { stone: { id: 1 } } },
    inventory: { items: () => [{ name: 'stone', type: 1, count: 1 }] },
    blockAt: () => ({ name: 'stone', position }),
    lookAt: async () => {}, equip: async () => {}, clearControlStates() {},
    setControlState() {}, stopDigging() {}, deactivateItem() {},
    ...overrides,
  } as unknown as Bot;
}
function fixture(game: GameAdapter, run: (actions: GameActions) => Promise<void>) {
  const authority = new ExecutionAuthority();
  let session!: BoundGameActions;
  const runtime = new BodyExecutionRuntime({ authority, driver: {
    resources: () => ['body'],
    bind: () => {
      let bound: BoundGameActions | null = null;
      return {
        async run(ctx) { bound = session = game.bind(ctx); await run(bound.actions); return { ok: true }; },
        async stop(reason) { if (bound) await bound.stop(reason); },
      };
    },
  } });
  const start = (id = 'op') => {
    const intent: OperationIntent = { operationId: id, owner: { kind: 'task', taskId: 'task', generation: 1 },
      command: { ref: { id: 'fixture', version: '1' }, args: {} },
      scope: { dimension: 'overworld', targetRefs: [], bindings: [] },
      deadlineAt: Date.now() + 60_000, budget: { maxActions: 5 }, priority: 1, preemption: 'none' };
    return runtime.submit({ intent, grant: authority.issue(intent, { isCurrent: () => true, allowsChild: () => false }) });
  };
  return { runtime, start, session: () => session };
}

test('device cancellation during lookAt cannot continue into block interaction', async () => {
  const look = deferred<void>(); let interactions = 0;
  const bot = fakeBot({ lookAt: () => look.promise, activateBlock: async () => { interactions++; } });
  const f = fixture(new MineflayerGameAdapter(() => bot), actions => actions.interactBlock(position));
  const handle = f.start(); await flush(); handle.cancel('owner_stop'); await flush();
  assert.equal(f.runtime.inspect('op')?.state, 'cancelling');
  assert.throws(() => f.start('next'), /body_resources_busy/);
  look.resolve(); assert.equal((await handle.result).status, 'cancelled');
  assert.equal(interactions, 0); assert.equal((await handle.quiesced()).state, 'quiesced');
});

test('stopDigging requests interruption but cannot acknowledge an unresolved native dig', async () => {
  const digging = deferred<void>(); let stops = 0;
  const bot = fakeBot({ dig: () => digging.promise, stopDigging: () => { stops++; } });
  const f = fixture(new MineflayerGameAdapter(() => bot), actions => actions.dig(position));
  const handle = f.start(); await flush(); handle.cancel('owner_stop'); await flush();
  assert.equal(stops, 1); assert.equal(f.runtime.inspect('op')?.stop, null);
  digging.reject(new Error('Digging aborted'));
  assert.equal((await handle.result).status, 'cancelled'); assert.ok(await handle.quiesced());
});

test('native equip drains before the resource is released, and closed sessions cannot be reused', async () => {
  const equip = deferred<void>(); let calls = 0;
  const bot = fakeBot({ equip: () => { calls++; return equip.promise; } });
  const f = fixture(new MineflayerGameAdapter(() => bot), actions => actions.equip('stone'));
  const handle = f.start(); await flush(); handle.cancel('owner_stop'); await flush();
  assert.equal(f.runtime.active().length, 1); assert.equal(calls, 1);
  equip.resolve(); await handle.quiesced(); assert.equal(f.runtime.active().length, 0);
  assert.throws(() => f.session().actions.equip('stone'), /owner_stop|operation_closed/);
  assert.equal(calls, 1);
});

test('toss cancellation between inventory stacks never dispatches the second stack', async () => {
  const first = deferred<void>(); let calls = 0;
  const bot = fakeBot({
    inventory: { items: () => [{ name: 'stone', type: 1, count: 1 }, { name: 'stone', type: 1, count: 1 }] },
    toss: () => { calls++; return first.promise; },
  });
  const f = fixture(new MineflayerGameAdapter(() => bot), async actions => { await actions.toss('stone', 2); });
  const handle = f.start(); await flush(); handle.cancel('owner_stop'); first.resolve();
  const receipt = await handle.result; assert.equal(receipt.status, 'cancelled');
  assert.equal(receipt.noOp, false); assert.equal(calls, 1);
});

test('a container opening after cancellation is closed without transferring inventory', async () => {
  const opening = deferred<any>(); let transfers = 0, closes = 0;
  const container = { deposit: async () => { transfers++; }, containerItems: () => [], close: () => { closes++; } };
  const bot = fakeBot({ openContainer: () => opening.promise });
  const f = fixture(new MineflayerGameAdapter(() => bot), async actions => { await actions.depositToChest(position, 'stone', 1); });
  const handle = f.start(); await flush(); handle.cancel('owner_stop'); await flush();
  assert.equal(f.runtime.inspect('op')?.stop, null); assert.equal(closes, 0);
  opening.resolve(container); await handle.quiesced();
  assert.equal(closes, 1); assert.equal(transfers, 0);
});

test('container transfer is awaited and closes exactly once, preserving deduplicated contents', async () => {
  const transfer = deferred<void>(); let closes = 0, result: unknown;
  const bot = fakeBot({ openContainer: async () => ({ deposit: () => transfer.promise,
    containerItems: () => [{ name: 'stone', count: 1 }, { name: 'stone', count: 1 }], close: () => { closes++; } }) });
  const f = fixture(new MineflayerGameAdapter(() => bot), async actions => { result = await actions.depositToChest(position, 'stone', 1); });
  const handle = f.start(); await flush(); assert.equal(closes, 0);
  transfer.resolve(); assert.equal((await handle.result).status, 'succeeded');
  assert.equal(closes, 1); assert.deepEqual(result, { ok: true, moved: 1, contents: ['stone'] });
});

test('reconnected adapters reject old-session dispatch and never redirect cleanup to the new Bot', async () => {
  const look = deferred<void>(); let newWrites = 0, oldWrites = 0;
  const first = fakeBot({ lookAt: () => look.promise, activateBlock: async () => { oldWrites++; } });
  const second = fakeBot({ activateBlock: async () => { newWrites++; }, clearControlStates: () => { newWrites++; } });
  let current = first;
  const f = fixture(new MineflayerGameAdapter(() => current), actions => actions.interactBlock(position));
  const handle = f.start(); await flush(); current = second; look.resolve();
  assert.equal((await handle.result).status, 'failed');
  assert.equal(oldWrites, 0); assert.equal(newWrites, 0);
});

test('Switchable binding remains fixed and is fenced when its target changes', async () => {
  const look = deferred<void>(); let writes = 0;
  const first = fakeBot({ lookAt: () => look.promise, activateBlock: async () => { writes++; } });
  const adapter = new SwitchableGameAdapter(new MineflayerGameAdapter(() => first));
  const f = fixture(adapter, actions => actions.interactBlock(position));
  const handle = f.start(); await flush(); adapter.setTarget(new NullGameAdapter()); look.resolve();
  assert.equal((await handle.result).status, 'failed'); assert.equal(writes, 0);
});

test('cleanup failure quarantines resources instead of pretending the device stopped', async () => {
  __setTuningOverride({ controlledExecution: { stopConfirmTimeoutMs: 1 } });
  const bot = fakeBot({ clearControlStates: () => { throw new Error('cleanup failed'); } });
  const f = fixture(new MineflayerGameAdapter(() => bot), actions => actions.setControlState('forward', true));
  const handle = f.start(); assert.equal((await handle.result).status, 'in_doubt');
  assert.equal(f.runtime.inspect('op')?.stop, null);
  assert.throws(() => f.start('next'), /body_resources_busy/);
});

test('offline adapters reject binding and do not report physical actions as successful no-ops', async () => {
  const f = fixture(new NullGameAdapter(), actions => actions.dig(position));
  const receipt = await f.start().result;
  assert.equal(receipt.status, 'failed'); assert.equal(receipt.noOp, true);
  assert.match(receipt.failure?.detail ?? '', /game_body_unavailable/);
});
