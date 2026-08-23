/**
 * 🗺 patchedBlockAt — 记忆注入层
 *
 * BUG-L1-03 修复：patch 目标从 GameAdapter.getBlockAt 改为 bot.blockAt
 * FEAT-L1-05 扩展：记忆过期纠错 —— 实地真实 block 与 worldMap 记忆不符时
 *   1) 触发 onBlockChanged 回调（v2Runtime 转发到 EventBus.block_changed）
 *   2) 用真实值反写 worldMap（confidence = 1.0）
 *   3) 不再无脑降权，diff 检测即视为强证据：直接 update 覆盖
 *
 * 职责：monkey-patch bot.blockAt()
 *   - 原始返回 null（chunk 未加载）时：回退查询 WorldMapStore
 *   - 原始返回非 null 时：与记忆 diff 比对 → 不一致则上报 + 覆盖
 *
 * 设计要点：
 * - 打到 bot.blockAt，让 mineflayer-pathfinder 内部 A* 直接受益
 * - MineflayerGameAdapter.getBlockAt 内部调 bot.blockAt，也同步受益（无需额外改动）
 * - diff 检测有降采样：每个坐标 1s 内最多检查一次，避免 pathfinder 每帧打几百次 A*
 * - 返回卸载函数，可随时恢复原始行为
 * - 仅依赖 duck type（BotBlockAtTarget），不 import mineflayer 避免循环依赖
 */

import type { WorldMapStore, StoredBlock } from './worldMapStore.js';

export interface BlockChangedDiff {
  position: { x: number; y: number; z: number };
  /** worldMap 里之前记的方块名 */
  previousBlockName: string;
  /** 实地真实的方块名（air/cave_air 等会原样上报） */
  actualBlockName: string;
  /** 此次 diff 后 worldMap 中的 confidence（更新前的，便于调试） */
  previousConfidence: number;
}

export interface PatchStats {
  memoryHits: number;
  memoryMisses: number;
  /** FEAT-L1-05 · diff 触发次数 */
  diffDetected: number;
  /** FEAT-L1-05 · 反写覆盖次数 */
  memoryRewritten: number;
}

/**
 * bot 的 duck type（mineflayer Bot 的最小子集），避免直接 import mineflayer 类型。
 * 支持真实 Bot 或测试 mock。
 */
export interface BotBlockAtTarget {
  blockAt(pos: { x: number; y: number; z: number }, applyPhysics?: boolean): unknown;
  registry: {
    blocksByName: Record<string, { id: number; displayName?: string; defaultState?: number }>;
  };
}

export interface PatchOptions {
  /**
   * FEAT-L1-05 · diff 检测到记忆与实地不符时的回调。
   * v2Runtime 用它转发到 EventBus.block_changed。
   * 不传则只静默反写，不发事件。
   */
  onBlockChanged?: (diff: BlockChangedDiff) => void;
  /**
   * 同一坐标的 diff 检测最小间隔 ms（默认 1000）。
   * 防止 pathfinder 高频调用导致重复检测。
   */
  diffCheckIntervalMs?: number;
}

/**
 * 在 target（mineflayer Bot）上安装记忆回退 patch。
 * 返回 { uninstall, stats }。
 *
 * @param target  mineflayer Bot（或实现 BotBlockAtTarget 接口的 mock）
 * @param worldMap  WorldMapStore 实例
 * @param opts  可选 · 见 PatchOptions
 */
export function installPatchedBlockAt(
  target: BotBlockAtTarget,
  worldMap: WorldMapStore,
  opts?: PatchOptions,
): { uninstall: () => void; stats: PatchStats } {
  const stats: PatchStats = { memoryHits: 0, memoryMisses: 0, diffDetected: 0, memoryRewritten: 0 };
  const intervalMs = opts?.diffCheckIntervalMs ?? 1000;
  /** 上次对该坐标做 diff 检测的时间戳（降采样） */
  const lastCheck = new Map<string, number>();

  const original = target.blockAt.bind(target);

  (target as { blockAt: typeof target.blockAt }).blockAt = (
    pos: { x: number; y: number; z: number },
    applyPhysics?: boolean,
  ): unknown => {
    const result = original(pos, applyPhysics);

    // ── 路径 A · 实地有真实值 → diff 检测 + 反写（FEAT-L1-05）─────────────
    if (result !== null && result !== undefined) {
      // 只对落地坐标（整数）做检测；pathfinder 通常用整数
      const ix = Math.floor(pos.x);
      const iy = Math.floor(pos.y);
      const iz = Math.floor(pos.z);
      const key = `${ix}:${iy}:${iz}`;

      // BUG-CROSS-07 · 世界体积扫描会读取数万真实方块。没有历史记忆的坐标不可能产生 diff，
      // 必须在进入 debounce/SQLite 前用内存索引直接返回，否则同步点查会阻塞 keepalive。
      if (worldMap.hasBlock && !worldMap.hasBlock(ix, iy, iz)) return result;

      const now = Date.now();
      const last = lastCheck.get(key) ?? 0;
      if (now - last >= intervalMs) {
        lastCheck.set(key, now);
        try {
          // mineflayer Block 有 .name 字段
          const realBlock = result as { name?: string };
          const realName = realBlock?.name;
          if (typeof realName === 'string') {
            const stored = worldMap.getBlock(ix, iy, iz);
            if (stored && stored.blockName !== realName) {
              // BUG-MEM-01：air 信号不可信（启动期/chunk边界 mineflayer 返回 fake air）
              // → 仅当实地是「实方块」（非 air）时才认 diff 并反写
              // → 真挖方块的记忆删除由 atomic.dig.success / WorldScan SLOW tick 处理
              const isAir = realName === 'air' || realName === 'cave_air' || realName === 'void_air';
              if (!isAir) {
                stats.diffDetected++;
                const prevConf = stored.confidence ?? 1.0;
                worldMap.updateBlock({
                  x: ix, y: iy, z: iz,
                  blockName: realName,
                  boundingBox: (realBlock as { boundingBox?: string }).boundingBox ?? 'block',
                  updatedAt: now,
                  confidence: 1.0,
                });
                stats.memoryRewritten++;
                opts?.onBlockChanged?.({
                  position: { x: ix, y: iy, z: iz },
                  previousBlockName: stored.blockName,
                  actualBlockName: realName,
                  previousConfidence: prevConf,
                });
              }
            }
          }
        } catch {
          // diff 检测纯增强，任何异常都不能影响正常 blockAt 返回
        }
      }
      return result;
    }

    // ── 路径 B · 实地无值（chunk 未加载）→ 记忆回退 ─────────────────────
    const stored = worldMap.getBlock(
      Math.floor(pos.x),
      Math.floor(pos.y),
      Math.floor(pos.z),
    );
    if (!stored) {
      stats.memoryMisses++;
      return null;
    }

    const blockDef = target.registry.blocksByName[stored.blockName];
    if (!blockDef) {
      stats.memoryMisses++;
      return null;
    }

    stats.memoryHits++;

    // 构造最小 Block-like 对象，满足 pathfinder A* 需要的关键字段：
    // - type: 数字 ID，pathfinder 用于 openable.has(type) + 判断 air
    // - boundingBox: 'block' | 'empty'，pathfinder 用于可通行判定
    // - shapes: 物理碰撞盒，从 boundingBox 派生
    return {
      type: blockDef.id,
      name: stored.blockName,
      displayName: blockDef.displayName ?? stored.blockName,
      boundingBox: stored.boundingBox as 'block' | 'empty',
      shapes: stored.boundingBox === 'block' ? [[0, 0, 0, 1, 1, 1]] : [],
      position: { x: stored.x, y: stored.y, z: stored.z },
      stateId: blockDef.defaultState ?? 0,
      metadata: 0,
    };
  };

  const uninstall = () => {
    (target as { blockAt: typeof target.blockAt }).blockAt = original;
  };

  return { uninstall, stats };
}
