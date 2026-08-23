/**
 * L5 · SmartNavStrategy — 智能导航策略（含门通行协调）
 *
 * FEAT-CROSS-01
 *
 * 职责：
 * 1. 接收 nav goal → 调 L1 NavigationAdapter.goto()
 * 2. 若 noPath → 扫描附近门 → 走到门前 → L3 openDoor → 重试
 * 3. 超过 maxAttempts 或无门可开 → 失败上报
 *
 * 设计要点：
 * - pathfinder canOpenDoors=false，门在 A* 里就是墙
 * - 开门决策完全在本层控制，不依赖 pathfinder 内置 useOne
 * - 可取消（cancel()）
 */

import type { NavigationAdapter, NavGoal } from '../../adapter/NavigationAdapter.js';
import type { GameAdapter } from '../../adapter/GameAdapter.js';
import type { Vec3, NavResult } from '../../adapter/types.js';
import { isDoorBlock, openDoor } from '../atomic/openDoor.js';

// ── 配置 ─────────────────────────────────────────────────

export interface SmartNavConfig {
  /** 最大重试次数（含开门后重试）默认 3 */
  maxAttempts?: number;
  /** 扫描门的半径（格），默认 8 */
  scanRadius?: number;
  /** 走到门前的距离容差，默认 2 */
  doorApproachRange?: number;
}

const DEFAULT_CONFIG: Required<SmartNavConfig> = {
  maxAttempts: 3,
  scanRadius: 8,
  doorApproachRange: 2,
};

// ── 结果 ─────────────────────────────────────────────────

export interface SmartNavResult {
  ok: boolean;
  reason?: 'arrived' | 'noPath' | 'door_stuck' | 'max_retries' | 'cancelled' | 'disconnected' | string;
  doorsOpened: number;
  attempts: number;
}

// ── 实现 ─────────────────────────────────────────────────

export class SmartNavStrategy {
  private cancelled = false;
  private readonly config: Required<SmartNavConfig>;

  constructor(
    private readonly nav: NavigationAdapter,
    private readonly game: GameAdapter,
    config?: SmartNavConfig,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 智能导航：尝试到达目标，途中遇门自动开门后重试。
   */
  async navigate(goal: NavGoal): Promise<SmartNavResult> {
    this.cancelled = false;
    let doorsOpened = 0;
    let attempts = 0;

    for (let i = 0; i < this.config.maxAttempts; i++) {
      if (this.cancelled) {
        return { ok: false, reason: 'cancelled', doorsOpened, attempts };
      }

      attempts++;
      const result = await this.nav.goto(goal);

      if (result.ok) {
        return { ok: true, reason: 'arrived', doorsOpened, attempts };
      }

      if (this.cancelled) {
        return { ok: false, reason: 'cancelled', doorsOpened, attempts };
      }

      // 非 noPath 错误（disconnected / cancelled / timeout 等）直接返回
      const reason = result.reason ?? 'unknown';
      if (reason === 'cancelled' || reason === 'disconnected') {
        return { ok: false, reason, doorsOpened, attempts };
      }

      // noPath 或其它失败 → 尝试找门
      const pos = this.game.getPosition();
      const goalPos = this.extractGoalPos(goal);
      const doors = this.scanDoorsNearby(pos, goalPos);

      if (doors.length === 0) {
        // 真的无路可走，不是门的问题
        return { ok: false, reason: 'noPath', doorsOpened, attempts };
      }

      // 尝试开最近的门
      let openedAny = false;
      for (const doorPos of doors) {
        if (this.cancelled) break;

        // 先走到门前
        const approachGoal: NavGoal = {
          type: 'block',
          position: doorPos,
          range: this.config.doorApproachRange,
        };
        const approachResult = await this.nav.goto(approachGoal);

        if (this.cancelled) break;

        // 如果走不到门前（门可能在墙另一侧），试下一个门
        if (!approachResult.ok) continue;

        // 开门
        const doorResult = await openDoor(this.game, doorPos);
        if (doorResult.ok) {
          doorsOpened++;
          openedAny = true;
          console.log(`[SmartNav] 开门成功 · ${doorPos.x},${doorPos.y},${doorPos.z} · reason=${doorResult.reason}`);
          break; // 开了一扇门就重试导航
        } else {
          console.log(`[SmartNav] 开门失败 · ${doorPos.x},${doorPos.y},${doorPos.z} · reason=${doorResult.reason}`);
        }
      }

      if (!openedAny) {
        return { ok: false, reason: 'door_stuck', doorsOpened, attempts };
      }

      // 开门成功，回到循环顶部重试 nav.goto
    }

    return { ok: false, reason: 'max_retries', doorsOpened, attempts };
  }

  cancel(): void {
    this.cancelled = true;
    this.nav.stop();
  }

  // ── 内部方法 ──────────────────────────────────────────

  /**
   * 在 pos 附近 scanRadius 范围内搜索关闭的门方块。
   * 返回按到 pos 距离排序的门坐标列表。
   */
  private scanDoorsNearby(pos: Vec3, goalPos: Vec3 | null): Vec3[] {
    const r = this.config.scanRadius;
    const doors: Vec3[] = [];

    // 搜索范围：以 pos 为中心，偏向 goal 方向
    const cx = Math.floor(pos.x);
    const cy = Math.floor(pos.y);
    const cz = Math.floor(pos.z);

    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        // 门通常在 y 和 y+1（两格高），只扫描 pos.y ± 2
        for (let dy = -2; dy <= 2; dy++) {
          const x = cx + dx;
          const y = cy + dy;
          const z = cz + dz;

          const block = this.game.getBlockAt({ x, y, z });
          if (!block) continue;
          if (!isDoorBlock(block.name)) continue;

          // 跳过铁门（不能手动开）
          if (block.name === 'iron_door' || block.name === 'iron_trapdoor') continue;

          // 只要关闭的门
          const props = this.game.getBlockProperties({ x, y, z });
          if (props?.open === 'true') continue;

          doors.push({ x, y, z });
        }
      }
    }

    // 按到 pos 距离排序（优先开近的门）
    // 如果有 goal，也考虑门是否在 pos→goal 方向上
    doors.sort((a, b) => {
      const da = dist(a, pos);
      const db = dist(b, pos);
      if (goalPos) {
        // 加权：更靠近 goal 方向的门优先
        const ga = dist(a, goalPos);
        const gb = dist(b, goalPos);
        return (da + ga * 0.5) - (db + gb * 0.5);
      }
      return da - db;
    });

    // 去重（两格门只保留下半部分）
    const seen = new Set<string>();
    const unique: Vec3[] = [];
    for (const d of doors) {
      const key = `${d.x}:${d.z}`;
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(d);
    }

    return unique.slice(0, 3); // 最多尝试 3 扇门
  }

  private extractGoalPos(goal: NavGoal): Vec3 | null {
    if (goal.type === 'block') return goal.position;
    // entity/player/follow 类型无法直接知道坐标，返回 null
    return null;
  }
}

// ── 工具 ─────────────────────────────────────────────────

function dist(a: Vec3, b: Vec3): number {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2);
}
