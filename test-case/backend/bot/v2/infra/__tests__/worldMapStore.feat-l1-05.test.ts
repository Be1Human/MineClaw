/**
 * FEAT-L1-05 · 记忆过期纠错 单测（node:test 版）
 *
 * 覆盖：
 *   ① WorldMapStore.decayConfidence / forgetBlock / updateBlock
 *   ② installPatchedBlockAt 在实地有真实值且与记忆不符时
 *      - 触发 onBlockChanged
 *      - 反写 worldMap（confidence 重置 1.0）
 *      - air 类记忆 → forget
 *   ③ 同坐标 diff 检测的 1s 降采样
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorldMapStoreImpl, type StoredBlock } from '../../../../../../apps/minecraft-companion/src/bot/v2/infra/worldMapStore.js';
import { installPatchedBlockAt, type BlockChangedDiff, type BotBlockAtTarget } from '../../../../../../apps/minecraft-companion/src/bot/v2/infra/patchedBlockAt.js';

function tempDb(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'wms-l1-05-'));
  return {
    path: join(dir, 'wm.db'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function makeStone(x: number, y: number, z: number): StoredBlock {
  return { x, y, z, blockName: 'stone', boundingBox: 'block', updatedAt: Date.now(), confidence: 1.0 };
}

describe('WorldMapStore · FEAT-L1-05 confidence / decay / forget / update', () => {
  test('decayConfidence reduces confidence and forgets at <= 0', () => {
    const { path: p, cleanup } = tempDb();
    const store = new WorldMapStoreImpl(p);
    try {
      store.upsertBatch([makeStone(1, 64, 2)]);
      // 初始 1.0
      let b = store.getBlock(1, 64, 2)!;
      assert.equal(b.confidence, 1.0);
      // 降两次 0.1 → 0.8
      assert.equal(store.decayConfidence(1, 64, 2, 0.1), 0.9);
      assert.equal(store.decayConfidence(1, 64, 2, 0.1), 0.8);
      b = store.getBlock(1, 64, 2)!;
      assert.ok(Math.abs((b.confidence ?? 1) - 0.8) < 1e-6);
      // 降到 0 → 自动 forget
      const left = store.decayConfidence(1, 64, 2, 1.0);
      assert.equal(left, 0);
      assert.equal(store.getBlock(1, 64, 2), null, 'should be forgotten');
      // 不存在的坐标 decay → null
      assert.equal(store.decayConfidence(99, 64, 99), null);
    } finally {
      store.close();
      cleanup();
    }
  });

  test('updateBlock resets confidence to 1.0 + new value', () => {
    const { path: p, cleanup } = tempDb();
    const store = new WorldMapStoreImpl(p);
    try {
      store.upsertBatch([makeStone(0, 64, 0)]);
      store.decayConfidence(0, 64, 0, 0.5); // 0.5
      store.updateBlock({
        x: 0, y: 64, z: 0, blockName: 'dirt',
        boundingBox: 'block', updatedAt: Date.now(), confidence: 1.0,
      });
      const b = store.getBlock(0, 64, 0)!;
      assert.equal(b.blockName, 'dirt');
      assert.equal(b.confidence, 1.0);
    } finally {
      store.close();
      cleanup();
    }
  });

  test('forgetBlock deletes the row', () => {
    const { path: p, cleanup } = tempDb();
    const store = new WorldMapStoreImpl(p);
    try {
      store.upsertBatch([makeStone(3, 64, 3)]);
      store.forgetBlock(3, 64, 3);
      assert.equal(store.getBlock(3, 64, 3), null);
    } finally {
      store.close();
      cleanup();
    }
  });

  test('migration: existing DB without confidence column gets one added', () => {
    const { path: p, cleanup } = tempDb();
    const store1 = new WorldMapStoreImpl(p);
    store1.upsertBatch([makeStone(0, 64, 0)]);
    store1.close();
    // 重新打开 · idempotent migration 不应炸
    const store2 = new WorldMapStoreImpl(p);
    try {
      const b = store2.getBlock(0, 64, 0)!;
      assert.equal(b.confidence, 1.0);
    } finally {
      store2.close();
      cleanup();
    }
  });
});

describe('patchedBlockAt · FEAT-L1-05 diff detection + rewrite', () => {
  function makeMockBot(realBlocks: Map<string, { name: string; boundingBox?: string }>): BotBlockAtTarget {
    return {
      blockAt(pos: { x: number; y: number; z: number }) {
        const key = `${Math.floor(pos.x)}:${Math.floor(pos.y)}:${Math.floor(pos.z)}`;
        const b = realBlocks.get(key);
        if (!b) return null;
        return { name: b.name, boundingBox: b.boundingBox ?? 'block' };
      },
      registry: {
        blocksByName: {
          stone: { id: 1, displayName: 'Stone', defaultState: 1 },
          dirt: { id: 3, displayName: 'Dirt', defaultState: 9 },
        },
      },
    };
  }

  test('diff → fires onBlockChanged + rewrites worldMap', () => {
    const { path: p, cleanup } = tempDb();
    const store = new WorldMapStoreImpl(p);
    try {
      // 记忆里是 stone，实地是 dirt
      store.upsertBatch([makeStone(5, 64, 5)]);
      const real = new Map([['5:64:5', { name: 'dirt' }]]);
      const bot = makeMockBot(real);

      const diffs: BlockChangedDiff[] = [];
      const { uninstall, stats } = installPatchedBlockAt(bot, store, {
        onBlockChanged: d => diffs.push(d),
        diffCheckIntervalMs: 0,  // 关掉降采样，方便测
      });

      bot.blockAt({ x: 5, y: 64, z: 5 });
      assert.equal(diffs.length, 1);
      assert.equal(diffs[0].previousBlockName, 'stone');
      assert.equal(diffs[0].actualBlockName, 'dirt');
      assert.equal(stats.diffDetected, 1);
      assert.equal(stats.memoryRewritten, 1);

      // worldMap 应被覆盖为 dirt
      const b = store.getBlock(5, 64, 5)!;
      assert.equal(b.blockName, 'dirt');
      assert.equal(b.confidence, 1.0);

      // 第二次同坐标 + 一致 → 不再 diff
      bot.blockAt({ x: 5, y: 64, z: 5 });
      assert.equal(diffs.length, 1);
      uninstall();
    } finally {
      store.close();
      cleanup();
    }
  });

  // BUG-MEM-01：air 信号不可信（启动期/chunk 边界 mineflayer 返回 fake air）
  // 旧行为：memory=stone, real=air → forget。
  // 新行为：memory=stone, real=air → 跳过，记忆保留。
  test('BUG-MEM-01 · memory=block, real=air → NOT forget (air diff ignored)', () => {
    const { path: p, cleanup } = tempDb();
    const store = new WorldMapStoreImpl(p);
    try {
      store.upsertBatch([makeStone(7, 64, 7)]);
      const real = new Map([['7:64:7', { name: 'air' }]]);
      const bot = makeMockBot(real);
      const diffs: BlockChangedDiff[] = [];
      const { uninstall, stats } = installPatchedBlockAt(bot, store, {
        onBlockChanged: d => diffs.push(d),
        diffCheckIntervalMs: 0,
      });
      bot.blockAt({ x: 7, y: 64, z: 7 });
      // 关键断言：air diff 完全静默
      assert.equal(stats.diffDetected, 0, 'air diff must not count');
      assert.equal(stats.memoryRewritten, 0, 'no rewrite');
      assert.equal(diffs.length, 0, 'no onBlockChanged event');
      // 记忆保留为 stone
      const b = store.getBlock(7, 64, 7);
      assert.ok(b, 'block must still be in memory');
      assert.equal(b!.blockName, 'stone');
      uninstall();
    } finally {
      store.close();
      cleanup();
    }
  });

  test('BUG-MEM-01 · cave_air / void_air 同样不触发 forget', () => {
    const { path: p, cleanup } = tempDb();
    const store = new WorldMapStoreImpl(p);
    try {
      store.upsertBatch([makeStone(8, 64, 8), makeStone(9, 64, 9)]);
      const real = new Map([
        ['8:64:8', { name: 'cave_air' }],
        ['9:64:9', { name: 'void_air' }],
      ]);
      const bot = makeMockBot(real);
      const { uninstall, stats } = installPatchedBlockAt(bot, store, {
        diffCheckIntervalMs: 0,
      });
      bot.blockAt({ x: 8, y: 64, z: 8 });
      bot.blockAt({ x: 9, y: 64, z: 9 });
      assert.equal(stats.diffDetected, 0);
      assert.equal(store.getBlock(8, 64, 8)?.blockName, 'stone');
      assert.equal(store.getBlock(9, 64, 9)?.blockName, 'stone');
      uninstall();
    } finally {
      store.close();
      cleanup();
    }
  });

  test('BUG-MEM-01 · 实方块 diff 仍正常 update（回归保护）', () => {
    const { path: p, cleanup } = tempDb();
    const store = new WorldMapStoreImpl(p);
    try {
      store.upsertBatch([makeStone(11, 64, 11)]);
      const real = new Map([['11:64:11', { name: 'dirt' }]]);
      const bot = makeMockBot(real);
      const diffs: BlockChangedDiff[] = [];
      const { uninstall, stats } = installPatchedBlockAt(bot, store, {
        onBlockChanged: d => diffs.push(d),
        diffCheckIntervalMs: 0,
      });
      bot.blockAt({ x: 11, y: 64, z: 11 });
      assert.equal(stats.diffDetected, 1);
      assert.equal(stats.memoryRewritten, 1);
      assert.equal(diffs.length, 1);
      assert.equal(diffs[0].actualBlockName, 'dirt');
      assert.equal(store.getBlock(11, 64, 11)?.blockName, 'dirt');
      uninstall();
    } finally {
      store.close();
      cleanup();
    }
  });

  test('same coord + diff: 1s debounce limits to one detection', () => {
    const { path: p, cleanup } = tempDb();
    const store = new WorldMapStoreImpl(p);
    try {
      store.upsertBatch([makeStone(2, 64, 2)]);
      const real = new Map([['2:64:2', { name: 'dirt' }]]);
      const bot = makeMockBot(real);
      const { stats, uninstall } = installPatchedBlockAt(bot, store, {
        diffCheckIntervalMs: 10_000,
      });
      // 第一次：diff + rewrite → worldMap 变 dirt
      bot.blockAt({ x: 2, y: 64, z: 2 });
      // 把记忆改回 stone（模拟外部覆盖），verify 第二次仍被 debounce 阻挡
      store.updateBlock(makeStone(2, 64, 2));
      bot.blockAt({ x: 2, y: 64, z: 2 });
      // diff 仍是 1（因为 1s 内不再检查）
      assert.equal(stats.diffDetected, 1);
      uninstall();
    } finally {
      store.close();
      cleanup();
    }
  });

  test('memory miss path still works (returns null when no memory)', () => {
    const { path: p, cleanup } = tempDb();
    const store = new WorldMapStoreImpl(p);
    try {
      const real = new Map<string, { name: string }>();  // 实地也没有
      const bot = makeMockBot(real);
      const { stats, uninstall } = installPatchedBlockAt(bot, store);
      const r = bot.blockAt({ x: 99, y: 64, z: 99 });
      assert.equal(r, null);
      assert.equal(stats.memoryMisses, 1);
      uninstall();
    } finally {
      store.close();
      cleanup();
    }
  });

  test('BUG-CROSS-07 · 真实方块且无历史记忆时不触发 SQLite getBlock', () => {
    const { path: p, cleanup } = tempDb();
    const store = new WorldMapStoreImpl(p);
    try {
      const bot = makeMockBot(new Map([['40:64:40', { name: 'stone' }]]));
      const originalGet = store.getBlock.bind(store);
      let pointReads = 0;
      store.getBlock = (x, y, z) => { pointReads++; return originalGet(x, y, z); };
      const { uninstall } = installPatchedBlockAt(bot, store, { diffCheckIntervalMs: 0 });

      const result = bot.blockAt({ x: 40, y: 64, z: 40 }) as { name?: string };

      assert.equal(result.name, 'stone');
      assert.equal(pointReads, 0);
      uninstall();
    } finally {
      store.close();
      cleanup();
    }
  });

  test('BUG-CROSS-07 · hasBlock 随写删同步并在重启后恢复', () => {
    const { path: p, cleanup } = tempDb();
    const store = new WorldMapStoreImpl(p);
    store.upsertBatch([makeStone(12, 64, 12)]);
    assert.equal(store.hasBlock(12, 64, 12), true);
    store.close();

    const reopened = new WorldMapStoreImpl(p);
    try {
      assert.equal(reopened.hasBlock(12, 64, 12), true);
      reopened.forgetBlock(12, 64, 12);
      assert.equal(reopened.hasBlock(12, 64, 12), false);
    } finally {
      reopened.close();
      cleanup();
    }
  });

  test('BUG-CROSS-11 · chunk/section 位图精确支持负坐标、跨 section 与高 Y', () => {
    const { path: p, cleanup } = tempDb();
    const store = new WorldMapStoreImpl(p);
    try {
      store.upsertBatch([
        makeStone(-1, -64, -1),
        makeStone(-16, -1, -16),
        makeStone(15, 319, 15),
        makeStone(16, 320, 16),
      ]);
      assert.equal(store.hasBlock(-1, -64, -1), true);
      assert.equal(store.hasBlock(-16, -1, -16), true);
      assert.equal(store.hasBlock(15, 319, 15), true);
      assert.equal(store.hasBlock(16, 320, 16), true);
      assert.equal(store.hasBlock(-2, -64, -1), false, '相邻 bit 不得串位');

      store.forgetBlock(-1, -64, -1);
      assert.equal(store.hasBlock(-1, -64, -1), false);
      assert.equal(store.hasBlock(-16, -1, -16), true, '清一个 bit 不得影响其他 section/chunk');
    } finally {
      store.close();
      cleanup();
    }
  });
});
