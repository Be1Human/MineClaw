/**
 * WorldScanCapability 单元测试
 *
 * AC1 · 扫到箱子 → spatial 写入
 * AC2 · 重复扫同一箱子 → 仍 1 行（Memory 内建去重）
 * AC3 · ChestMemoryProvider 串联 · query spatial chest 非空
 * AC4 · 超出 entityMemoryRange 的实体不进 objects
 * AC5 · category=player 的实体不进 objects
 * AC6 · ctx.world=null 时安全跳过
 * AC7 · 近距离非 player 实体写入 objects
 * AC8 · trapped_chest 映射为 kind=chest
 * AC9 · 自定义空 blockKinds → spatial 无写入
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  WorldScanCapability,
  DEFAULT_WORLD_SCAN_CONFIG,
} from '../../../../../../apps/minecraft-companion/src/bot/v2/capability/worldScanCapability.js';
import { MemoryV2 } from '../../../../../../apps/minecraft-companion/src/bot/v2/infra/memory.js';
import { EventBusV2 } from '../../../../../../apps/minecraft-companion/src/bot/v2/infra/eventBus.js';
import type { GameAdapter } from '../../../../../../apps/minecraft-companion/src/bot/adapter/GameAdapter.js';
import type { FindBlocksOptions } from '../../../../../../apps/minecraft-companion/src/bot/adapter/types.js';
import { TickRate } from '../../../../../../apps/minecraft-companion/src/bot/v2/infra/tickRegistry.js';
import type { TickContext } from '../../../../../../apps/minecraft-companion/src/bot/v2/infra/tickRegistry.js';
import type { EntityView, WorldStateView } from '../../../../../../apps/minecraft-companion/src/bot/v2/types.js';

// ── helpers ───────────────────────────────────────────────────────────────────

function makeMemory(): MemoryV2 {
  return new MemoryV2(':memory:');
}

// BUG-L5-03 · scanBlocks 改为「一次合并 findBlocks（matching 多 id）+ getBlockAt 归类」，
// 故 mock 需：findBlocks 命中任一目标名即返回坐标；getBlockAt 按坐标回真实方块名供归类。
function makeGame(
  blockPositions: { x: number; y: number; z: number }[] = [],
  blockName = 'chest',
): GameAdapter {
  const key = (p: { x: number; y: number; z: number }) => `${p.x}:${p.y}:${p.z}`;
  const nameByPos = new Map(blockPositions.map((p) => [key(p), blockName]));
  return {
    findBlocks: (opts: FindBlocksOptions) => {
      const names = Array.isArray(opts.names) ? opts.names : [opts.names];
      return names.includes(blockName) ? blockPositions : [];
    },
    getPosition: () => ({ x: 0, y: 64, z: 0 }),
    getBlockAt: (pos: { x: number; y: number; z: number }) => {
      const n = nameByPos.get(key(pos));
      return n ? { name: n, position: pos, boundingBox: 'block' as const } : null;
    },
  } as unknown as GameAdapter;
}

function makeCtx(entities: EntityView[] = [], tick = 1): TickContext {
  const world: WorldStateView = {
    tick,
    timestamp: Date.now(),
    self: {
      position: { x: 0, y: 64, z: 0 },
      health: 20,
      maxHealth: 20,
      food: 20,
      yaw: 0,
      pitch: 0,
      isOnGround: true,
    },
    owner: null,
    environment: {
      dimension: 'overworld',
      timeOfDay: 6000,
      isDay: true,
      isRaining: false,
    },
    entities,
    inventory: { items: [], held: null, freeSlots: 36 },
    taskContext: null,
  };
  return { tick, rate: TickRate.SLOW, world };
}

function makeEntity(overrides: Partial<EntityView> = {}): EntityView {
  return {
    id: 1,
    name: 'zombie',
    type: 'mob',
    position: { x: 5, y: 64, z: 5 },
    distance: 10,
    category: 'hostile',
    ...overrides,
  };
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('WorldScanCapability', () => {
  it('AC1 · 扫到箱子 → spatial 写入', () => {
    const mem = makeMemory();
    const cap = new WorldScanCapability(
      makeGame([{ x: 10, y: 64, z: 20 }]),
      mem,
    );
    cap.onTick(makeCtx());

    const results = mem.query('spatial', { kind: 'chest' });
    assert.equal(results.length, 1);
    assert.deepEqual(results[0].position, { x: 10, y: 64, z: 20 });
    assert.equal(results[0].kind, 'chest');
  });

  it('AC2 · 重复扫同一箱子 → 仍 1 行', () => {
    const mem = makeMemory();
    const cap = new WorldScanCapability(
      makeGame([{ x: 10, y: 64, z: 20 }]),
      mem,
    );
    cap.onTick(makeCtx([], 1));
    cap.onTick(makeCtx([], 2));

    assert.equal(mem.query('spatial', { kind: 'chest' }).length, 1);
  });

  it('AC3 · ChestMemoryProvider 串联 · spatial chest 可查', () => {
    const mem = makeMemory();
    const cap = new WorldScanCapability(
      makeGame([{ x: 5, y: 64, z: 5 }]),
      mem,
    );
    cap.onTick(makeCtx());

    const chests = mem.query('spatial', { kind: 'chest' });
    assert.ok(chests.length > 0);
    assert.equal(chests[0].kind, 'chest');
  });

  it('AC4 · 距离超出 entityMemoryRange(24) 的实体不记录', () => {
    const mem = makeMemory();
    const cap = new WorldScanCapability(makeGame(), mem);
    cap.onTick(makeCtx([makeEntity({ distance: 30 })]));

    assert.equal(mem.query('object').length, 0);
  });

  it('AC5 · category=player 的实体不进 objects', () => {
    const mem = makeMemory();
    const cap = new WorldScanCapability(makeGame(), mem);
    cap.onTick(
      makeCtx([makeEntity({ category: 'player', name: 'qxy', distance: 5 })]),
    );

    assert.equal(mem.query('object').length, 0);
  });

  it('AC6 · ctx.world=null 时不抛出', () => {
    const mem = makeMemory();
    const cap = new WorldScanCapability(makeGame(), mem);
    const ctx: TickContext = { tick: 1, rate: TickRate.SLOW, world: null };

    assert.doesNotThrow(() => cap.onTick(ctx));
  });

  it('AC7 · 近距离 hostile 实体写入 objects', () => {
    const mem = makeMemory();
    const cap = new WorldScanCapability(makeGame(), mem);
    cap.onTick(makeCtx([makeEntity({ name: 'zombie', category: 'hostile', distance: 10 })]));

    const objects = mem.query('object');
    assert.equal(objects.length, 1);
    assert.equal(objects[0].kind, 'hostile');
    assert.equal(objects[0].name, 'zombie');
  });

  it('AC8 · trapped_chest 映射为 kind=chest', () => {
    const mem = makeMemory();
    const cap = new WorldScanCapability(makeGame([{ x: 1, y: 64, z: 1 }], 'trapped_chest'), mem);
    cap.onTick(makeCtx());

    const results = mem.query('spatial', { kind: 'chest' });
    assert.equal(results.length, 1);
  });

  it('AC9 · 自定义空 blockKinds → spatial 无写入', () => {
    const mem = makeMemory();
    const cap = new WorldScanCapability(makeGame([{ x: 0, y: 64, z: 0 }]), mem, {
      ...DEFAULT_WORLD_SCAN_CONFIG,
      blockKinds: {},
    });
    cap.onTick(makeCtx());

    assert.equal(mem.query('spatial').length, 0);
  });

  // ── BUG-WEBUI-03 · 地形体积扫描测试 ─────────────────────────────────────────

  it('AC10 · 体积扫描返回连续方块（非离散采样）', () => {
    const mem = makeMemory();
    // 模拟 bot 周围 3×3×3 全石头（除 bot 所在格为 air）
    const game = {
      findBlocks: () => [],
      getPosition: () => ({ x: 0, y: 64, z: 0 }),
      getBlockAt: (pos: { x: number; y: number; z: number }) => {
        if (pos.x === 0 && pos.y === 64 && pos.z === 0) return { name: 'air', boundingBox: 'empty' };
        return { name: 'stone', position: pos, boundingBox: 'block' };
      },
    } as unknown as GameAdapter;
    const cap = new WorldScanCapability(game, mem, {
      ...DEFAULT_WORLD_SCAN_CONFIG,
      terrain: { radius: 1, radiusY: 1, cullInterior: false },
    });
    cap.onTick(makeCtx());

    const terrain = cap.getNearbyTerrainBlocks();
    // 3×3×3=27 格减去 1 格 air = 26
    assert.equal(terrain.length, 26);
    assert.ok(terrain.every(t => t.name === 'stone'));
  });

  it('AC11 · 表面剔除 — 完全被包围的内部方块不进缓存', () => {
    const mem = makeMemory();
    // 5×5×5 石头方块 (center at 0,64,0, radius=2)
    // 外部（|dx|>2 或 |dy|>2 或 |dz|>2）返回 air → 外壳有暴露面
    // 内部 3×3×3 被完全包围 → 应被剔除
    const game = {
      findBlocks: () => [],
      getPosition: () => ({ x: 0, y: 64, z: 0 }),
      getBlockAt: (pos: { x: number; y: number; z: number }) => {
        const dx = Math.abs(pos.x);
        const dy = Math.abs(pos.y - 64);
        const dz = Math.abs(pos.z);
        if (dx <= 2 && dy <= 2 && dz <= 2) {
          return { name: 'stone', boundingBox: 'block' };
        }
        return { name: 'air', boundingBox: 'empty' };
      },
    } as unknown as GameAdapter;
    const cap = new WorldScanCapability(game, mem, {
      ...DEFAULT_WORLD_SCAN_CONFIG,
      terrain: { radius: 2, radiusY: 2, cullInterior: true },
    });
    cap.onTick(makeCtx());

    const terrain = cap.getNearbyTerrainBlocks();
    // 5×5×5=125 全实心，内部 3×3×3=27 被完全包围 → 125-27=98 有暴露面
    assert.equal(terrain.length, 98);
  });

  it('AC12 · 表面剔除 — 有一面暴露的方块保留', () => {
    const mem = makeMemory();
    // 3×3×3 石头，但中心正上方 (0,65,0) 为 air
    const game = {
      findBlocks: () => [],
      getPosition: () => ({ x: 0, y: 64, z: 0 }),
      getBlockAt: (pos: { x: number; y: number; z: number }) => {
        if (pos.x === 0 && pos.y === 65 && pos.z === 0) return { name: 'air', boundingBox: 'empty' };
        return { name: 'stone', boundingBox: 'block' };
      },
    } as unknown as GameAdapter;
    const cap = new WorldScanCapability(game, mem, {
      ...DEFAULT_WORLD_SCAN_CONFIG,
      terrain: { radius: 1, radiusY: 1, cullInterior: true },
    });
    cap.onTick(makeCtx());

    const terrain = cap.getNearbyTerrainBlocks();
    // (0,64,0) 的上方邻居是 air → 暴露 → 应在缓存中
    const center = terrain.find(t => t.position.x === 0 && t.position.y === 64 && t.position.z === 0);
    assert.ok(center, '中心方块应有暴露面并保留在缓存中');
    assert.equal(center!.exposedAny, true);
  });

  it('AC13 · air/cave_air 被过滤', () => {
    const mem = makeMemory();
    const game = {
      findBlocks: () => [],
      getPosition: () => ({ x: 0, y: 64, z: 0 }),
      getBlockAt: (pos: { x: number; y: number; z: number }) => {
        if (pos.y >= 65) return { name: 'air', boundingBox: 'empty' };
        if (pos.y === 63) return { name: 'cave_air', boundingBox: 'empty' };
        return { name: 'stone', boundingBox: 'block' };
      },
    } as unknown as GameAdapter;
    const cap = new WorldScanCapability(game, mem, {
      ...DEFAULT_WORLD_SCAN_CONFIG,
      terrain: { radius: 1, radiusY: 1, cullInterior: false },
    });
    cap.onTick(makeCtx());

    const terrain = cap.getNearbyTerrainBlocks();
    assert.ok(terrain.every(t => t.name !== 'air' && t.name !== 'cave_air'));
  });

  it('AC14 · getBlockAt 返回 null 不崩溃', () => {
    const mem = makeMemory();
    const game = {
      findBlocks: () => [],
      getPosition: () => ({ x: 0, y: 64, z: 0 }),
      getBlockAt: () => null,
    } as unknown as GameAdapter;
    const cap = new WorldScanCapability(game, mem, {
      ...DEFAULT_WORLD_SCAN_CONFIG,
      terrain: { radius: 2, radiusY: 2, cullInterior: true },
    });

    assert.doesNotThrow(() => cap.onTick(makeCtx()));
    assert.equal(cap.getNearbyTerrainBlocks().length, 0);
  });

  // ── FEAT-MEM-06 · 箱子内容索引 ─────────────────────────────────────────
  it('FEAT-MEM-06 ①: deposit.success → memory.indexChest 自动写 items', () => {
    const mem = makeMemory();
    const bus = new EventBusV2();
    new WorldScanCapability(makeGame(), mem, undefined, bus);
    bus.publish('atomic.deposit.success', 'info', {
      source: 'test', item: 'oak_log', moved: 3,
      pos: { x: 100, y: 64, z: 50 },
      contents: ['oak_log', 'stick'],
    });
    const chests = mem.query('spatial', { kind: 'chest' });
    assert.equal(chests.length, 1);
    assert.deepEqual((chests[0].meta?.items as string[]).sort(), ['oak_log', 'stick'].sort());
  });

  it('FEAT-MEM-06 ②: withdraw.success 同样写 items（取后剩余）', () => {
    const mem = makeMemory();
    const bus = new EventBusV2();
    new WorldScanCapability(makeGame(), mem, undefined, bus);
    bus.publish('atomic.withdraw.success', 'info', {
      source: 'test', item: 'iron_pickaxe', moved: 1,
      pos: { x: 1, y: 64, z: 1 },
      contents: ['stone', 'cobblestone'],
    });
    const chests = mem.query('spatial', { kind: 'chest' });
    assert.equal(chests.length, 1);
    assert.deepEqual((chests[0].meta?.items as string[]).sort(), ['cobblestone', 'stone']);
  });

  it('FEAT-MEM-06 ③: 缺 contents 时安全跳过（不崩溃）', () => {
    const mem = makeMemory();
    const bus = new EventBusV2();
    new WorldScanCapability(makeGame(), mem, undefined, bus);
    assert.doesNotThrow(() => {
      bus.publish('atomic.deposit.success', 'info', { source: 'test', item: 'x', moved: 1 });
    });
    // 没有 pos / contents → 不应写 spatial
    assert.equal(mem.query('spatial', { kind: 'chest' }).length, 0);
  });

  it('FEAT-MEM-06 ④: 不传 bus 时不订阅（向后兼容）', () => {
    const mem = makeMemory();
    const bus = new EventBusV2();
    // 不传 bus 给 capability
    new WorldScanCapability(makeGame(), mem);
    bus.publish('atomic.deposit.success', 'info', {
      pos: { x: 0, y: 0, z: 0 }, contents: ['x'],
    });
    assert.equal(mem.query('spatial', { kind: 'chest' }).length, 0);
  });
});
