import test from 'node:test';
import assert from 'node:assert/strict';
import { GatherBehavior } from '../../../../../../apps/minecraft-companion/src/bot/v2/behavior/gatherBehavior.js';
import type {
  ActionRequest,
  ExecutionResult,
  WorldStateView,
} from '../../../../../../apps/minecraft-companion/src/bot/v2/types.js';

function world(itemCount = 0, withDrop = false): WorldStateView {
  return {
    tick: 1,
    timestamp: Date.now(),
    self: {
      position: { x: 52.5, y: -60, z: 37.5 }, yaw: 0, pitch: 0,
      health: 20, maxHealth: 20, food: 20, isOnGround: true,
    },
    owner: null,
    environment: { dimension: 'overworld', timeOfDay: 1_000, isDay: true, isRaining: false },
    entities: withDrop ? [{
      id: 9, name: 'item', type: 'object', category: 'item',
      position: { x: 57.5, y: -59.5, z: 37.5 }, distance: 1,
      droppedItem: { name: 'oak_log', count: 1 },
    }] : [],
    inventory: {
      items: [
        { name: 'iron_axe', count: 1, slot: 0 },
        ...(itemCount > 0 ? [{ name: 'oak_log', count: itemCount, slot: 1 }] : []),
      ],
      held: null,
      freeSlots: 8,
    },
    taskContext: null,
  };
}

function receipt(request: ActionRequest, ok = true): ExecutionResult {
  return { ok, request, durationMs: 1, ...(ok ? {} : { error: 'test_failure' }) };
}

test('gather behavior waits for pickup settlement and requires a real inventory delta', async () => {
  let itemCount = 0;
  let pauses = 0;
  const actions: ActionRequest[] = [];
  const behavior = new GatherBehavior(async () => {
    pauses += 1;
    if (pauses === 1) itemCount = 1;
  });
  const result = await behavior.run!({
    taskParams: {
      pos: { x: 57, y: -60, z: 37 }, blockName: 'oak_log',
      toolName: 'iron_axe', acceptedItems: ['oak_log'],
    },
    getWorld: () => world(itemCount),
    async execute(request) { actions.push(request); return receipt(request); },
    publish() {},
  });

  assert.equal(result.ok, true);
  assert.equal(pauses, 1);
  assert.deepEqual(actions.map(action => action.type), ['equip', 'move_to', 'dig']);
  assert.equal(result.details?.before, 0);
  assert.equal(result.details?.after, 1);
});

test('gather behavior only performs bounded local pickup retries before succeeding', async () => {
  let itemCount = 0;
  const actions: ActionRequest[] = [];
  const behavior = new GatherBehavior(async () => {});
  const result = await behavior.run!({
    taskParams: {
      pos: { x: 57, y: -60, z: 37 }, blockName: 'oak_log', acceptedItems: ['oak_log'],
    },
    getWorld: () => world(itemCount, itemCount === 0),
    async execute(request) {
      actions.push(request);
      if (request.source === 'gather_block_pickup') itemCount = 1;
      return receipt(request);
    },
    publish() {},
  });

  assert.equal(result.ok, true);
  const pickup = actions.find(action => action.source === 'gather_block_pickup');
  assert.equal(pickup?.type, 'move_to');
  assert.equal(pickup?.target?.range, 0.5);
  assert.equal(actions.filter(action => action.source === 'gather_block_pickup').length, 1);
});

test('gather behavior fails closed when a removed block never reaches inventory', async () => {
  const events: string[] = [];
  const behavior = new GatherBehavior(async () => {});
  const result = await behavior.run!({
    taskParams: {
      pos: { x: 57, y: -60, z: 37 }, blockName: 'oak_log', acceptedItems: ['oak_log'],
    },
    getWorld: () => world(0),
    async execute(request) { return receipt(request); },
    publish(type) { events.push(type); },
  });

  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /gather_pickup_unverified:oak_log/);
  assert.ok(events.includes('behavior.gather_block.fail'));
});
