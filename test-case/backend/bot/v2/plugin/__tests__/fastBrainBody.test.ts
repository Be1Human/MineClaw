import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { MineflayerGameAdapter } from '../../../../../../apps/minecraft-companion/src/bot/mineflayer/MineflayerGameAdapter.js';
import { BodyActionService } from '../../../../../../apps/minecraft-companion/src/bot/v2/task/execution/bodyActionService.js';
import { OperationLedger } from '../../../../../../apps/minecraft-companion/src/bot/v2/task/execution/operationLedger.js';
import { EventBusV2 } from '../../../../../../apps/minecraft-companion/src/bot/v2/infra/eventBus.js';
import { createGoalAgentState } from '../../../../../../apps/minecraft-companion/src/bot/v2/task/goalAgent/goalAgentState.js';
import { formalizeState } from '../../task/goalAgent/__tests__/goalTestFixtures.js';
import { FastBrainAdapter, type DecisionContext } from '../../../../../../apps/minecraft-companion/src/bot/v2/plugins/builtin/fastbrain/adapter.js';
import { createFastBrainBodyAtomics, createFastBrainBodyHandlers, FASTBRAIN_BODY_CONTRIBUTION, type FastBrainBodyPort } from '../../../../../../apps/minecraft-companion/src/bot/v2/plugins/builtin/fastbrain/body.js';
import { actionCommand } from '../../../../../../apps/minecraft-companion/src/bot/v2/task/execution/actionCommand.js';
import { readOriginalFastBrainReceipt } from '../../../../../../apps/minecraft-companion/src/bot/v2/plugins/builtin/fastbrain/originalReceipt.js';
import type { ActionRequest } from '../../../../../../apps/minecraft-companion/src/bot/v2/types.js';

/** Simulated native Bot; device binding, body lease, authority and ledger are real. */
function fixture(options: { consumePacket?: boolean; updatePacket?: boolean; consumeDeferred?: Promise<void>; spawn?: boolean; failInventoryAfter?: boolean; consumeEntity?: number } = {}) {
  const native = new EventEmitter() as any;
  const inventory = new EventEmitter() as any;
  let items = [{ name: 'bread', count: 3, slot: 36, type: 1 }, { name: 'shield', count: 1, slot: 37, type: 2 },
    { name: 'iron_helmet', count: 1, slot: 38, type: 3 }, { name: 'iron_chestplate', count: 1, slot: 39, type: 4 },
    { name: 'iron_leggings', count: 1, slot: 40, type: 5 }, { name: 'iron_boots', count: 1, slot: 41, type: 6 }];
  let inventoryFailed = false;
  const calls: string[] = [];
  inventory.items = () => { if (inventoryFailed) throw new Error('inventory_disconnected'); return items; };
  inventory.slots = Array(46).fill(null);
  Object.assign(native, { username: 'bot', entity: { id: 1, position: { x: 0, y: 64, z: 0 }, yaw: 0, pitch: 0 },
    inventory, _client: new EventEmitter(), world: {}, game: { dimension: 'overworld', gameMode: 'survival' }, heldItem: null,
    health: 20, food: 10, registry: { itemsByName: {} },
    equip: async (item: any, destination: string) => {
      calls.push(`equip:${item.name}:${destination}`);
      if (destination === 'hand') native.heldItem = item;
      else inventory.slots[({ 'off-hand': 45, head: 5, torso: 6, legs: 7, feet: 8 } as Record<string, number>)[destination]] = item;
    },
    consume: async () => {
      calls.push('consume');
      await options.consumeDeferred;
      const before = { ...items[0] };
      items = [{ ...items[0], count: items[0].count - 1 }, ...items.slice(1)];
      native.heldItem = items[0];
      if (options.updatePacket !== false) inventory.emit('updateSlot', 36, before, items[0]);
      if (options.consumePacket !== false) native._client.emit('entity_status', { entityId: options.consumeEntity ?? 1, entityStatus: 9 });
      inventoryFailed = options.failInventoryAfter === true;
    },
    deactivateItem: () => { calls.push('deactivate'); }, stopDigging: () => undefined, clearControlStates: () => undefined,
  });
  const game = new MineflayerGameAdapter(() => native);
  game.rebindSubscriptions(native);
  if (options.spawn !== false) native.emit('spawn');
  const bus = new EventBusV2();
  const state = formalizeState(createGoalAgentState({ sessionId: 'goal', interactionSessionId: 'interaction', request: {
    meta: { schemaVersion: 2, sessionId: 'interaction', messageId: 'root-request', correlationId: 'correlation', conversationId: 'conversation', sequence: 1,
      emittedAt: new Date().toISOString(), idempotencyKey: 'root-request' }, origin: 'player_message', originalText: 'fixture', requestText: 'fixture', requestKind: 'task', constraints: [],
  } }));
  state.phase = 'running'; state.plan.revision = 1;
  const contribution = { pluginId: 'mineclaw.minecraft-system', pluginVersion: '1.0.0', contributionId: FASTBRAIN_BODY_CONTRIBUTION, contributionVersion: '1.0.0' };
  const atomics = createFastBrainBodyAtomics(game);
  const ledger = new OperationLedger(':memory:');
  const body = new BodyActionService({ game, nav: {} as never, bus, ledger,
    tasks: { list: () => [{ id: 'task', state: 'running' }], isRunning: (id: string) => id === 'task' } as never,
    getWorld: () => ({ environment: { dimension: 'overworld' } }) as never, isEmbodied: () => true, getGoalState: () => state,
    getSnapshot: () => state.snapshotRef!, hostApiVersion: '2.0.0',
    atomicResolver: { resolve: (_snapshot, id) => {
      const entry = atomics.find(value => value.atomicId === id);
      return entry ? { status: 'resolved', value: { ...entry, contribution } } : { status: 'in_doubt', reason: 'not_registered' };
    } },
    behaviorResolver: {} as never,
  });
  // This test fixture represents an already-authorized local action. The V2
  // global service deliberately has NO such primitive authorization source.
  const port: FastBrainBodyPort = { execute: async (atomicId, target, context) => {
    const request: ActionRequest = { id: context.requestId, taskId: 'task', source: 'fastbrain', type: atomicId as ActionRequest['type'],
      target: target as ActionRequest['target'], timeout_ms: context.deadlineAt - context.notBefore,
      priority: 30, interrupt_level: 'soft', resource: [], preconditions: [] };
    const command = actionCommand(request, contribution, state.snapshotRef!);
    const original = readOriginalFastBrainReceipt(ledger.get(context.requestId), { operationId: context.requestId,
      owner: { kind: 'goal', taskId: 'task', sessionId: state.sessionId, epoch: state.epoch, planRevision: state.plan.revision },
      command, scope: state.rootGoal!.scope, expectedEffects: state.rootGoal!.successCriteria.map(({ since: _since, ...criterion }) => criterion), priority: 30 });
    if (original.kind === 'receipt') return original;
    if (original.kind !== 'absent') return { kind: 'rejected', reason: `original_${original.kind}` };
    const result = await body.executeGoal(request, { state, taskId: 'task', operationId: context.requestId, signal: context.signal });
    return result.kind === 'operation' ? { kind: 'receipt', receipt: result.receipt } : { kind: 'rejected', reason: result.error ?? 'body_rejected' };
  } };
  const adapter = new FastBrainAdapter({ isActive: () => true, handlers: createFastBrainBodyHandlers(port) });
  const now = Date.now();
  const context: DecisionContext = { requestId: 'atomic-request', sessionId: 'goal', actor: 'bot', dimension: 'overworld', notBefore: now,
    deadlineAt: now + 5000, signal: new AbortController().signal, isCurrent: () => true };
  return { native, inventory, game, calls, ledger, body, adapter, context };
}

test('pre-authorized equip uses the original body lease, exact slot and original request ledger row', async () => {
  for (const slot of ['hand', 'off-hand', 'head', 'torso', 'legs', 'feet']) {
    const f = fixture();
    try {
      const item = ({ head: 'iron_helmet', torso: 'iron_chestplate', legs: 'iron_leggings', feet: 'iron_boots' } as Record<string, string>)[slot] ?? 'shield';
      const result = await f.adapter.submit({ type: 'call', skill: 'equip', args: { item, slot } }, f.context);
      assert.equal(result.status, 'success');
      assert.deepEqual(f.calls, [`equip:${item}:${slot}`]);
      assert.equal((result.details?.stop as { operationId: string }).operationId, f.context.requestId);
      assert.equal(f.ledger.get(f.context.requestId)?.source.contributionId, FASTBRAIN_BODY_CONTRIBUTION);
      assert.equal(f.ledger.get(f.context.requestId)?.receipt?.details?.effectKnowledge, 'confirmed');
      assert.equal(f.body.busy(), false);
    } finally { await f.body.close(); f.ledger.close(); }
  }
});

test('consume needs own-player consumption event AND selected-item inventory delta; upper bound does not consume a stack', async () => {
  const f = fixture();
  try {
    const result = await f.adapter.submit({ type: 'call', skill: 'consume', args: { item: 'bread', count: 2 } }, f.context);
    assert.equal(result.status, 'success');
    assert.equal(result.details?.actual, 1);
    assert.equal(f.calls.filter(value => value === 'consume').length, 1);
    assert.equal(f.game.getInventoryItems().find(item => item.name === 'bread')?.count, 2);
    assert.equal(f.native._client.listenerCount('entity_status'), 0);
    assert.equal(f.inventory.listenerCount('updateSlot'), 0);
    assert.equal((result.details?.stop as { state: string }).state, 'quiesced');
  } finally { await f.body.close(); f.ledger.close(); }
});

test('inventory decrease without own consumption event is unknown, never a successful training label', async () => {
  const f = fixture({ consumePacket: false });
  try {
    const result = await f.adapter.submit({ type: 'call', skill: 'consume', args: { item: 'bread' } }, f.context);
    assert.equal(result.status, 'partial');
    assert.equal(result.effectKnowledge, 'unknown');
    assert.equal(f.ledger.get(f.context.requestId)?.status, 'in_doubt');
  } finally { await f.body.close(); f.ledger.close(); }
});

test('another entity consumption packet or missing inventory read cannot confirm this item consumption', async () => {
  for (const options of [{ consumeEntity: 9 }, { failInventoryAfter: true }, { updatePacket: false }]) {
    const f = fixture(options);
    try {
      const result = await f.adapter.submit({ type: 'call', skill: 'consume', args: { item: 'bread' } }, f.context);
      assert.equal(result.status, 'partial');
      assert.equal(result.effectKnowledge, 'unknown');
      assert.equal(f.calls.filter(value => value === 'consume').length, 1);
      assert.equal(f.native._client.listenerCount('entity_status'), 0);
    } finally { await f.body.close(); f.ledger.close(); }
  }
});

test('unwitnessed spawn blocks body writes; a same-world respawn invalidates in-flight consume proof', async () => {
  const notSpawned = fixture({ spawn: false });
  try {
    const result = await notSpawned.adapter.submit({ type: 'call', skill: 'equip', args: { item: 'shield', slot: 'hand' } }, notSpawned.context);
    assert.equal(result.status, 'blocked');
    assert.equal(notSpawned.calls.length, 0);
  } finally { await notSpawned.body.close(); notSpawned.ledger.close(); }
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const f = fixture({ consumeDeferred: pending });
  try {
    const result = f.adapter.submit({ type: 'call', skill: 'consume', args: { item: 'bread' } }, f.context);
    await new Promise<void>(resolve => setImmediate(resolve));
    f.native.emit('respawn'); f.native.emit('spawn');
    release();
    const receipt = await result;
    assert.equal(receipt.status, 'partial');
    assert.equal(receipt.effectKnowledge, 'unknown');
  } finally { release(); await f.body.close(); f.ledger.close(); }
});

test('same original request returns its durable receipt without a second consume; changed args conflict', async () => {
  const f = fixture();
  try {
    const wire = { type: 'call', skill: 'consume', args: { item: 'bread' } };
    assert.equal((await f.adapter.submit(wire, f.context)).status, 'success');
    assert.equal((await f.adapter.submit(wire, f.context)).status, 'success');
    const changed = await f.adapter.submit({ ...wire, args: { item: 'bread', count: 2 } }, f.context);
    assert.equal(changed.status, 'blocked');
    assert.equal(changed.reason, 'original_conflict');
    assert.equal(f.calls.filter(value => value === 'consume').length, 1);
  } finally { await f.body.close(); f.ledger.close(); }
});

test('adapter close aborts the original signal but cannot resolve before the native body drains', async () => {
  let release!: () => void;
  const native = new Promise<void>(resolve => { release = resolve; });
  const f = fixture({ consumeDeferred: native });
  try {
    let settled = false;
    const result = f.adapter.submit({ type: 'call', skill: 'consume', args: { item: 'bread' } }, f.context).then(value => { settled = true; return value; });
    await new Promise<void>(resolve => setImmediate(resolve));
    f.adapter.close();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(settled, false);
    assert.equal(f.body.busy(), true);
    release();
    const receipt = await result;
    assert.notEqual(receipt.status, 'success');
    assert.equal(receipt.effectKnowledge, 'unknown');
    assert.equal((receipt.details?.stop as { state: string }).state, 'quiesced');
  } finally { release(); await f.body.close(); f.ledger.close(); }
});

test('missing local authorization is a visible unavailable entry, not an available session-based body grant', async () => {
  let calls = 0;
  const handlers = createFastBrainBodyHandlers({ available: false, reason: 'fastbrain_local_authority_unavailable', execute: async () => {
    calls++; return { kind: 'rejected', reason: 'must_not_dispatch' };
  } });
  const adapter = new FastBrainAdapter({ isActive: () => true, handlers });
  assert.equal(adapter.catalog().find(value => value.name === 'equip')?.available, false);
  const f = fixture();
  try {
    const result = await adapter.submit({ type: 'call', skill: 'equip', args: { item: 'shield', slot: 'hand' } }, f.context);
    assert.equal(result.reason, 'fastbrain_local_authority_unavailable');
    assert.equal(calls, 0);
  } finally { await f.body.close(); f.ledger.close(); }
});
