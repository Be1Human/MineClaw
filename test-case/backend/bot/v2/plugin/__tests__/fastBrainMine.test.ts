import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import type { Bot } from 'mineflayer';
import { MineflayerGameAdapter } from '../../../../../../apps/minecraft-companion/src/bot/mineflayer/MineflayerGameAdapter.js';
import { createFastBrainVisibleTargets } from '../../../../../../apps/minecraft-companion/src/bot/v2/plugins/builtin/fastbrain/visibleTargets.js';
import { createFastBrainMineAtomic, createFastBrainMineHandler, type MineMutationAuthority } from '../../../../../../apps/minecraft-companion/src/bot/v2/plugins/builtin/fastbrain/mine.js';
import type { FastBrainBodyPort } from '../../../../../../apps/minecraft-companion/src/bot/v2/plugins/builtin/fastbrain/body.js';
import type { DecisionContext } from '../../../../../../apps/minecraft-companion/src/bot/v2/plugins/builtin/fastbrain/adapter.js';
import { BodyExecutionRuntime } from '../../../../../../apps/minecraft-companion/src/bot/v2/task/execution/bodyExecutionRuntime.js';
import { ExecutionAuthority } from '../../../../../../apps/minecraft-companion/src/bot/v2/task/execution/executionAuthority.js';
import { OperationLedger } from '../../../../../../apps/minecraft-companion/src/bot/v2/task/execution/operationLedger.js';
import { GameBodyDriver } from '../../../../../../apps/minecraft-companion/src/bot/v2/task/execution/gameBodyDriver.js';
import { EventBusV2 } from '../../../../../../apps/minecraft-companion/src/bot/v2/infra/eventBus.js';
import { __setTuningOverride } from '../../../../../../apps/minecraft-companion/src/bot/v2/infra/tuning.js';
import type { ControlledExecutionContext } from '../../../../../../apps/minecraft-companion/src/bot/v2/task/execution/ports/controlledExecution.js';
import type { OperationIntent } from '../../../../../../apps/minecraft-companion/src/bot/v2/task/contracts/bodyOperation.js';
import type { OperationHandle } from '../../../../../../apps/minecraft-companion/src/bot/v2/task/execution/ports/bodyExecution.js';

const require = createRequire(new URL('../../../../../../apps/minecraft-companion/package.json', import.meta.url));
const { Vec3 } = require('vec3');
const registry = require('minecraft-data')('1.20.4');
const Block = require('prismarine-block')(registry);
const injectDigging = require('mineflayer/lib/plugins/digging.js');
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
afterEach(() => __setTuningOverride(null));

/** A real registered driver/runtime/grant/device session; only the network edge is a fixture. */
function fixture(options: { mutation?: boolean; authority?: boolean; native?: 'no_change' | 'unknown' | 'pending' | 'replace' | 'real_look'; positionX?: number } = {}) {
  const bot: any = new EventEmitter();
  const targetPosition = new Vec3(options.positionX ?? 2, 65, 0);
  let stateId: number | null = registry.blocksByName.oak_log.defaultState;
  let digCalls = 0, stops = 0, binds = 0;
  const packets: Array<{ type: string; status?: number }> = [];
  const native = deferred();
  const block = () => { if (stateId === null) return null; const b = Block.fromStateId(stateId, 0); b.position = targetPosition.clone(); return b; };
  const setState = (next: number | null) => { const old = block(); stateId = next; bot.emit('blockUpdate', old, block());
    bot.emit(`blockUpdate:${targetPosition}`, old, block()); };
  bot.username = 'fixture-bot'; bot.registry = registry; bot.version = '1.20.4'; bot.health = 20;
  bot.entity = { id: 1, position: new Vec3(0.5, 64, 0.5), eyeHeight: 1.62 };
  bot.world = {}; bot.game = { dimension: 'overworld' }; bot._client = new EventEmitter();
  bot.blockAt = () => block(); bot.findBlocks = () => [targetPosition.clone()]; bot.canSeeBlock = () => true;
  injectDigging(bot); // Use the installed version's real canDigBlock range/diggability rule.
  const realDig = bot.dig;
  bot._client.write = (type: string, packet: { status?: number }) => { packets.push({ type, status: packet.status }); };
  bot.lookAt = () => native.promise;
  bot.swingArm = () => {};
  bot.digTime = () => 0;
  bot._updateBlockState = (_position: unknown, next: number) => setState(next);
  bot.dig = options.native === 'real_look' ? (...args: unknown[]) => { digCalls++; return realDig(...args); } : async () => {
    digCalls++;
    if (options.native === 'pending') await native.promise;
    if (options.native === 'no_change') return;
    if (options.native === 'unknown') { setState(null); return; }
    setState(registry.blocksByName[options.native === 'replace' ? 'stone' : 'air'].defaultState);
  };
  if (options.native !== 'real_look') bot.stopDigging = () => { stops++; };
  bot.clearControlStates = () => { throw new Error('mine_must_not_move'); };
  bot.inventory = { items: () => [] };
  const game = new MineflayerGameAdapter(() => bot as Bot);
  const bind = game.bind.bind(game); game.bind = scope => { binds++; return bind(scope); };
  game.rebindSubscriptions(bot); bot.emit('spawn');
  const visible = createFastBrainVisibleTargets(game);
  const running = new Map<string, ControlledExecutionContext>();
  let current = true, localCurrent = true;
  let onPermit: (() => void) | undefined;
  const mutation: MineMutationAuthority = { capture(identity, target) {
    const original = running.get(identity.operationId);
    if (!original || original.leaseRef !== identity.leaseRef || original.operationEpoch !== identity.operationEpoch
      || original.owner.kind !== 'goal' || original.owner.sessionId !== target.sessionId) return null;
    return () => {
      try { original.assertCurrent('fixture_original_grant'); } catch { return false; }
      const region = original.scope.allowedMutationRegion;
      const p = target.position;
      const allowed = localCurrent && original.scope.dimension === target.dimension && !!region
        && original.scope.bindings.some(binding => binding.mutationAllowed)
        && p.x >= region.min.x && p.x <= region.max.x && p.y >= region.min.y && p.y <= region.max.y
        && p.z >= region.min.z && p.z <= region.max.z;
      const once = onPermit; onPermit = undefined; once?.();
      return allowed;
    };
  } };
  const atomic = createFastBrainMineAtomic(game, visible, options.authority === false ? undefined : mutation);
  const contribution = { pluginId: 'mineclaw.minecraft-system', pluginVersion: '1.0.0',
    contributionId: 'mineclaw.minecraft-system.execution.fastbrain', contributionVersion: '1.0.0' };
  const snapshot = { generationId: 'fixture-generation', buildId: 'fixture-build', graphHash: 'fixture-graph' };
  const base = new GameBodyDriver({ bus: new EventBusV2(), hostApiVersion: '2.0.0',
    atomicResolver: { resolve: (_snapshot, id) => id === atomic.atomicId
      ? { status: 'resolved', value: { executor: atomic.executor, contract: atomic.contract, contribution } }
      : { status: 'in_doubt', reason: 'atomic_unregistered' } },
    behaviorResolver: {
      resolve: () => ({ status: 'in_doubt', reason: 'not_a_behavior' }),
      resolveById: () => ({ status: 'in_doubt', reason: 'not_a_behavior' }),
      list: () => ({ status: 'resolved', value: [] }),
    },
  });
  const authority = new ExecutionAuthority();
  const ledger = new OperationLedger(':memory:');
  const runtime = new BodyExecutionRuntime({ authority, ledger, driver: {
    resources: command => base.resources(command),
    bind: (identity, command) => {
      const original = base.bind(identity, command);
      return { run: async context => {
        running.set(context.operationId, context);
        try { return await original.run(context); } finally { running.delete(context.operationId); }
      }, stop: reason => original.stop(reason) };
    },
  } });
  let last: OperationHandle | undefined;
  let lastIntent: OperationIntent | undefined;
  const host = (id = 'mine-1'): DecisionContext => ({ requestId: id, sessionId: 'fixture-session', actor: 'fixture-bot', dimension: 'overworld',
    notBefore: Date.now() - 1000, deadlineAt: Date.now() + 10_000, signal: new AbortController().signal, isCurrent: () => current });
  const body: FastBrainBodyPort = { execute: async (atomicId, target, context) => {
    const intent: OperationIntent = { operationId: context.requestId,
      owner: { kind: 'goal', taskId: 'fixture-goal', sessionId: context.sessionId, epoch: 1, planRevision: 1 },
      command: { ref: { id: `atomic:${atomicId}`, contribution }, snapshot,
        args: { target, source: 'fastbrain', timeoutMs: 10_000 } },
      scope: { dimension: 'overworld', targetRefs: ['fixture-mutation-region'],
        allowedMutationRegion: { min: { x: 2, y: 65, z: 0 }, max: { x: 2, y: 65, z: 0 } },
        bindings: [{ contribution, id: 'fixture-mutation-region', version: '1', kind: 'region', summary: 'fixture authorized plot',
          dimension: 'overworld', mutationAllowed: options.mutation !== false, required: true, requiredPredicates: [], evidenceRefs: ['fixture:plot'] }] },
      expectedEffects: [], deadlineAt: context.deadlineAt, budget: { maxActions: 1 }, priority: 1, preemption: 'none' };
    lastIntent = intent;
    const grant = authority.issue(intent, { isCurrent: () => current, allowsChild: () => false });
    last = runtime.submit({ intent, grant });
    return { kind: 'receipt', receipt: await last.result };
  } };
  const handler = createFastBrainMineHandler(body, visible);
  const target = visible.search('oak_log', 16, host()).targets[0]!;
  const decision = { type: 'call' as const, skill: 'mine' as const, args: { target_id: target.targetId } };
  return { bot, game, visible, handler, target, decision, host, runtime, ledger, authority, native, body, packets,
    get digCalls() { return digCalls; }, get stops() { return stops; }, get binds() { return binds; },
    get last() { return last!; }, get lastIntent() { return lastIntent!; },
    setState, revokeLocal: () => { localCurrent = false; }, revokeGoal: () => { current = false; },
    beforeDispatch: (callback: () => void) => { onPermit = callback; },
    close: () => { visible.close(); game.rebindSubscriptions(null); },
  };
}

test('mine traverses the registered GameBodyDriver but local same-cell air is not server-proven yield', async () => {
  const f = fixture();
  const result = await f.handler.run(f.decision, f.host());
  assert.equal(result.status, 'partial');
  assert.equal(result.effectKnowledge, 'unknown');
  assert.equal(result.details?.actual, null);
  assert.equal(result.details?.localRemovalObserved, true);
  assert.equal(result.details?.inventoryDelta, null);
  assert.equal(f.digCalls, 1);
  assert.equal((result.details?.stop as { state: string }).state, 'quiesced');
  assert.equal(f.lastIntent.command.ref.id, 'atomic:fastbrain_mine');
  assert.equal(f.lastIntent.budget.maxActions, 1);
  f.close();
});

test('a missing local authority or a read-only goal scope rejects before binding a device', async () => {
  for (const options of [{ authority: false }, { mutation: false }]) {
    const f = fixture(options);
    const result = await f.handler.run(f.decision, f.host());
    assert.equal(result.status, 'blocked');
    assert.equal(f.binds, 0); assert.equal(f.digCalls, 0);
    f.close();
  }
});

test('a visible block outside the original mutation region is not authority to mine there', async () => {
  const f = fixture({ positionX: 3 });
  const result = await f.handler.run(f.decision, f.host());
  assert.equal(result.status, 'blocked');
  assert.equal(f.binds, 0); assert.equal(f.digCalls, 0);
  f.close();
});

test('revoking the host mutation permission after admission fences the actual native dispatch', async () => {
  const f = fixture();
  f.beforeDispatch(f.revokeLocal);
  const result = await f.handler.run(f.decision, f.host());
  assert.equal(result.status, 'blocked');
  assert.equal(result.details?.actual, 0);
  assert.equal(f.digCalls, 0);
  f.close();
});

test('a same-name block-state change before native dispatch cannot be hidden by coordinates', async () => {
  const f = fixture();
  f.beforeDispatch(() => f.setState(registry.blocksByName.oak_log.defaultState + 1));
  const result = await f.handler.run(f.decision, f.host());
  assert.equal(result.status, 'blocked');
  assert.equal(f.digCalls, 0);
  f.close();
});

test('old or forged target references do not enter the body or get reduced to a coordinate', async () => {
  const f = fixture();
  f.visible.search('oak_log', 16, f.host());
  assert.equal((await f.handler.run(f.decision, f.host())).status, 'blocked');
  assert.equal((await f.handler.run({ ...f.decision, args: { target_id: 'forged:2,65,0' } }, f.host())).status, 'blocked');
  assert.equal(f.binds, 0); assert.equal(f.digCalls, 0);
  f.close();
});

test('an out-of-reach target is not silently approached, mined or picked up', async () => {
  const f = fixture({ positionX: 8 });
  assert.equal(f.target.canDig, false);
  const result = await f.handler.run(f.decision, f.host());
  assert.equal(result.status, 'blocked');
  assert.match(result.reason ?? '', /target_not_interactable/);
  assert.equal(f.binds, 0); assert.equal(f.digCalls, 0);
  f.close();
});

test('a resolved native call without a same-cell effect remains unknown, and identical requests do not replay', async () => {
  const f = fixture({ native: 'no_change' });
  const host = f.host();
  const first = await f.handler.run(f.decision, host);
  assert.equal(first.status, 'partial'); assert.equal(first.effectKnowledge, 'unknown');
  assert.equal(first.details?.actual, null);
  const second = await f.handler.run(f.decision, host);
  assert.equal(second.status, 'partial'); assert.equal(second.effectKnowledge, 'unknown');
  assert.equal(f.digCalls, 1);
  f.close();
});

test('an unloaded cell or an unrelated replacement block is never recorded as one mined block', async () => {
  for (const native of ['unknown', 'replace'] as const) {
    const f = fixture({ native });
    const result = await f.handler.run(f.decision, f.host());
    assert.equal(result.status, 'partial'); assert.equal(result.effectKnowledge, 'unknown');
    assert.equal(result.details?.actual, null); assert.equal(f.digCalls, 1);
    f.close();
  }
});

test('cancellation joins the original native dig and preserves unknown effects instead of a fake zero', async () => {
  const f = fixture({ native: 'pending' });
  const work = f.handler.run(f.decision, f.host());
  await flush(); assert.equal(f.digCalls, 1);
  f.last.cancel('fixture_stop'); await flush();
  assert.equal(f.stops, 1);
  assert.equal(f.runtime.inspect('mine-1')?.stop, null);
  f.native.resolve();
  const result = await work;
  assert.notEqual(result.status, 'success');
  assert.equal(result.effectKnowledge, 'unknown');
  assert.equal(result.details?.actual, null);
  assert.equal((result.details?.stop as { state: string }).state, 'quiesced');
  assert.equal(f.digCalls, 1);
  f.close();
});

test('unconfirmed native cancellation never acknowledges resource release or permits another body write', async () => {
  __setTuningOverride({ controlledExecution: { stopConfirmTimeoutMs: 1 } });
  const f = fixture({ native: 'pending' });
  const work = f.handler.run(f.decision, f.host());
  await flush(); f.last.cancel('fixture_stop');
  const result = await work;
  assert.equal(result.effectKnowledge, 'unknown');
  assert.equal(result.details?.stop, null);
  assert.equal(f.runtime.inspect('mine-1')?.state, 'quarantined');
  const another = { ...f.lastIntent, operationId: 'mine-2' };
  const grant = f.authority.issue(another, { isCurrent: () => true, allowsChild: () => false });
  assert.throws(() => f.runtime.submit({ intent: another, grant }), /body_resources_busy/);
  assert.equal(f.digCalls, 1);
  f.native.resolve(); await f.last.quiesced();
  assert.equal(result.details?.stop, null);
  f.close();
});

test('real Mineflayer must not start digging after cancellation during its lookAt await', async () => {
  const f = fixture({ native: 'real_look' });
  const work = f.handler.run(f.decision, f.host());
  await flush();
  f.last.cancel('cancel_during_native_look');
  await flush();
  f.native.resolve();
  const result = await work;
  assert.notEqual(result.status, 'success');
  assert.equal(result.effectKnowledge, 'unknown');
  assert.equal(f.packets.filter(packet => packet.type === 'block_dig' && packet.status === 0).length, 0,
    'the controlled session must fence the native lookAt -> block_dig boundary');
  f.close();
});

test('real Mineflayer optimistic air remains unknown without any server block-change evidence', async () => {
  const f = fixture({ native: 'real_look' });
  const work = f.handler.run(f.decision, f.host());
  await flush(); f.native.resolve();
  const result = await work;
  assert.equal(f.packets.some(packet => packet.type === 'block_dig' && packet.status === 2), true);
  assert.equal(result.details?.nativeCompleted, true);
  assert.equal(result.details?.localRemovalObserved, true);
  assert.equal(result.status, 'partial');
  assert.equal(result.effectKnowledge, 'unknown');
  assert.equal(result.details?.actual, null);
  f.close();
});

test('production unavailable authority is advertised before resolving a target or issuing a body request', async () => {
  const f = fixture();
  const handler = createFastBrainMineHandler({ available: false, reason: 'fastbrain_local_authority_unavailable',
    execute: async () => { throw new Error('must_not_execute'); } }, {
    ...f.visible, resolve: () => { throw new Error('must_not_resolve'); },
  });
  assert.equal(handler.available, false);
  const result = await handler.run(f.decision, f.host());
  assert.equal(result.reason, 'fastbrain_local_authority_unavailable');
  assert.equal(f.digCalls, 0);
  f.close();
});
