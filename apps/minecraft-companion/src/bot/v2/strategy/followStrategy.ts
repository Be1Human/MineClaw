/**
 * 📋 FollowStrategy · 任务驱动 · 跟随 owner（BUG-L5-01 重构版）
 *
 * 实现：StatefulStrategy<FollowState>（FSM）
 *
 * 核心模型转变（BUG-L5-01）：
 *   跟随 = 设一次 pathfinder 动态目标（nav.startFollow → GoalFollow dynamic），
 *   后台持续驱动 bot：进 range 自停、owner 动自追、永不 timeout。
 *   following 状态每 tick 只重新提交幂等的 follow_entity（atomic no-op 维持），
 *   离开跟随态发 stop_follow 清目标。
 *
 *   ⛔ 已删除：旧的「每 tick 发一次性阻塞 goto + stuck-detector/backoff 兜底」整套，
 *      那是 GoalFollow 被当一次性 goto 调用的错配补丁，且自死锁（GYM-BUG-18）。
 *   ⛔ 已删除：in_range / ARRIVE/LEAVE 滞回状态——动态目标自带到位停止，无需上层防抖。
 *
 * 状态图：
 *   idle ──owner 可见──► following
 *   following ──可见──► following     (幂等维持 follow_entity，pathfinder 后台跟)
 *   following ──失联+有坐标──► seeking (stop_follow + goto 坐标，静默追)
 *   following ──失联+无坐标──► lost    (stop_follow + 问"你在哪")
 *   seeking ──可见──► following
 *   seeking ──到坐标无人──► lost
 *   lost ──可见──► following
 *   *  ──任务失活──► idle              (stop_follow + reset)
 *
 * 消息策略：seeking 静默；seeking 到达无人→lost；lost 每 N 秒问一次（冷却可配）。
 */

import { StatefulStrategy } from './fsm/StatefulStrategy.js';
import type { StrategyContext } from './types.js';
import type { ActionRequest } from '../types.js';
import { tuning } from '../infra/tuning.js';

export type FollowState = 'idle' | 'following' | 'seeking' | 'lost';

export class FollowStrategy extends StatefulStrategy<FollowState> {
  readonly id = 'follow_strategy';

  private reqSeq = 0;
  private lastSayLostAt = 0;

  /** BUG-L5-02 · 上次强制重算时主人的位置 + 时刻（跟手重算用） */
  private lastRepathOwnerPos: { x: number; y: number; z: number } | null = null;
  private lastRepathAt = 0;

  /** BUG-L5-02 诊断 · 本 tick 是否触发了强制重算 + 上次诊断日志时刻（节流） */
  private forceFiredThisTick = false;
  private lastDiagAt = 0;

  /** owner 最后可见坐标缓存 · owner.isVisible 时更新，失联后驱动 seeking */
  private lastKnownOwnerPos: { x: number; y: number; z: number } | null = null;

  /** owner 每 tick 位移向量（速度估计）· 失联后朝移动方向外推追 */
  private ownerVel: { x: number; z: number } | null = null;

  /** seeking 首次到达目标的 tick 号（0 = 尚未到达） */
  private seekArriveWaitTick = 0;

  /** 是否已说过"等你回来"——避免 lost 反复骚扰 */
  private saidWaiting = false;

  /**
   * seeking 到达并超时 → lost 后置 true，防止 lost 再触发同一目标的 seeking 死循环。
   * owner 重新可见时重置。
   */
  private seekingExhausted = false;

  /** 连续不可见 tick 计数 · 可见清零，达阈值才转 seeking（防一帧遮挡误触发） */
  private invisibleStreakTicks = 0;

  /**
   * BUG-CROSS-01 修②：上次见到的任务坐标指纹。主人报新坐标 = 新线索，重置 seekingExhausted。
   */
  private lastTargetFingerprint = '';

  constructor() {
    super('idle');
  }

  /** FEAT-NARR-01 · 本 tick 的通知出口 */
  private narrateFn?: (intent: { topic: string; urgency: number; data?: Record<string, unknown> }) => void;

  isActive(ctx: StrategyContext): boolean {
    return ctx.activeTaskKind === 'follow_owner';
  }

  tick(ctx: StrategyContext): ActionRequest[] {
    const { world, tick } = ctx;
    this.narrateFn = ctx.narrate ? (i) => ctx.narrate!({ source: 'follow', ...i }) : undefined;
    const owner = world.owner;
    this.forceFiredThisTick = false;
    const reqs = this._tickInner(ctx, owner);
    this._diag(world, owner);
    return reqs;
  }

  /** BUG-L5-02 诊断 · 节流打印 bot↔owner 实时距离，定位 10s 迟钝根因 */
  private _diag(
    world: StrategyContext['world'],
    owner: StrategyContext['world']['owner'],
  ): void {
    if (!tuning().follow.diagLog) return;
    const now = Date.now();
    if (now - this.lastDiagAt < 250) return;
    this.lastDiagAt = now;
    const s = world.self.position;
    const o = owner?.position;
    const dist = o ? Math.sqrt((o.x - s.x) ** 2 + (o.z - s.z) ** 2) : -1;
    const ts = new Date(now).toISOString().slice(11, 23);
    const op = o ? `(${o.x.toFixed(1)},${o.z.toFixed(1)})` : 'null';
    const sp = `(${s.x.toFixed(1)},${s.z.toFixed(1)})`;
    console.log(
      `[FOLLOW-DIAG ${ts}] state=${this.state} vis=${owner?.isVisible ?? false} ` +
      `owner=${op} bot=${sp} dist=${dist.toFixed(2)} force=${this.forceFiredThisTick}`,
    );
  }

  private _tickInner(
    ctx: StrategyContext,
    owner: StrategyContext['world']['owner'],
  ): ActionRequest[] {
    const { world, tick } = ctx;

    // ── 任务失活 → idle ＋ 若在跟随则 stop_follow（防任务取消后仍跟着主人跑）──
    if (!this.isActive(ctx)) {
      const wasFollowing = this.state === 'following' || this.state === 'seeking';
      this.transit('idle', tick);
      this.lastKnownOwnerPos     = null;
      this.ownerVel              = null;
      this.seekArriveWaitTick    = 0;
      this.saidWaiting           = false;
      this.seekingExhausted      = false;
      this.invisibleStreakTicks  = 0;
      this.lastTargetFingerprint = '';
      this.lastRepathOwnerPos    = null;
      this.lastRepathAt          = 0;
      return wasFollowing ? [this.stopFollowReq(tick)] : [];
    }

    // ── BUG-CROSS-01 修②：任务坐标变化 → 重置 seeking 耗尽（新线索重新找）──
    {
      const tp = (ctx.activeTaskParams?.targetPosition ?? ctx.activeTaskParams?.ownerPosition) as
        | { x?: number; y?: number; z?: number } | undefined;
      const fp = tp && typeof tp.x === 'number' && typeof tp.z === 'number'
        ? `${tp.x},${tp.y ?? ''},${tp.z}` : '';
      if (fp && fp !== this.lastTargetFingerprint) {
        this.lastTargetFingerprint = fp;
        this.seekingExhausted = false;
        this.saidWaiting = false;
        this.seekArriveWaitTick = 0;
      }
    }

    // ── 每 tick 更新可见状态：缓存坐标 + 速度估计 + 不可见连击 ──
    if (owner?.isVisible && owner.position != null) {
      if (this.lastKnownOwnerPos) {
        const vx = owner.position.x - this.lastKnownOwnerPos.x;
        const vz = owner.position.z - this.lastKnownOwnerPos.z;
        if (Math.abs(vx) > 0.01 || Math.abs(vz) > 0.01) this.ownerVel = { x: vx, z: vz };
      }
      this.lastKnownOwnerPos = { ...owner.position };
      this.seekingExhausted = false;
      this.invisibleStreakTicks = 0;
    } else {
      this.invisibleStreakTicks++;
    }

    const streakThreshold = tuning().follow.invisibleStreakTicks;

    // ── 状态机 ───────────────────────────────────────────────────
    switch (this.state) {

      case 'idle':
        if (owner?.isVisible) this.transit('following', tick);
        else if (!this.seekingExhausted && this.getSeekTarget(ctx)) this.transit('seeking', tick);
        else if (owner) this.transit('lost', tick);
        return [];

      case 'following': {
        if (!owner) { this.transit('lost', tick); return [this.stopFollowReq(tick)]; }
        if (!owner.isVisible || owner.position == null) {
          // 短暂遮挡：保持跟随（pathfinder 还在朝 owner 最后位置走），等阈值再判
          if (this.invisibleStreakTicks < streakThreshold) return [this.followReq(tick, owner.entityId)];
          // 确认失联 → 停跟随，转 seeking（有坐标）/ lost（无坐标）
          if (this.lastKnownOwnerPos) {
            this.transit('seeking', tick);
            return [this.stopFollowReq(tick)];
          }
          this.transit('lost', tick);
          return [this.stopFollowReq(tick), ...this.maybeSayLost()];
        }
        // owner 可见 → 幂等维持动态跟随（pathfinder 后台进 range 自停、owner 动自追）。
        // BUG-L5-02：主人挪动够多 → 发 force 版打断 GoalFollow 懒重算，亚秒级跟手。
        ctx.setPhase?.(owner.distance <= 4 ? '跟随中 · 在主人身边' : `跟随中 · 距主人 ${Math.round(owner.distance)} 格`);
        return [this.followReq(tick, owner.entityId, this.shouldForceRepath(owner.position))];
      }

      case 'seeking': {
        if (owner?.isVisible && owner.position != null) {
          this.transit('following', tick);
          this.seekArriveWaitTick = 0;
          this.saidWaiting = false;
          return [this.followReq(tick, owner.entityId)];
        }
        const tp = this.getSeekTarget(ctx);
        if (!tp) {
          this.seekArriveWaitTick = 0;
          this.seekingExhausted = true;
          this.transit('lost', tick);
          return this.maybeSayWaiting();
        }
        const myPos = world.self.position;
        const dx = tp.x - myPos.x, dz = tp.z - myPos.z;
        const dist = Math.sqrt(dx * dx + dz * dz);

        if (dist <= tuning().follow.seekArriveDist) {
          if (this.seekArriveWaitTick === 0) this.seekArriveWaitTick = tick;
          if (tick - this.seekArriveWaitTick < tuning().follow.seekArriveWaitTicks) return [];
          this.seekArriveWaitTick = 0;
          this.seekingExhausted = true;
          this.transit('lost', tick);
          return this.maybeSayWaiting();
        }
        // 未到达 → 一次性 goto 追坐标（GoalNear · 已验证可靠）
        this.seekArriveWaitTick = 0;
        ctx.setPhase?.('寻找主人');
        return [{
          id: `follow-seek-${tick}-${++this.reqSeq}`,
          source: this.id,
          type: 'goto_position',
          priority: 42,
          interrupt_level: 'soft',
          resource: ['movement'],
          target: { position: tp },
          preconditions: [],
          expected_effect: ['closer_to_target'],
          timeout_ms: 15000,
        }];
      }

      case 'lost': {
        if (owner?.isVisible && owner.position != null) {
          this.transit('following', tick);
          this.saidWaiting = false;
          return [this.followReq(tick, owner.entityId)];
        }
        if (!this.seekingExhausted && this.getSeekTarget(ctx)) {
          this.transit('seeking', tick);
          return [];
        }
        if (this.saidWaiting) return [];
        return this.maybeSayLost();
      }
    }
  }

  // ── ActionRequest 构建 ──────────────────────────────────────

  /** 幂等维持跟随：atomic 看到已在跟同实体即 no-op，否则 nav.startFollow 设动态目标 */
  private followReq(tick: number, entityId: number | null, forceRepath = false): ActionRequest {
    return {
      id: `${this.id}-follow-${tick}-${++this.reqSeq}`,
      source: this.id,
      type: 'follow_entity',
      priority: 40,
      interrupt_level: 'soft',
      resource: ['movement'],
      target: { entityId: entityId ?? undefined, forceRepath },
      preconditions: [],
      expected_effect: ['closer_to_owner'],
      timeout_ms: tuning().controlledExecution.operationTimeoutMs,
    };
  }

  /**
   * BUG-L5-02 · 是否该强制重算（打断 GoalFollow 懒重算）。
   * 开关关 → 永不强制（退回纯 GoalFollow）。开 → 主人较上次重算位移 ≥ 阈值且距上次重算 ≥ 最小间隔。
   * 命中即更新 lastRepath* 锚点。
   */
  private shouldForceRepath(ownerPos: { x: number; y: number; z: number }): boolean {
    const cfg = tuning().follow;
    if (!cfg.repathOnOwnerMove) return false;
    const now = Date.now();
    if (this.lastRepathOwnerPos == null) {
      // 首次进 following：设锚点，不强制（startFollow 本身已设过目标）
      this.lastRepathOwnerPos = { ...ownerPos };
      this.lastRepathAt = now;
      return false;
    }
    if (now - this.lastRepathAt < cfg.repathMinIntervalMs) return false;
    const dx = ownerPos.x - this.lastRepathOwnerPos.x;
    const dz = ownerPos.z - this.lastRepathOwnerPos.z;
    if (Math.sqrt(dx * dx + dz * dz) < cfg.repathMoveThreshold) return false;
    this.lastRepathOwnerPos = { ...ownerPos };
    this.lastRepathAt = now;
    this.forceFiredThisTick = true;
    return true;
  }

  /** 离开跟随态 → 撤销 pathfinder 动态目标 */
  private stopFollowReq(tick: number): ActionRequest {
    return {
      id: `${this.id}-stopfollow-${tick}-${++this.reqSeq}`,
      source: this.id,
      type: 'stop_follow',
      priority: 45,
      interrupt_level: 'soft',
      resource: ['movement'],
      target: {},
      preconditions: [],
      timeout_ms: 1000,
    };
  }

  /**
   * 求 seeking 目标：优先任务参数坐标（LLM 传入），其次缓存的 lastKnownOwnerPos（含速度外推）。
   */
  private getSeekTarget(ctx: StrategyContext): { x: number; y: number; z: number } | null {
    const params = ctx.activeTaskParams;
    if (params) {
      const tp = (params.targetPosition ?? params.ownerPosition) as { x?: number; y?: number; z?: number } | undefined;
      if (tp && typeof tp.x === 'number' && typeof tp.z === 'number') {
        return { x: tp.x, y: tp.y ?? 64, z: tp.z };
      }
    }
    if (!this.lastKnownOwnerPos) return null;
    if (this.ownerVel) {
      const vx = this.ownerVel.x, vz = this.ownerVel.z;
      const speed = Math.sqrt(vx * vx + vz * vz);
      if (speed > 0.02) {
        const cfg = tuning().follow;
        let ex = vx * cfg.seekExtrapolateTicks;
        let ez = vz * cfg.seekExtrapolateTicks;
        const mag = Math.sqrt(ex * ex + ez * ez);
        if (mag > cfg.seekExtrapolateMax) {
          const k = cfg.seekExtrapolateMax / mag;
          ex *= k; ez *= k;
        }
        return { x: this.lastKnownOwnerPos.x + ex, y: this.lastKnownOwnerPos.y, z: this.lastKnownOwnerPos.z + ez };
      }
    }
    return this.lastKnownOwnerPos;
  }

  /** 真正不知 owner 在哪：每 N 秒问一次（冷却可配） */
  private maybeSayLost(): ActionRequest[] {
    const now = Date.now();
    if (now - this.lastSayLostAt < tuning().follow.lostSayCooldownMs) return [];
    this.lastSayLostAt = now;
    this.narrateFn?.({ topic: 'follow_lost', urgency: 30 });
    return [];
  }

  /** seeking 到达但 owner 未现：说一次"等你回来"，之后静默 */
  private maybeSayWaiting(): ActionRequest[] {
    if (this.saidWaiting) return [];
    this.saidWaiting = true;
    return [];
  }
}
