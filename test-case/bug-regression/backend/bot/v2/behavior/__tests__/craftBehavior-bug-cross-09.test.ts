import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { CraftBehavior } from '../../../../../../../apps/minecraft-companion/src/bot/v2/behavior/craftBehavior.js';
import type { WorldStateView } from '../../../../../../../apps/minecraft-companion/src/bot/v2/types.js';

const world: WorldStateView = {
  tick: 1,
  timestamp: 1,
  self: { position: { x: 0, y: 64, z: 0 }, yaw: 0, pitch: 0, health: 20, maxHealth: 20, food: 20, isOnGround: true },
  owner: null,
  environment: { dimension: 'overworld', timeOfDay: 0, isDay: true, isRaining: false },
  entities: [],
  inventory: { items: [], held: null, freeSlots: 36 },
  taskContext: null,
};

describe('BUG-CROSS-09 · CraftBehavior 透传库存目标', () => {
  it('把 inventoryTargetCount 原样带入 craft ActionRequest', () => {
    const requests = new CraftBehavior().plan({
      world,
      taskParams: { item: 'oak_planks', count: 1, inventoryTargetCount: 3 },
    });
    const craft = requests.find(req => req.type === 'craft');
    assert.ok(craft);
    assert.equal(craft.target?.count, 1);
    assert.equal(craft.target?.inventoryTargetCount, 3);
  });
});
