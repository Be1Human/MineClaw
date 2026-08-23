/**
 * WorldMapStore + WorldMapCollector + patchedBlockAt 单元测试（node:test 版）
 * FEAT-L1-01 Phase 1
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { WorldMapStoreImpl, type StoredBlock } from '../../../../../../apps/minecraft-companion/src/bot/v2/infra/worldMapStore.js';
import { WorldMapCollectorImpl } from '../../../../../../apps/minecraft-companion/src/bot/v2/infra/worldMapCollector.js';
import { installPatchedBlockAt } from '../../../../../../apps/minecraft-companion/src/bot/v2/infra/patchedBlockAt.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ── Helpers ──────────────────────────────────────────────

function tempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wms-test-'));
  return path.join(dir, 'test_world_map.db');
}

function makeBlock(x: number, y: number, z: number, name = 'stone'): StoredBlock {
  return { x, y, z, blockName: name, boundingBox: 'block', updatedAt: Date.now() };
}

/** 手写 mock（house style：全仓不用 mock.fn，手写计数器） */
function spy<A extends unknown[], R>(impl: (...args: A) => R) {
  const fn = (...args: A): R => {
    fn.calls.push(args);
    return impl(...args);
  };
  fn.calls = [] as A[];
  return fn;
}

// ── WorldMapStore ────────────────────────────────────────

describe('WorldMapStore', () => {
  let store: WorldMapStoreImpl;
  let dbPath: string;

  beforeEach(() => {
    dbPath = tempDbPath();
    store = new WorldMapStoreImpl(dbPath);
  });

  afterEach(() => {
    store.close();
    // Cleanup
    try { fs.rmSync(path.dirname(dbPath), { recursive: true }); } catch { /* 临时目录已清 */ }
  });

  it('getBlock returns null for unknown position', () => {
    assert.equal(store.getBlock(0, 64, 0), null);
  });

  it('upsertBatch + getBlock roundtrip', () => {
    const blocks = [makeBlock(10, 64, 20, 'dirt'), makeBlock(11, 64, 20, 'grass_block')];
    store.upsertBatch(blocks);

    const result = store.getBlock(10, 64, 20);
    assert.notEqual(result, null);
    assert.equal(result!.blockName, 'dirt');
    assert.equal(result!.boundingBox, 'block');
  });

  it('LRU cache hit on second read', () => {
    store.upsertBatch([makeBlock(5, 5, 5)]);
    const r1 = store.getBlock(5, 5, 5);
    const r2 = store.getBlock(5, 5, 5);
    assert.deepEqual(r1, r2);
  });

  it('chunkHasData returns true after insert', () => {
    // chunk (0,0) covers x=0..15, z=0..15
    store.upsertBatch([makeBlock(3, 64, 7)]);
    assert.equal(store.chunkHasData(0, 0), true);
    assert.equal(store.chunkHasData(1, 1), false);
  });

  it('getRegion returns blocks in range', () => {
    store.upsertBatch([
      makeBlock(0, 64, 0),
      makeBlock(5, 64, 5),
      makeBlock(100, 64, 100), // out of range
    ]);
    const region = store.getRegion(0, 10, 0, 10);
    assert.equal(region.length, 2);
  });

  it('getStats returns correct counts', () => {
    store.upsertBatch([makeBlock(0, 0, 0), makeBlock(1, 0, 0), makeBlock(20, 0, 20)]);
    const stats = store.getStats();
    assert.equal(stats.totalBlocks, 3);
    assert.ok(stats.chunksWithData >= 1);
  });

  it('upsert replaces existing block', () => {
    store.upsertBatch([makeBlock(0, 0, 0, 'stone')]);
    store.upsertBatch([makeBlock(0, 0, 0, 'air')]);
    const b = store.getBlock(0, 0, 0);
    assert.equal(b!.blockName, 'air');
  });
});

// ── patchedBlockAt ───────────────────────────────────────

describe('patchedBlockAt', () => {
  let store: WorldMapStoreImpl;
  let dbPath: string;

  beforeEach(() => {
    dbPath = tempDbPath();
    store = new WorldMapStoreImpl(dbPath);
  });

  afterEach(() => {
    store.close();
    try { fs.rmSync(path.dirname(dbPath), { recursive: true }); } catch { /* 临时目录已清 */ }
  });

  // BUG-L1-03: patch 目标已从 GameAdapter.getBlockAt 改为 bot.blockAt
  function makeMockBot(blockAtImpl: (pos: { x: number; y: number; z: number }) => unknown) {
    return {
      blockAt: spy(blockAtImpl),
      registry: {
        blocksByName: {
          stone: { id: 1, defaultState: 0, displayName: 'Stone' },
          oak_planks: { id: 5, defaultState: 10, displayName: 'Oak Planks' },
        },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
  }

  it('returns original result when non-null', () => {
    const mockBot = makeMockBot(() => ({ type: 1, name: 'stone', boundingBox: 'block' }));

    const { uninstall, stats } = installPatchedBlockAt(mockBot, store);
    const result = mockBot.blockAt({ x: 0, y: 0, z: 0 });
    assert.equal((result as { name: string }).name, 'stone');
    assert.equal(stats.memoryHits, 0);
    uninstall();
  });

  it('falls back to memory when original returns null', () => {
    store.upsertBatch([makeBlock(10, 64, 10, 'oak_planks')]);

    const mockBot = makeMockBot(() => null);

    const { uninstall, stats } = installPatchedBlockAt(mockBot, store);
    const result = mockBot.blockAt({ x: 10, y: 64, z: 10 });

    assert.notEqual(result, null);
    assert.equal(result.name, 'oak_planks');
    assert.equal(stats.memoryHits, 1);
    uninstall();
  });

  it('returns null when both original and memory have nothing', () => {
    const mockBot = makeMockBot(() => null);

    const { uninstall, stats } = installPatchedBlockAt(mockBot, store);
    const result = mockBot.blockAt({ x: 99, y: 99, z: 99 });

    assert.equal(result, null);
    assert.equal(stats.memoryMisses, 1);
    uninstall();
  });

  it('uninstall restores original behavior', () => {
    const originalFn = spy(() => null);
    const mockBot = {
      blockAt: originalFn,
      registry: { blocksByName: {} },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    const { uninstall } = installPatchedBlockAt(mockBot, store);
    uninstall();

    // After uninstall, blockAt should be back to original
    mockBot.blockAt({ x: 0, y: 0, z: 0 });
    assert.ok(originalFn.calls.length > 0);
  });
});

// ── WorldMapCollector ────────────────────────────────────

describe('WorldMapCollector', () => {
  let store: WorldMapStoreImpl;
  let dbPath: string;

  beforeEach(() => {
    dbPath = tempDbPath();
    store = new WorldMapStoreImpl(dbPath);
  });

  afterEach(() => {
    store.close();
    try { fs.rmSync(path.dirname(dbPath), { recursive: true }); } catch { /* 临时目录已清 */ }
  });

  it('skips scan when displacement < threshold', () => {
    const game = {
      getPosition: spy(() => ({ x: 0, y: 64, z: 0 })),
      getBlockAt: spy(() => ({ name: 'stone', boundingBox: 'block' })),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    const collector = new WorldMapCollectorImpl(game, store, {
      intervalMs: 100000, // won't auto-fire
      scanRadius: 2,
      yRange: 1,
      minDisplacement: 8,
    });

    // First scan should run (no previous center)
    collector.start();
    const stats1 = collector.stats;
    assert.equal(stats1.scansCompleted, 1);

    // Manually trigger — same position, should skip
    (collector as unknown as { scan(): void }).scan();
    const stats2 = collector.stats;
    assert.equal(stats2.scansCompleted, 1); // didn't increment

    collector.stop();
  });

  it('writes blocks to store after scan', () => {
    const game = {
      getPosition: spy(() => ({ x: 0, y: 64, z: 0 })),
      getBlockAt: spy((pos: { y: number }) => {
        if (pos.y === 64) return { name: 'stone', boundingBox: 'block' };
        return { name: 'air', boundingBox: 'empty' }; // air is skipped
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    const collector = new WorldMapCollectorImpl(game, store, {
      intervalMs: 100000,
      scanRadius: 2,
      yRange: 0, // only scan y=64
      minDisplacement: 0, // always scan
    });

    collector.start();
    collector.stop();

    const stats = collector.stats;
    assert.equal(stats.scansCompleted, 1);
    assert.ok(stats.blocksWritten > 0);

    // Verify store has data
    const storeStats = store.getStats();
    assert.ok(storeStats.totalBlocks > 0);
  });
});
