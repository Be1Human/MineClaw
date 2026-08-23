import assert from 'node:assert/strict';
import test from 'node:test';

import type { WorldStateView } from '../../../../../../apps/minecraft-companion/src/bot/v2/types.js';
import { DepositToChestBehavior } from '../../../../../../apps/minecraft-companion/src/bot/v2/behavior/depositToChestBehavior.js';

function world(): WorldStateView {
  return {
    tick: 1,
    timestamp: 1,
    self: { position: { x: 0, y: 64, z: 0 }, yaw: 0, pitch: 0, health: 20, maxHealth: 20, food: 20, isOnGround: true },
    owner: null,
    environment: {} as WorldStateView['environment'],
    entities: [],
    inventory: { items: [{ name: 'cobblestone', count: 32, slot: 0 }], held: null, freeSlots: 35 },
    taskContext: null,
  };
}

test('BUG-CROSS-61 · chest deposit approaches the chest before depositing the exact count', () => {
  const actions = new DepositToChestBehavior().plan({
    world: world(),
    taskParams: { chestPos: { x: 5, y: 64, z: 2 }, item: 'cobblestone', count: 16 },
  });
  assert.deepEqual(actions.map(action => action.type), ['move_to', 'deposit']);
  assert.deepEqual(actions[0].target, { position: { x: 5, y: 64, z: 2 } });
  assert.deepEqual(actions[1].target, {
    position: { x: 5, y: 64, z: 2 }, itemName: 'cobblestone', count: 16,
  });
});

test('BUG-CROSS-61 · invalid deposit parameters fail closed with no actions', () => {
  const behavior = new DepositToChestBehavior();
  assert.deepEqual(behavior.plan({ world: world(), taskParams: { item: 'cobblestone' } }), []);
  assert.deepEqual(behavior.plan({ world: world(), taskParams: { chestPos: { x: 1, y: 2, z: 3 } } }), []);
});
