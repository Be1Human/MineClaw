/**
 * 🗺 WorldMapCollector — 增量地形采集器
 *
 * FEAT-L1-01 Phase 1
 *
 * 职责：定时扫描 Bot 周围已加载区域的方块数据，批量写入 WorldMapStore。
 *
 * 采集策略：
 * - 每 intervalMs (默认 2000ms) 扫描 Bot 周围 scanRadius (默认 48, 即 3×3 chunk)
 * - 位移优化：上次扫描中心与当前位置差距 < minDisplacement 时跳过
 * - 积攒 buffer 满 batchSize 或超时 1s 后 batch upsert
 * - 只扫描 Y 方向 bot.y ± yRange 范围（默认 ±16，减少无意义高空/地底扫描）
 */

import type { GameAdapter } from '../../adapter/GameAdapter.js';
import type { Vec3 } from '../../adapter/types.js';
import type { WorldMapStore, StoredBlock } from './worldMapStore.js';
import { tuning } from './tuning.js';

export interface WorldMapCollectorOptions {
  /** 扫描间隔 ms（默认 2000） */
  intervalMs?: number;
  /** 扫描半径（方块数）（默认 48） */
  scanRadius?: number;
  /** Y 方向扫描范围 ±（默认 16） */
  yRange?: number;
  /** 位移小于此值跳过扫描（默认 8 格） */
  minDisplacement?: number;
  /** 日志回调 */
  onLog?: (msg: string) => void;
}

export interface WorldMapCollectorStats {
  scansCompleted: number;
  blocksWritten: number;
  lastScanMs: number;
}

export interface WorldMapCollector {
  start(): void;
  stop(): void;
  readonly isRunning: boolean;
  readonly stats: WorldMapCollectorStats;
}

export class WorldMapCollectorImpl implements WorldMapCollector {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastScanCenter: Vec3 | null = null;
  private _stats: WorldMapCollectorStats = {
    scansCompleted: 0,
    blocksWritten: 0,
    lastScanMs: 0,
  };

  private readonly intervalMs: number;
  private readonly minDisplacement: number;
  private readonly log: (msg: string) => void;
  // BUG-L5-03 · scanRadius/yRange 不再由构造参数固定，改读 tuning().worldScan（可热调）。
  //   旧值 r32/y16 → 单次扫 ≈14 万坐标（全走 patched blockAt + 写 SQLite），bot 每移动 8 格触发一次 ≈1-4s 卡顿。

  constructor(
    private readonly game: GameAdapter,
    private readonly worldMap: WorldMapStore,
    opts?: WorldMapCollectorOptions,
  ) {
    this.intervalMs = opts?.intervalMs ?? 2000;
    this.minDisplacement = opts?.minDisplacement ?? 8;
    this.log = opts?.onLog ?? (() => {});
  }

  get isRunning(): boolean {
    return this.timer !== null;
  }

  get stats(): WorldMapCollectorStats {
    return { ...this._stats };
  }

  start(): void {
    if (this.timer) return;
    this.log('[WorldMapCollector] started');
    this.timer = setInterval(() => this.scan(), this.intervalMs);
    // Do an initial scan immediately
    this.scan();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this.log('[WorldMapCollector] stopped');
    }
  }

  private scan(): void {
    const t0 = Date.now();
    const pos = this.game.getPosition();
    if (!pos) return;

    // Displacement check
    if (this.lastScanCenter) {
      const dx = pos.x - this.lastScanCenter.x;
      const dy = pos.y - this.lastScanCenter.y;
      const dz = pos.z - this.lastScanCenter.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist < this.minDisplacement) return;
    }
    this.lastScanCenter = { ...pos };

    const cx = Math.floor(pos.x);
    const cy = Math.floor(pos.y);
    const cz = Math.floor(pos.z);
    const { mapScanRadius: r, mapYRange: yr } = tuning().worldScan;
    const now = Date.now();

    const buffer: StoredBlock[] = [];

    for (let x = cx - r; x <= cx + r; x++) {
      for (let z = cz - r; z <= cz + r; z++) {
        for (let y = Math.max(cy - yr, -64); y <= Math.min(cy + yr, 319); y++) {
          const block = this.game.getBlockAt({ x, y, z });
          if (!block) continue; // chunk not loaded
          // Skip air — no need to store
          if (block.name === 'air' || block.name === 'cave_air' || block.name === 'void_air') continue;

          buffer.push({
            x, y, z,
            blockName: block.name,
            boundingBox: block.boundingBox ?? 'block',
            updatedAt: now,
          });
        }
      }
    }

    if (buffer.length > 0) {
      this.worldMap.upsertBatch(buffer);
      this._stats.blocksWritten += buffer.length;
    }

    this._stats.scansCompleted++;
    this._stats.lastScanMs = Date.now() - t0;

    if (this._stats.scansCompleted <= 3 || this._stats.scansCompleted % 10 === 0) {
      this.log(
        `[WorldMapCollector] scan #${this._stats.scansCompleted}: ${buffer.length} blocks in ${this._stats.lastScanMs}ms`,
      );
    }
  }
}
