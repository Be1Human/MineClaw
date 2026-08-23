/**
 * 🦿 motor/ · 唯一运动执行通道（FEAT-CROSS-02 · 阶段一）
 *
 * 定位：全系统"怎么动"的唯一出口。把散落在 atomics / DoorMonitor / StuckMonitor /
 * StuckRecovery 的 setControlState / nav.goto / nav.stop 收归一处，带优先级抢占语义。
 *
 * 上游：atomics 的移动类原子（move_to/follow/walk/escape_pit/stop…）提交 MotorProgram。
 * 下游：串行化调用 NavigationAdapter.goto / GameAdapter.setControlState。
 */

import type { Vec3, ControlKey } from '../../adapter/types.js';
import type { NavGoal } from '../../adapter/NavigationAdapter.js';

export type { ControlKey };

/** 运动程序：寻路 / 控制键脉冲 / 全停 */
export type MotorProgram =
  | { kind: 'goto'; goal: NavGoal; budgetMs: number; thinkTimeoutMs?: number }   // 寻路（含实体跟随）
  | { kind: 'follow'; entityId: number; range: number; force?: boolean }         // 持续动态跟随
  | { kind: 'pulse'; keys: ControlKey[]; durationMs: number; lookAt?: Vec3 }     // 控制键脉冲（恢复/微操）
  | { kind: 'stop' };                                                            // 全停

export interface MotorResult {
  ok: boolean;
  /** 'nav_timeout' | 'noPath' | 'preempted' | 'motor_busy' | 'cancelled' | ... */
  reason?: string;
  /** 被更高优先级抢占 */
  preempted?: boolean;
}

export interface MotorTicket {
  /** 'atomic.move_to' | 'recovery.door' | ... */
  owner: string;
  /** 沿用 ActionRequest priority 体系（任务 30-45 · 恢复 90-97） */
  priority: number;
  program: MotorProgram;
  startedAt: number;
}

export interface IMotorService {
  /** 提交并执行一个运动程序。同一时刻最多 1 个在跑。 */
  run(owner: string, priority: number, program: MotorProgram): Promise<MotorResult>;
  current(): MotorTicket | null;
  isBusy(): boolean;
  /** 取消当前程序（owner 不填 = 无条件全停 + clearControlStates） */
  cancel(owner?: string): void;
}
