/**
 * 🧭 NavigationRouter — 退避式寻路（FEAT-L1-07）
 *
 * 不再按距离分桶选算法（旧 local/global/hybrid 已退役）。统一退避升级阶梯：
 *
 *   L0 直冲  · pathfinder + StuckRecovery 梯度自救（任何距离都先这条）
 *              开阔地形全程够用、零额外成本；区块流式重算自动延伸。
 *      │ 失败且离目标仍远（NavStuckSentinel 判定贪心撞墙）
 *   L1 绕路  · DetourPlanner 在 WorldMapStore 记忆地图上按需出绕障 waypoint
 *              → 逐段 gotoWithRecovery → 末段冲 goal
 *      │ 无路 / 仍失败
 *   L2 放弃  · 结构化失败 reason（上层 atomic/task 映射 FailureReason 退避）
 *
 * cancel() 支持中断任意进行中的导航。
 */

import type { Vec3, NavResult } from '../../adapter/types.js';
import type { NavigationActions } from '../../adapter/NavigationExecution.js';
import type { GameActions, DeviceExecutionScope } from '../../adapter/GameActions.js';
import type { WorldMapStore } from '../infra/worldMapStore.js';
import { DetourPlanner } from './detourPlanner.js';
import { NavStuckSentinel } from './navStuckSentinel.js';
import { StuckRecovery } from './stuckRecovery.js';

/** direct = L0 直冲达成 · detour = L1 绕路达成 · cancelled = 被中断 */
export type NavMode = 'direct' | 'detour' | 'cancelled';

export interface NavigationRouterOptions {
  /** 预留：未来按需扩展 */
  prefer?: NavMode;
}

export interface NavRouterResult {
  success: boolean;
  mode: NavMode;
  distanceTraveled: number;
  /** 兼容字段（退避版恒 0） */
  frontierHops: number;
  reason?: string;
}

export interface NavigationRouter {
  navigateTo(goal: Vec3, options?: NavigationRouterOptions): Promise<NavRouterResult>;
  cancel(): Promise<void>;
}

function dist3(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

// ─── Implementation ───────────────────────────────────────────────────────────

export class NavigationRouterImpl implements NavigationRouter {
  private cancelled = false;
  private readonly detour: DetourPlanner;
  private readonly sentinel = new NavStuckSentinel();
  private readonly stuckRecovery = new StuckRecovery();

  constructor(
    private readonly nav: NavigationActions,
    private readonly worldMap: WorldMapStore,
    private readonly getPosition: () => Vec3,
    private readonly actions: GameActions,
    private readonly scope: DeviceExecutionScope,
  ) {
    this.detour = new DetourPlanner(worldMap);
  }

  async cancel(): Promise<void> {
    this.cancelled = true;
    await this.nav.stop();
  }

  async navigateTo(goal: Vec3, _options?: NavigationRouterOptions): Promise<NavRouterResult> {
    this.scope.assertCurrent('navigation-router');
    if (this.cancelled) return {success:false,mode:'cancelled',distanceTraveled:0,frontierHops:0,reason:'cancelled'};
    const totalDist = dist3(this.getPosition(), goal);

    // ── L0 · 直冲 ─────────────────────────────────────────────────────────────
    const l0 = await this.gotoWithRecovery(goal, 1);
    if (l0.ok) {
      return { success: true, mode: 'direct', distanceTraveled: totalDist, frontierHops: 0 };
    }
    if (this.cancelled || l0.reason === 'cancelled') {
      return { success: false, mode: 'cancelled', distanceTraveled: 0, frontierHops: 0, reason: 'cancelled' };
    }

    // ── 卡死判定 · 失败但已贴近目标 → 已尽力，不绕，直接放弃 ──────────────────
    const here = this.getPosition();
    if (!this.sentinel.isGreedyStuck(here, goal, l0)) {
      return { success: false, mode: 'direct', distanceTraveled: 0, frontierHops: 0, reason: l0.reason };
    }

    // ── L1 · 按需绕路 ─────────────────────────────────────────────────────────
    const plan = this.detour.plan(here, goal);
    if (plan.waypoints.length > 0) {
      for (const wp of plan.waypoints) {
        if (this.cancelled) {
          return { success: false, mode: 'cancelled', distanceTraveled: 0, frontierHops: 0, reason: 'cancelled' };
        }
        await this.gotoWithRecovery(wp, 2);
      }
      const fin = await this.gotoWithRecovery(goal, 1);
      if (fin.ok) {
        return { success: true, mode: 'detour', distanceTraveled: totalDist, frontierHops: 0 };
      }
      // L1 走完仍没到 → 落 L2
      return {
        success: false, mode: 'detour', distanceTraveled: 0, frontierHops: 0,
        reason: `detour_failed:${fin.reason ?? 'unknown'}`,
      };
    }

    // ── L2 · 记忆也无路 → 结构化放弃 ─────────────────────────────────────────
    return {
      success: false, mode: 'detour', distanceTraveled: 0, frontierHops: 0,
      reason: `no_path:${l0.reason ?? 'stuck'}`,
    };
  }

  private async gotoWithRecovery(pos: Vec3, range: number): Promise<NavResult> {
    this.scope.assertCurrent('navigation-router-step');
    return this.stuckRecovery.executeWithRecovery(pos,this.nav,this.actions,this.scope,{range});
  }
}
