/**
 * ⏱ 基础设施 · TickRegistry · 四级节拍注册表
 *
 * 各模块实现 ITickable 并注册到 TickRegistry，
 * Heartbeat 主循环按 tickCounter % rate === 0 触发对应等级的所有 tickable。
 *
 * 四级节拍（与 TickRate enum 对应）：
 *   FAST  (1)  · 每 tick（~200ms）· Reflex 等紧急响应
 *   STD   (5)  · 每 5 tick（~1s） · BT / Rule Strategy 等常规决策
 *   SLOW  (10) · 每 10 tick（~2s）· Supervisor watchdog 等慢检查
 *   IDLE  (150)· 每 150 tick（~30s）· 低频心跳 / 空闲占位
 */

import type { WorldStateView } from '../types.js';

// ──────────────────────────────────────────────────────────────────
// TickRate 枚举（数值 = tick 间隔）
// ──────────────────────────────────────────────────────────────────

export enum TickRate {
  FAST = 1,
  STD = 5,
  SLOW = 10,
  IDLE = 150,
}

// ──────────────────────────────────────────────────────────────────
// TickContext · 每次 onTick 调用时传入的上下文
// ──────────────────────────────────────────────────────────────────

export interface TickContext {
  /** 全局 tick 计数（从 1 开始递增） */
  tick: number;
  /** 当前节拍等级 */
  rate: TickRate;
  /** 当前 world 快照（Perception 已在 ① 步产出） */
  world: WorldStateView | null;
}

// ──────────────────────────────────────────────────────────────────
// ITickable · 可注册模块的接口
// ──────────────────────────────────────────────────────────────────

export interface ITickable {
  /** 唯一 id · 用于 unregister / 调试 */
  readonly id: string;
  /** 期望的节拍等级 */
  readonly rate: TickRate;
  /** 每到触发节拍时调用 */
  onTick(ctx: TickContext): void;
}

// ──────────────────────────────────────────────────────────────────
// TickRegistry
// ──────────────────────────────────────────────────────────────────

export class TickRegistry {
  private readonly tickables = new Map<string, ITickable>();

  /** 注册一个 tickable · 重复 id 则覆盖 */
  register(tickable: ITickable): void {
    this.tickables.set(tickable.id, tickable);
  }

  /** 按 id 取消注册 */
  unregister(id: string): void {
    this.tickables.delete(id);
  }

  /** 返回所有已注册的 tickables（快照 · 不可修改） */
  getAll(): ReadonlyArray<ITickable> {
    return Array.from(this.tickables.values());
  }

  /** 按节拍等级过滤 */
  getByRate(rate: TickRate): ReadonlyArray<ITickable> {
    return Array.from(this.tickables.values()).filter(t => t.rate === rate);
  }
}
