/**
 * L6 · ICritic 接口 + Verdict 类型
 *
 * Critic 负责评测任务成败（Voyager 借鉴 #1）：
 *   - 看 before/after WorldState 判定任务成败
 *   - Strategy 不再自判 plotsDone/done · 由 Critic 判
 */

import type { WorldStateView } from '../../types.js';
import type { Task } from '../taskRuntime.js';

// ──────────────────────────────────────────────────────────────────
// Verdict · 评测结果
// ──────────────────────────────────────────────────────────────────

export type VerdictStatus = 'success' | 'partial' | 'fail' | 'unknown';

export interface Verdict {
  taskId: string;
  taskKind: string;
  status: VerdictStatus;
  /** 人读描述 */
  reason: string;
  /** 评测时间戳 ms */
  evaluatedAt: number;
  /** 可选：附加 metrics（如 plotsDone, distance 等） */
  metrics?: Record<string, unknown>;
}

// ──────────────────────────────────────────────────────────────────
// ICritic · 评测器接口
// ──────────────────────────────────────────────────────────────────

export interface ICritic {
  readonly id: string;
  /**
   * 评测任务成败
   * @param task 任务快照
   * @param before 任务开始前的 WorldState 快照
   * @param after  当前（任务结束时）的 WorldState 快照
   */
  verify(task: Task, before: WorldStateView, after: WorldStateView): Verdict;
}

// ──────────────────────────────────────────────────────────────────
// ICriticRegistry
// ──────────────────────────────────────────────────────────────────

export interface ICriticRegistry {
  register(critic: ICritic): void;
  get(id: string): ICritic | undefined;
  /** 验证所有关联任务 */
  verifyAll(tasks: Task[], before: WorldStateView, after: WorldStateView): Verdict[];
}

// ──────────────────────────────────────────────────────────────────
// IPostconditionValidator · 任务后置验证门（FEAT-L6-03）
// ──────────────────────────────────────────────────────────────────

/**
 * 后置验证：只看「任务结束时的世界视图(after)」断言任务是否真完成。
 * 与进度型 Critic（看 before/after 差分）解耦——
 * 没注册后置验证器的 kind 一律返回 unknown（放行，维持现状不误杀）。
 */
export interface IPostconditionValidator {
  /** 后置断言 · 只依赖 after 世界视图 */
  verifyPostcondition(task: Task, after: WorldStateView): Verdict;
}
