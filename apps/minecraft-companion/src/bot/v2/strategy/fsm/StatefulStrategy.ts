/**
 * 🎚 StatefulStrategy<S> · FSM 策略基类
 *
 * 适用：Follow / Farm / Idle / Rest 等 3-5 个状态能讲清楚的行为。
 *
 * 设计原则：
 *   - 状态数 ≤ 5：超过就该换 BT
 *   - 滞回防抖：transit() 支持设 hysteresisMs，边界状态不反复抖动
 *   - 冻结而非清空：isActive=false 时状态保留，恢复时续跑
 *   - inspect() 返回 { state, sinceTick }，让 Supervisor 看清楚停在哪里多久
 */

import type { IStrategy, StrategyContext, StrategyInspect } from '../types.js';
import type { ActionRequest } from '../../types.js';

export abstract class StatefulStrategy<S extends string> implements IStrategy {
  abstract readonly id: string;
  readonly kind = 'fsm' as const;

  protected state: S;
  protected sinceTick = 0;
  /** 上次状态转换的时间戳（ms），用于 hysteresis 计算 */
  private lastTransitAt = 0;

  constructor(protected readonly initialState: S) {
    this.state = initialState;
  }

  // ── 子类必须实现 ──────────────────────────────────────────────
  abstract isActive(ctx: StrategyContext): boolean;
  abstract tick(ctx: StrategyContext): ActionRequest[];

  // ── 状态转换 ──────────────────────────────────────────────────

  /**
   * 转移到新状态。
   * @param newState    目标状态
   * @param tick        当前 tick 号（记录 sinceTick）
   * @param hysteresisMs 最短驻留时间（ms）。若当前状态停留不足此值，拒绝转移。
   *                    用于防止边界抖动（如 dist=3.0x 反复进出 in_range）。
   * @returns 是否实际发生了转移
   */
  protected transit(newState: S, tick: number, hysteresisMs = 0): boolean {
    if (newState === this.state) return false;
    if (hysteresisMs > 0 && Date.now() - this.lastTransitAt < hysteresisMs) return false;
    this.state = newState;
    this.sinceTick = tick;
    this.lastTransitAt = Date.now();
    return true;
  }

  /**
   * 检查是否已在当前状态停留超过指定毫秒（超时检测）。
   */
  protected inStateFor(ms: number): boolean {
    return Date.now() - this.lastTransitAt >= ms;
  }

  // ── IStrategy 通用实现 ────────────────────────────────────────

  reset(): void {
    this.state = this.initialState;
    this.sinceTick = 0;
    this.lastTransitAt = 0;
  }

  inspect(): StrategyInspect {
    return {
      kind: 'fsm',
      view: {
        state: this.state,
        sinceTick: this.sinceTick,
        inStateForMs: Date.now() - this.lastTransitAt,
      },
      sinceTick: this.sinceTick,
    };
  }
}
