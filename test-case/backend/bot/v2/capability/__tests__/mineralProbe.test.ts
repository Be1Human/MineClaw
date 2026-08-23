/**
 * MineralProbeCapability 单元测试（FEAT-L2-02）
 *
 * AC1 · diamond_ore → spatial 新增 meta.mineralType='diamond'
 * AC2 · 重复扫同坐标 → 仍 1 行（Memory 内建去重）
 * AC3 · deepslate_iron_ore 也被识别 → mineralType='iron'
 * AC4 · 非矿物方块（stone）→ 不进矿物条目
 * AC5 · find_mineral({type:'iron'}) 工具调用 → 按距离升序返回
 * AC6 · find_mineral 未传 type → ok:false
 * AC7 · 与 WorldScanCapability 共存 → 写 chest 不污染矿物条目
 * AC8 · findBlocks 抛异常 → 安全跳过，不影响其他类
 * AC9 · getBlockAt 抛异常 → 用 blockNames[0] 兜底，记录仍正常
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  MineralProbeCapability,
  DEFAULT_MINERAL_PROBE_CONFIG,
  type MineralType,
} from '../../../../../../apps/minecraft-companion/src/bot/v2/capability/mineralProbeCapability.js';
import { WorldScanCapability } from '../../../../../../apps/minecraft-companion/src/bot/v2/capability/worldScanCapability.js';
import { MemoryV2 } from '../../../../../../apps/minecraft-companion/src/bot/v2/infra/memory.js';
import type { GameAdapter } from '../../../../../../apps/minecraft-companion/src/bot/adapter/GameAdapter.js';
import type { FindBlocksOptions } from '../../../../../../apps/minecraft-companion/src/bot/adapter/types.js';
import { TickRate } from '../../../../../../apps/minecraft-companion/src/bot/v2/infra/tickRegistry.js';
import type { TickContext } from '../../../../../../apps/minecraft-companion/src/bot/v2/infra/tickRegistry.js';
import type { WorldStateView } from '../../../../../../apps/minecraft-companion/src/bot/v2/types.js';

// ── helpers ───────────────────────────────────────────────────────────────────

function makeMemory(): MemoryV2 {
  return new MemoryV2(':memory:');
}

interface BlockStub {
  name: string;
  boundingBox?: string;
}

/**
 * 构造一个游戏 adapter stub
 * @param blockMap  blockName → 该方块的 (x,y,z) 列表
 */
function makeGame(blockMap: Record<string, Array<{ x: number; y: number; z: number }>>): GameAdapter {
  // 也用同一个 blockMap 提供 getBlockAt 的反查
  const posToName = new Map<string, string>();
  for (const [name, list] of Object.entries(blockMap)) {
    for (const p of list) posToName.set(`${p.x}:${p.y}:${p.z}`, name);
  }
  return {
    findBlocks: (opts: FindBlocksOptions) => {
      const names = Array.isArray(opts.names) ? opts.names : [opts.names];
      const out: Array<{ x: number; y: number; z: number }> = [];
      for (const n of names) {
        const list = blockMap[n] ?? [];
        out.push(...list);
        if (typeof opts.count === 'number' && out.length >= opts.count) break;
      }
      return out;
    },
    getPosition: () => ({ x: 0, y: 64, z: 0 }),
    getBlockAt: (pos: { x: number; y: number; z: number }): BlockStub | null => {
      const name = posToName.get(`${pos.x}:${pos.y}:${pos.z}`);
      return name ? { name, boundingBox: 'block' } : null;
    },
  } as unknown as GameAdapter;
}

function makeCtx(tick = 1): TickContext {
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
    entities: [],
    inventory: { items: [], held: null, freeSlots: 36 },
    taskContext: null,
  };
  return { tick, rate: TickRate.SLOW, world };
}

// ── 模拟一个最小 find_mineral dispatcher 调用（与真实 dispatcher.ts 内逻辑一致）──
//   单独跑测时不拉起整个 ToolDispatcher，避免无关依赖耦合。
function callFindMineral(
  memory: MemoryV2,
  here: { x: number; y: number; z: number },
  input: { type?: string },
): { ok: boolean; error?: string; mineral?: string; count?: number; minerals?: unknown[] } {
  const type = input.type;
  if (!type) return { ok: false, error: 'type_required' };
  const all = memory.query('spatial', { kind: 'resource' });
  const list = all
    .filter(e => (e.meta?.mineralType as string | undefined) === type)
    .map(e => {
      const dx = here.x - e.position.x,
        dy = here.y - e.position.y,
        dz = here.z - e.position.z;
      return {
        position: e.position,
        distance: Math.round(Math.sqrt(dx * dx + dy * dy + dz * dz)),
        blockName: (e.meta?.blockName as string | undefined) ?? null,
        scannedAt: (e.meta?.scannedAt as number | undefined) ?? null,
      };
    })
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 20);
  return { ok: true, mineral: type, count: list.length, minerals: list };
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('MineralProbeCapability', () => {
  it('AC1 · diamond_ore → spatial 新增 meta.mineralType="diamond"', () => {
    const mem = makeMemory();
    const cap = new MineralProbeCapability(
      makeGame({ diamond_ore: [{ x: 10, y: 12, z: 5 }] }),
      mem,
    );
    cap.onTick(makeCtx());

    const results = mem.query('spatial', { kind: 'resource' });
    assert.equal(results.length, 1);
    assert.deepEqual(results[0].position, { x: 10, y: 12, z: 5 });
    assert.equal(results[0].meta?.mineralType, 'diamond');
    assert.equal(results[0].meta?.blockName, 'diamond_ore');
    assert.equal(results[0].meta?.scannedAt, 1);
  });

  it('AC2 · 重复扫同坐标 → 仍 1 行', () => {
    const mem = makeMemory();
    const cap = new MineralProbeCapability(
      makeGame({ iron_ore: [{ x: 5, y: 30, z: 5 }] }),
      mem,
    );
    cap.onTick(makeCtx(1));
    cap.onTick(makeCtx(2));

    const results = mem.query('spatial', { kind: 'resource' });
    assert.equal(results.length, 1);
    assert.equal(results[0].meta?.scannedAt, 2); // 最新 tick 覆盖
  });

  it('AC3 · deepslate_iron_ore 也被识别 → mineralType="iron"', () => {
    const mem = makeMemory();
    const cap = new MineralProbeCapability(
      makeGame({ deepslate_iron_ore: [{ x: 8, y: -10, z: 4 }] }),
      mem,
    );
    cap.onTick(makeCtx());

    const results = mem.query('spatial', { kind: 'resource' });
    assert.equal(results.length, 1);
    assert.equal(results[0].meta?.mineralType, 'iron');
    assert.equal(results[0].meta?.blockName, 'deepslate_iron_ore');
  });

  it('AC4 · 非矿物方块（stone）→ 不进矿物条目', () => {
    const mem = makeMemory();
    const cap = new MineralProbeCapability(
      makeGame({ stone: [{ x: 1, y: 1, z: 1 }] }),
      mem,
    );
    cap.onTick(makeCtx());

    assert.equal(mem.query('spatial', { kind: 'resource' }).length, 0);
  });

  it('AC5 · find_mineral({type:"iron"}) 按距离升序返回', () => {
    const mem = makeMemory();
    const cap = new MineralProbeCapability(
      makeGame({
        iron_ore: [
          { x: 20, y: 64, z: 0 }, // distance 20
          { x: 5, y: 64, z: 0 },  // distance 5
          { x: 10, y: 64, z: 0 }, // distance 10
        ],
      }),
      mem,
    );
    cap.onTick(makeCtx());

    const r = callFindMineral(mem, { x: 0, y: 64, z: 0 }, { type: 'iron' });
    assert.equal(r.ok, true);
    assert.equal(r.count, 3);
    const minerals = r.minerals as Array<{ distance: number }>;
    assert.equal(minerals[0].distance, 5);
    assert.equal(minerals[1].distance, 10);
    assert.equal(minerals[2].distance, 20);
  });

  it('AC6 · find_mineral 未传 type → ok:false', () => {
    const mem = makeMemory();
    const r = callFindMineral(mem, { x: 0, y: 64, z: 0 }, {});
    assert.equal(r.ok, false);
    assert.equal(r.error, 'type_required');
  });

  it('AC7 · 与 WorldScan 共存 → chest（不同坐标）不污染矿物条目', () => {
    const mem = makeMemory();
    // 两者同 memory · 不同坐标 · 互不覆盖
    const game = makeGame({
      chest: [{ x: 100, y: 64, z: 100 }],
      gold_ore: [{ x: 5, y: 12, z: 5 }],
    });
    const ws = new WorldScanCapability(game, mem);
    const mpc = new MineralProbeCapability(game, mem);
    ws.onTick(makeCtx());
    mpc.onTick(makeCtx());

    const all = mem.query('spatial');
    // 1 个 chest + 1 个 gold + 可能 WorldScan 在 terrain 扫描里多余的 // 但 chest filter:
    const chests = mem.query('spatial', { kind: 'chest' });
    const resources = mem.query('spatial', { kind: 'resource' });
    assert.equal(chests.length, 1);
    // 矿物条目至少 1 个（WorldScan 默认 blockKinds 不含 gold_ore，所以只有 MineralProbe 写入）
    assert.ok(resources.some(e => e.meta?.mineralType === 'gold'));
    // 整体数据互不破坏
    assert.ok(all.length >= 2);
  });

  // BUG-L5-03 · 新契约：一次合并 findBlocks（不再每矿种各扫一次）。
  it('AC8 · 合并 findBlocks 抛异常 → 整轮安全跳过，不崩溃', () => {
    const mem = makeMemory();
    const game = {
      findBlocks: (_opts: FindBlocksOptions) => { throw new Error('chunk_not_loaded'); },
      getPosition: () => ({ x: 0, y: 64, z: 0 }),
      getBlockAt: () => ({ name: 'iron_ore', boundingBox: 'block' }),
    } as unknown as GameAdapter;

    const cap = new MineralProbeCapability(game, mem);
    assert.doesNotThrow(() => cap.onTick(makeCtx()));
    assert.equal(mem.query('spatial', { kind: 'resource' }).length, 0);
  });

  // BUG-L5-03 · 新契约：getBlockAt 抛异常仅跳过该坐标，其余命中点正常归类。
  it('AC9 · 某坐标 getBlockAt 抛异常 → 仅跳过该点，不影响其他点', () => {
    const mem = makeMemory();
    const bad = { x: 1, y: 1, z: 1 };
    const good = { x: 5, y: 30, z: 0 };
    const game = {
      findBlocks: (_opts: FindBlocksOptions) => [bad, good],
      getPosition: () => ({ x: 0, y: 64, z: 0 }),
      getBlockAt: (pos: { x: number; y: number; z: number }) => {
        if (pos.x === bad.x && pos.y === bad.y && pos.z === bad.z) throw new Error('chunk_unavailable');
        return { name: 'iron_ore', boundingBox: 'block' };
      },
    } as unknown as GameAdapter;

    const cap = new MineralProbeCapability(game, mem);
    assert.doesNotThrow(() => cap.onTick(makeCtx()));

    const r = mem.query('spatial', { kind: 'resource' });
    assert.equal(r.length, 1); // 抛异常的 bad 点被跳过，good 点正常记录
    assert.equal(r[0].meta?.mineralType, 'iron');
    assert.equal(r[0].meta?.blockName, 'iron_ore');
  });

  it('AC10 · 自定义空 blockToMineral → 不写入任何条目', () => {
    const mem = makeMemory();
    const cap = new MineralProbeCapability(
      makeGame({ diamond_ore: [{ x: 1, y: 1, z: 1 }] }),
      mem,
      { ...DEFAULT_MINERAL_PROBE_CONFIG, blockToMineral: {} },
    );
    cap.onTick(makeCtx());

    assert.equal(mem.query('spatial', { kind: 'resource' }).length, 0);
  });

  it('AC11 · 多类矿物同时存在 · 各自独立写入', () => {
    const mem = makeMemory();
    const cap = new MineralProbeCapability(
      makeGame({
        diamond_ore: [{ x: 1, y: 12, z: 1 }],
        iron_ore: [{ x: 5, y: 30, z: 5 }],
        coal_ore: [{ x: 10, y: 40, z: 10 }],
      }),
      mem,
    );
    cap.onTick(makeCtx());

    const r = mem.query('spatial', { kind: 'resource' });
    const types = new Set(r.map(e => e.meta?.mineralType as string));
    assert.ok(types.has('diamond'));
    assert.ok(types.has('iron'));
    assert.ok(types.has('coal'));
    assert.equal(r.length, 3);
  });

  it('AC12 · ITickable 接口契约 · id="mineral_probe" · rate=SLOW', () => {
    const mem = makeMemory();
    const cap = new MineralProbeCapability(makeGame({}), mem);
    assert.equal(cap.id, 'mineral_probe');
    assert.equal(cap.rate, TickRate.SLOW);
  });
});
