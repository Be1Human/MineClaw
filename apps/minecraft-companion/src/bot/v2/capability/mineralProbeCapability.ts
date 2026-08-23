/**
 * ⛏ L2 Capability · MineralProbeCapability · 矿物探测与定向挖矿（FEAT-L2-02）
 *
 * 与 WorldScanCapability 并列的第 2 个 L2 独立能力类。
 * 专门把「矿物方块」按 SLOW 节拍沉淀进 Memory.spatial（kind='resource'），
 * 在 meta 上挂语义化的 mineralType（diamond/iron/gold/...），
 * 暴露给 L7 LLM 工具 find_mineral 直接查询。
 *
 * 与 WorldScanCapability 的边界：
 *   - WorldScan 写 kind=resource 时只用 meta.blockName（不含 mineralType）→ 工作站类
 *   - MineralProbe 写 kind=resource 时 meta 必含 mineralType        → 矿物类
 *   - 查询时 dispatcher.find_mineral 只看 meta.mineralType，互不覆盖（去重键不同）
 *     · 去重键 = kind:x:y:z；普通方块和矿物方块坐标不重合，天然零冲突
 *
 * 设计原则：
 *   - 单一职责：只做「扫矿 → 写 Memory」，不查/不决策/不发事件
 *   - 去重外包：交给 Memory.record() 内建的 INSERT OR REPLACE 逻辑
 *   - 开销可控：SLOW 节拍 + 半径 + 数量三重封顶
 *   - 零污染：不改 WorldScan / spatial.kind 枚举 / SQLite schema
 */

import type { ITickable, TickContext } from '../infra/tickRegistry.js';
import { TickRate } from '../infra/tickRegistry.js';
import type { GameAdapter } from '../../adapter/GameAdapter.js';
import type { MemoryV2, SpatialEntry } from '../infra/memory.js';
import { tuning } from '../infra/tuning.js';

// ─────────────────────────────────────────────────────────────────────────────
// 类型 & 配置
// ─────────────────────────────────────────────────────────────────────────────

/** 矿物语义类型（白名单 key · LLM 直接用这些字符串调 find_mineral） */
export type MineralType =
  | 'diamond'
  | 'iron'
  | 'gold'
  | 'copper'
  | 'coal'
  | 'redstone'
  | 'lapis'
  | 'emerald'
  | 'netherite';

export interface MineralProbeConfig {
  /** 扫描半径（格）· 默认 32 */
  scanRadius: number;
  /** 每类矿物单次扫描上限 · 默认 16 */
  scanCountPerKind: number;
  /**
   * blockName → mineralType 映射（含 deepslate / nether 变体）
   * key   = mineflayer 方块名（无 minecraft: 前缀）
   * value = MineralType（白名单）
   */
  blockToMineral: Record<string, MineralType>;
}

export const DEFAULT_MINERAL_PROBE_CONFIG: MineralProbeConfig = {
  scanRadius: 32,
  scanCountPerKind: 16,
  blockToMineral: {
    // 钻石
    diamond_ore: 'diamond',
    deepslate_diamond_ore: 'diamond',
    // 铁
    iron_ore: 'iron',
    deepslate_iron_ore: 'iron',
    // 金
    gold_ore: 'gold',
    deepslate_gold_ore: 'gold',
    nether_gold_ore: 'gold',
    // 铜
    copper_ore: 'copper',
    deepslate_copper_ore: 'copper',
    // 煤
    coal_ore: 'coal',
    deepslate_coal_ore: 'coal',
    // 红石
    redstone_ore: 'redstone',
    deepslate_redstone_ore: 'redstone',
    // 青金石
    lapis_ore: 'lapis',
    deepslate_lapis_ore: 'lapis',
    // 绿宝石
    emerald_ore: 'emerald',
    deepslate_emerald_ore: 'emerald',
    // 下界合金
    ancient_debris: 'netherite',
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// MineralProbeCapability
// ─────────────────────────────────────────────────────────────────────────────

export class MineralProbeCapability implements ITickable {
  readonly id = 'mineral_probe';
  readonly rate = TickRate.SLOW;

  constructor(
    private readonly game: GameAdapter,
    private readonly memory: MemoryV2,
    private readonly cfg: MineralProbeConfig = DEFAULT_MINERAL_PROBE_CONFIG,
  ) {}

  /**
   * Heartbeat 按 SLOW 节拍调用
   * ① 按 mineralType 分组，一类一类调 findBlocks
   * ② 反查具体 blockName（普通 / deepslate / nether 变体）
   * ③ 归一化为 SpatialEntry，meta 必含 mineralType，写 Memory.spatial
   */
  onTick(ctx: TickContext): void {
    // BUG-L5-03 · 一次合并扫描所有矿物方块，而不是每个矿种各扫一次 r 体积。
    //   旧实现：~10 个矿种分组 × findBlocks(r32)，钻石/绿宝石等极稀有 → 每组全量扫 ~27 万坐标
    //   （且每坐标走 patched blockAt），与 WorldScan 叠加把主进程事件循环卡 7-11s。
    //   新实现：所有矿物名一次 matching → 命中即停；读真名反查 mineralType；半径/数量走 tuning。
    const allNames = Object.keys(this.cfg.blockToMineral);
    if (allNames.length === 0) return;

    const { mineralScanRadius, mineralScanCount } = tuning().worldScan;
    let positions: Array<{ x: number; y: number; z: number }>;
    try {
      positions = this.game.findBlocks({
        names: allNames, // 全部矿物名一次传入 → 单次 findBlocks
        maxDistance: mineralScanRadius,
        count: mineralScanCount,
      });
    } catch {
      // findBlocks 在 chunk 未加载时可能抛异常，安全跳过
      return;
    }

    for (const pos of positions) {
      // 反查真实 blockName → mineralType（getBlockAt 仅对命中的少量坐标调，开销可忽略）
      let blockName: string | undefined;
      try {
        blockName = this.game.getBlockAt(pos)?.name;
      } catch {
        // getBlockAt 在 chunk 边界可能抛 → 跳过该坐标，不影响其他命中点
        continue;
      }
      if (!blockName) continue;
      const mineralType = this.cfg.blockToMineral[blockName];
      if (!mineralType) continue;

      const entry: SpatialEntry = {
        kind: 'resource',
        position: pos,
        meta: { mineralType, blockName, scannedAt: ctx.tick },
        timestamp: Date.now(),
      };
      this.memory.record('spatial', entry);
    }
  }
}
