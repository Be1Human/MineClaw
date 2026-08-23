import assert from 'node:assert/strict';
import test from 'node:test';

import type { WorldStateView } from '../../../../../../apps/minecraft-companion/src/bot/v2/types.js';
import { PickupGroundItemBehavior } from '../../../../../../apps/minecraft-companion/src/bot/v2/behavior/pickupGroundItemBehavior.js';

test('BUG-CROSS-69 · ground pickup approaches the grounded entity position', () => {
  const actions = new PickupGroundItemBehavior().plan({
    world: world(),
    taskParams: {
      item: 'iron_pickaxe', count: 1, itemEntityId: 41,
      position: { x: 5, y: 64, z: 0 },
    },
  });

  assert.equal(actions.length, 1);
  assert.equal(actions[0].type, 'move_to');
  assert.deepEqual(actions[0].target, { position: { x: 5, y: 64, z: 0 } });
  assert.deepEqual(actions[0].expected_effect, ['inventory_gained:iron_pickaxe']);
});

test('BUG-CROSS-69 · malformed ground pickup parameters fail closed', () => {
  const behavior = new PickupGroundItemBehavior();
  assert.deepEqual(behavior.plan({ world: world(), taskParams: { item: 'iron_pickaxe' } }), []);
  assert.deepEqual(behavior.plan({
    world: world(),
    taskParams: { item: 'iron_pickaxe', itemEntityId: 41, position: { x: Number.NaN, y: 64, z: 0 } },
  }), []);
});

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
