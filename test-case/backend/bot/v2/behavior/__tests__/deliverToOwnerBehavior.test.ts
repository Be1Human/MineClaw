import assert from 'node:assert/strict';
import test from 'node:test';

import type { WorldStateView } from '../../../../../../apps/minecraft-companion/src/bot/v2/types.js';
import { DeliverToOwnerBehavior } from '../../../../../../apps/minecraft-companion/src/bot/v2/behavior/deliverToOwnerBehavior.js';

test('BUG-CROSS-60/69 · delivery approaches a distant owner then tosses toward their pickup radius', () => {
  const actions = new DeliverToOwnerBehavior().plan({
    world: world(),
    taskParams: { item: 'iron_pickaxe', count: 1 },
  });
  assert.deepEqual(actions.map(action => action.type), ['move_to', 'toss_item']);
  assert.equal(actions[0].target?.range, 0);
  assert.ok(Math.abs((actions[0].target?.position?.x ?? 0) - 0.8) < 1e-9);
  assert.deepEqual(
    { y: actions[0].target?.position?.y, z: actions[0].target?.position?.z },
    { y: 64, z: 0 },
  );
  assert.deepEqual(actions[1].target, {
    itemName: 'iron_pickaxe', count: 1, entityId: 7, position: { x: 4, y: 64, z: 0 },
  });
});

test('BUG-CROSS-60 · missing owner or item fails closed', () => {
  const behavior = new DeliverToOwnerBehavior();
  assert.deepEqual(behavior.plan({ world: { ...world(), owner: null }, taskParams: { item: 'iron_pickaxe' } }), []);
  assert.deepEqual(behavior.plan({ world: world(), taskParams: {} }), []);
});

function world(): WorldStateView {
  return {
    tick: 1,
    timestamp: 1,
    self: { position: { x: 0, y: 64, z: 0 }, yaw: 0, pitch: 0, health: 20, maxHealth: 20, food: 20, isOnGround: true },
    owner: { username: 'owner', position: { x: 4, y: 64, z: 0 }, distance: 4, entityId: 7, isVisible: true },
    environment: {} as WorldStateView['environment'],
    entities: [],
    inventory: { items: [{ name: 'iron_pickaxe', count: 1, slot: 0 }], held: null, freeSlots: 35 },
    taskContext: null,
  };
}
