import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GatherBehavior } from '../../../../../../../apps/minecraft-companion/src/bot/v2/behavior/gatherBehavior.js';
import type { WorldStateView } from '../../../../../../../apps/minecraft-companion/src/bot/v2/types.js';

function worldAt(x: number, y = 64, z = 0): WorldStateView {
  return {
    tick: 1,
    timestamp: 1,
    self: { position: { x, y, z }, yaw: 0, pitch: 0, health: 20, maxHealth: 20, food: 20, isOnGround: true },
    owner: null,
    environment: { dimension: 'overworld', timeOfDay: 0, isDay: true, isRaining: false },
    entities: [],
    inventory: { items: [], held: null, freeSlots: 36 },
    taskContext: null,
  };
}

describe('BUG-CROSS-28 · GatherBehavior 距离自适应预算', () => {
  it('8 格近目标保持约 9 秒 approach', () => {
    const requests = new GatherBehavior().plan({
      world: worldAt(0),
      taskParams: { pos: { x: 8, y: 64, z: 0 }, blockName: 'oak_log' },
    });
    assert.equal(requests.find(req => req.type === 'move_to')?.timeout_ms, 9200);
  });

  it('32 格目标获得约 19 秒且不超过 20 秒', () => {
    const requests = new GatherBehavior().plan({
      world: worldAt(0),
      taskParams: { pos: { x: 32, y: 64, z: 0 }, blockName: 'oak_log' },
    });
    const timeout = requests.find(req => req.type === 'move_to')?.timeout_ms ?? 0;
    assert.equal(timeout, 18800);
    assert.ok(timeout <= 20000);
  });

  it('空手别名不会被误当成待装备物品', () => {
    for (const alias of ['hand', 'empty_hand', 'bare_hand', '空手', '徒手']) {
      const requests = new GatherBehavior().plan({
        world: worldAt(0),
        taskParams: { pos: { x: 1, y: 64, z: 0 }, blockName: 'oak_log', toolName: alias },
      });
      assert.equal(requests.some(req => req.type === 'equip'), false, alias);
      assert.deepEqual(requests.map(req => req.type), ['move_to', 'dig', 'move_to']);
    }
  });

  it('真实工具名仍会在采集前装备', () => {
    const requests = new GatherBehavior().plan({
      world: worldAt(0),
      taskParams: { pos: { x: 1, y: 64, z: 0 }, blockName: 'stone', toolName: 'wooden_pickaxe' },
    });
    assert.deepEqual(requests.map(req => req.type), ['equip', 'move_to', 'dig', 'move_to']);
    assert.equal(requests[0].target?.itemName, 'wooden_pickaxe');
  });
});
