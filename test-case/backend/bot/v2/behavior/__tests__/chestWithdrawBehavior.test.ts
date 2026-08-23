import assert from 'node:assert/strict';
import test from 'node:test';

import type { WorldStateView } from '../../../../../../apps/minecraft-companion/src/bot/v2/types.js';
import { ChestWithdrawBehavior } from '../../../../../../apps/minecraft-companion/src/bot/v2/behavior/chestWithdrawBehavior.js';

function world(): WorldStateView {
  return {
    tick: 1,
    timestamp: 1,
    self: { position: { x: 0, y: 64, z: 0 }, yaw: 0, pitch: 0, health: 20, maxHealth: 20, food: 20, isOnGround: true },
    owner: null,
    environment: {} as WorldStateView['environment'],
    entities: [],
    inventory: { items: [], held: null, freeSlots: 36 },
    taskContext: null,
  };
}

test('BUG-CROSS-59 · chest withdrawal approaches the chest before withdrawing the requested count', () => {
  const actions = new ChestWithdrawBehavior().plan({
    world: world(),
    taskParams: { chestPos: { x: 5, y: 64, z: 2 }, item: 'iron_pickaxe', count: 1 },
  });
  assert.deepEqual(actions.map(action => action.type), ['move_to', 'withdraw']);
  assert.deepEqual(actions[0].target, { position: { x: 5, y: 64, z: 2 } });
  assert.deepEqual(actions[1].target, {
    position: { x: 5, y: 64, z: 2 }, itemName: 'iron_pickaxe', count: 1,
  });
});

test('BUG-CROSS-59 · invalid chest parameters fail closed with no actions', () => {
  const behavior = new ChestWithdrawBehavior();
  assert.deepEqual(behavior.plan({ world: world(), taskParams: { item: 'iron_pickaxe' } }), []);
  assert.deepEqual(behavior.plan({ world: world(), taskParams: { chestPos: { x: 1, y: 2, z: 3 } } }), []);
});
