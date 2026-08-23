import assert from 'node:assert/strict';
import test from 'node:test';

import type { WorldStateView } from '../../../../../../../apps/minecraft-companion/src/bot/v2/types.js';
import { rankChestTargets } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/goalAgent/production/containerTargetResolver.js';

function world(ownerYaw: number | null = Math.PI / 2): WorldStateView {
  return {
    tick: 1,
    timestamp: 1,
    self: { position: { x: 55, y: -60, z: 37 }, yaw: 0, pitch: 0, health: 20, maxHealth: 20, food: 20, isOnGround: true },
    owner: { username: 'cloudboyboy', position: { x: 60, y: -60, z: 37 }, distance: 5, entityId: 7, isVisible: true },
    environment: {} as WorldStateView['environment'],
    entities: [{
      id: 7, name: 'cloudboyboy', type: 'player', position: { x: 60, y: -60, z: 37 },
      distance: 5, category: 'player', ...(ownerYaw === null ? {} : { yaw: ownerYaw }),
    }],
    inventory: { items: [], held: null, freeSlots: 36 },
    taskContext: null,
  };
}

const southChest = { x: 59, y: -60, z: 40 };
const northChest = { x: 59, y: -60, z: 34 };

test('BUG-CROSS-59 · owner facing west resolves south as left and north as right', () => {
  assert.deepEqual(rankChestTargets([northChest, southChest], '去我左边的箱子', world()).map(target => target.pos), [southChest]);
  assert.deepEqual(rankChestTargets([southChest, northChest], '去我右边的箱子', world()).map(target => target.pos), [northChest]);
});

test('BUG-CROSS-59 · directional request fails closed without owner yaw', () => {
  assert.deepEqual(rankChestTargets([southChest, northChest], '去我左边的箱子', world(null)), []);
});

test('BUG-CROSS-59 · non-directional request keeps nearby chests in deterministic distance order', () => {
  const targets = rankChestTargets([southChest, { x: 58, y: -60, z: 37 }], 'find a nearby chest', world(null));
  assert.deepEqual(targets.map(target => target.pos), [{ x: 58, y: -60, z: 37 }, southChest]);
});
