/**
 * 🌍 L2 Capability · WorldScanCapability · 周期世界扫描
 *
 * 正式框架里**唯一**把空间知识沉淀进 Memory 的模块。
 * 区别于 PerceptionPipeline（每 tick 刷、不落盘的瞬时态），
 * WorldScan 以 SLOW 节拍（每 10 tick / ~2s）扫描周围方块与实体，
 * 归一化后写入 Memory.spatial / Memory.objects（write-through 落 SQLite）。
 *
 * 设计原则：
 *   - 单一职责：只做「扫描 → 写 Memory」，不决策、不发事件、不读 Memory
 *   - 去重外包：交给 Memory.record() 内建的 INSERT OR REPLACE 逻辑
 *   - 开销可控：节拍 + 半径 + 数量三重封顶
 *   - 复用优先：实体扫描复用 TickContext.world.entities（Perception 本 tick 已构建）
 */

import type { ITickable, TickContext } from '../infra/tickRegistry.js';
import { TickRate } from '../infra/tickRegistry.js';
import type { GameAdapter } from '../../adapter/GameAdapter.js';
import type { MemoryV2 } from '../infra/memory.js';
import type { SpatialEntry, ObjectEntry } from '../infra/memory.js';
import type { EventBusV2 } from '../infra/eventBus.js';
import { tuning } from '../infra/tuning.js';

// ─────────────────────────────────────────────────────────────────────────────
// 配置
// ─────────────────────────────────────────────────────────────────────────────

export interface WorldScanConfig {
  /** 方块扫描半径（格）· 默认 32 */
  blockScanRadius: number;
  /** 单次方块扫描每类上限 · 默认 16 */
  blockScanCount: number;
  /** 实体记忆的最远距离（格）· 默认 24 */
  entityMemoryRange: number;
  /**
   * 要记忆的方块类型 → spatial.kind 映射
   * key   = mineflayer 方块名（不带 minecraft: 前缀）
   * value = SpatialEntry.kind
   */
  blockKinds: Record<string, SpatialEntry['kind']>;
  /** 地形体积扫描配置（BUG-WEBUI-03 · 体积扫描替代按类型离散采样） */
  terrain?: {
    /** XZ 平面扫描半径（格）· 默认 10 */
    radius: number;
    /** Y 轴扫描半径（格）· 默认 5 */
    radiusY: number;
    /** 是否启用表面剔除（六面全被实心包围 → 不推前端）· 默认 true */
    cullInterior: boolean;
  };
}

export const DEFAULT_WORLD_SCAN_CONFIG: WorldScanConfig = {
  blockScanRadius: 32,
  blockScanCount: 16,
  entityMemoryRange: 24,
  blockKinds: {
    // 箱子类 → 'chest'
    chest: 'chest',
    trapped_chest: 'chest',
    barrel: 'chest',
    // 工作台/熔炉等资源方块 → 'resource'
    furnace: 'resource',
    blast_furnace: 'resource',
    smoker: 'resource',
    crafting_table: 'resource',
    anvil: 'resource',
    chipped_anvil: 'resource',
    damaged_anvil: 'resource',
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// WorldScanCapability
// ─────────────────────────────────────────────────────────────────────────────

/** BUG-WEBUI-03 · 地形方块条目（3D 场景用，仅内存缓存，不写 SQLite） */
export interface TerrainBlockEntry {
  name: string;
  position: { x: number; y: number; z: number };
  /** 是否有暴露面（false = 完全埋在土里，前端可做额外裁剪） */
  exposedAny?: boolean;
  /** 碰撞箱类型：'block'=实心 / 'empty'=可穿过（门/火把/植被等） */
  boundingBox?: 'block' | 'empty';
}

/** 不需要显示的方块名（空气/虚空等） */
const AIR_LIKE = new Set(['air', 'cave_air', 'void_air']);

export class WorldScanCapability implements ITickable {
  readonly id = 'world_scan';
  readonly rate = TickRate.SLOW; // 每 10 tick / ~2s

  /** BUG-WEBUI-02 · 地形方块内存缓存（SLOW 节拍刷新，不持久化） */
  private terrainCache: TerrainBlockEntry[] = [];

  /** FEAT-MEM-06 · 箱子索引订阅句柄（bus.onAny 等） */
  private chestIndexUnsubs: Array<() => void> = [];

  constructor(
    private readonly game: GameAdapter,
    private readonly memory: MemoryV2,
    private readonly cfg: WorldScanConfig = DEFAULT_WORLD_SCAN_CONFIG,
    /** 可选 · 传入 bus 后启用 FEAT-MEM-06 箱子内容索引 */
    bus?: EventBusV2,
  ) {
    if (bus) this.attachChestIndex(bus);
  }

  /**
   * FEAT-MEM-06 · 订阅 atomic.deposit.success / atomic.withdraw.success
   * 关闭箱子时 atomic 把 contents 透传到 payload，本方法把它写进 spatial.meta.items。
   */
  private attachChestIndex(bus: EventBusV2): void {
    const onChest = (kind: 'deposit' | 'withdraw') => (ev: { payload: unknown }) => {
      const p = ev.payload as { pos?: { x: number; y: number; z: number }; contents?: string[] };
      if (!p?.pos || !Array.isArray(p.contents)) return;
      try {
        this.memory.indexChest(p.pos, p.contents);
      } catch (err) {
        // 索引失败不影响主流程
        console.error(`[WorldScan] chest_index ${kind} failed:`, err);
      }
    };
    this.chestIndexUnsubs.push(bus.on('atomic.deposit.success', onChest('deposit')));
    this.chestIndexUnsubs.push(bus.on('atomic.withdraw.success', onChest('withdraw')));
  }

  /** 停止订阅 · 测试 / shutdown 用 */
  detachChestIndex(): void {
    for (const u of this.chestIndexUnsubs) try { u(); } catch { /* ignore */ }
    this.chestIndexUnsubs = [];
  }

  /**
   * Heartbeat 按 SLOW 节拍调用
   * ① 扫方块 → record('spatial')
   * ② 扫实体 → record('object')
   * ③ 扫地形 → terrainCache（仅内存，3D 场景用）
   */
  onTick(ctx: TickContext): void {
    this.scanBlocks(ctx.tick);
    this.scanEntities(ctx);
    this.scanTerrain();
  }

  /**
   * BUG-WEBUI-02 · 返回最新地形方块缓存（供 buildWorldUiView 拼 blocks[]）。
   * SLOW 节拍（~2s）刷新，初始返回空数组。
   */
  getNearbyTerrainBlocks(): TerrainBlockEntry[] {
    return this.terrainCache;
  }

  // ─── ① 方块扫描 ────────────────────────────────────────────────────────────

  private scanBlocks(tick: number): void {
    // BUG-L5-03 · 一次合并扫描所有目标方块，而不是每种类型各扫一次 r 体积。
    //   旧实现：N 种方块 × findBlocks(r32) → 身边没有的稀有类型(砧/木桶/烟熏炉)
    //   被迫各自全量扫 ~27 万坐标，且每个坐标走 patched blockAt（构造 Block + 查 DB）
    //   → 主进程事件循环单次卡 7-11s（soak 实测 81% 时间 UI 冻结）。
    //   新实现：matching 多 id 一次体积遍历，命中 count 个即提前终止；半径/数量走 tuning 可热调。
    const names = Object.keys(this.cfg.blockKinds);
    if (names.length === 0) return;

    const { blockScanRadius, blockScanCount } = tuning().worldScan;
    let positions: { x: number; y: number; z: number }[];
    try {
      positions = this.game.findBlocks({
        names, // 全部种类一次传入 → 单次 findBlocks（matching: 多 id）
        maxDistance: blockScanRadius,
        count: blockScanCount,
      });
    } catch {
      // findBlocks 在区块未加载时可能抛异常，安全跳过
      return;
    }

    for (const pos of positions) {
      // findBlocks 只回坐标 → 仅对命中的少量方块读真名归类（开销可忽略）
      let blockName: string | undefined;
      try {
        blockName = this.game.getBlockAt(pos)?.name;
      } catch {
        // getBlockAt 在 chunk 边界可能抛 → 跳过该坐标
        continue;
      }
      if (!blockName) continue;
      const kind = this.cfg.blockKinds[blockName];
      if (!kind) continue;
      const entry: SpatialEntry = {
        kind,
        position: pos,
        meta: { blockName, scannedAt: tick },
        timestamp: Date.now(),
      };
      this.memory.record('spatial', entry);
    }
  }

  // ─── ③ 地形体积扫描（BUG-WEBUI-03 · 替代旧的按类型离散采样）────────────────

  private scanTerrain(): void {
    const terrainCfg = this.cfg.terrain;
    const radius = terrainCfg?.radius ?? 8;
    const radiusY = terrainCfg?.radiusY ?? 5;
    const cullInterior = terrainCfg?.cullInterior ?? true;

    const pos = this.game.getPosition();
    const cx = Math.floor(pos.x);
    const cy = Math.floor(pos.y);
    const cz = Math.floor(pos.z);

    // BUG-L5-03 · 单遍把整个体积读进本地 Map（每坐标仅 1 次 getBlockAt）。
    //   旧实现 cullInterior 又对每个实心块的 6 个邻居各调一次 getBlockAt（patched，含构造
    //   Block + 查 DB），地下场景放大到 ~7×（≈4851 → ≈34000 次/tick），是剩余 300-600ms 卡顿主因。
    //   现在邻居判定直接查本地 Map，零额外 getBlockAt。
    const key = (x: number, y: number, z: number) => `${x}:${y}:${z}`;
    const vol = new Map<string, { name: string; bb?: string; x: number; y: number; z: number }>();
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dz = -radius; dz <= radius; dz++) {
        for (let dy = -radiusY; dy <= radiusY; dy++) {
          const x = cx + dx, y = cy + dy, z = cz + dz;
          try {
            const b = this.game.getBlockAt({ x, y, z });
            if (b) vol.set(key(x, y, z), { name: b.name, bb: b.boundingBox, x, y, z });
          } catch {
            // chunk 未加载 → 该格缺失（邻居判定时算「有暴露面」，保守保留）
          }
        }
      }
    }

    // 表面剔除：六面邻居全是「本地 Map 内的实心满块」才算被完全包围 → 跳过。
    // 邻居缺失（体积外 / air / 未加载）= 有暴露面 → 保留。
    const isSolid = (e?: { name: string; bb?: string }) =>
      !!e && !AIR_LIKE.has(e.name) && e.bb !== 'empty';

    const collected: TerrainBlockEntry[] = [];
    for (const b of vol.values()) {
      if (AIR_LIKE.has(b.name)) continue;
      if (cullInterior) {
        const surrounded =
          isSolid(vol.get(key(b.x + 1, b.y, b.z))) && isSolid(vol.get(key(b.x - 1, b.y, b.z))) &&
          isSolid(vol.get(key(b.x, b.y + 1, b.z))) && isSolid(vol.get(key(b.x, b.y - 1, b.z))) &&
          isSolid(vol.get(key(b.x, b.y, b.z + 1))) && isSolid(vol.get(key(b.x, b.y, b.z - 1)));
        if (surrounded) continue;
      }
      collected.push({
        name: b.name,
        position: { x: b.x, y: b.y, z: b.z },
        exposedAny: true,
        boundingBox: (b.bb as 'block' | 'empty') ?? 'block',
      });
    }

    this.terrainCache = collected;
  }

  // ─── ② 实体扫描 ────────────────────────────────────────────────────────────

  private scanEntities(ctx: TickContext): void {
    if (!ctx.world) return;

    for (const e of ctx.world.entities) {
      // 超出记忆距离 → 跳过
      if (e.distance > this.cfg.entityMemoryRange) continue;
      // 玩家不进 object 记忆（隐私 + 无意义）
      if (e.category === 'player') continue;

      const entry: ObjectEntry = {
        kind: e.category,          // 'hostile' | 'passive' | 'other'
        name: e.name,
        position: e.position,
        meta: { entityId: e.id },
        timestamp: Date.now(),
      };
      this.memory.record('object', entry);
    }
  }
}
