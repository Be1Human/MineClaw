import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createMockBot } from '../index.js';
import { V2Runtime } from '../../../../../../../apps/minecraft-companion/src/bot/v2/v2Runtime.js';

describe('MockBot smoke test', () => {
  test('装备会同步 getHeldItem，缺失物品保持失败且不污染已有手持状态', async () => {
    const { world, game } = createMockBot();
    world.addItem({ name: 'wooden_hoe', count: 1, slot: 2 });

    await game.equip('wooden_hoe', 'hand');
    assert.equal(game.getHeldItem()?.name, 'wooden_hoe');
    assert.equal(world.inventory.find(item => item.name === 'wooden_hoe')?.count, 1, '装备不应消耗背包物品');

    await assert.rejects(game.equip('diamond_hoe', 'hand'), /item_not_found:diamond_hoe/);
    assert.equal(game.getHeldItem()?.name, 'wooden_hoe', '失败装备不得改写已有手持状态');
  });

  test('V2Runtime with MockBot: perceive returns non-null worldState', async () => {
    const { world, game, nav } = createMockBot();
    world.setOwner('testOwner', 100, { x: 5, y: 64, z: 0 });

    const rt = new V2Runtime({
      game,
      nav,
      ownerName: 'testOwner',
      tickMs: 50,
      dbPath: ':memory:',
      worldMapDbPath: ':memory:',
      chatMemoryDbPath: ':memory:',
    });

    rt.start();
    await new Promise(r => setTimeout(r, 150)); // wait ~3 ticks
    rt.stop();

    assert.equal(rt.memory.snapshot().dbConnected, false, 'stop should close MemoryV2 database');

    const snap = rt.snapshot();
    assert.ok(snap !== null, 'snapshot should be non-null');
    assert.ok(typeof snap.tick === 'number', 'tick should be a number');
  });
});
