/**
 * L6 · RuleCritic + CriticRegistry
 *
 * 框架只提供注册能力和调度，具体验证逻辑由业务侧注册。
 */

import type { WorldStateView } from '../../types.js';
import type { Task } from '../taskRuntime.js';
import type { ICritic, ICriticRegistry, IPostconditionValidator, Verdict, VerdictStatus } from './types.js';

// ──────────────────────────────────────────────────────────────────
// VerifyFn · 业务侧注册的验证函数类型
// ──────────────────────────────────────────────────────────────────

export type VerifyFn = (task: Task, before: WorldStateView, after: WorldStateView) => Verdict;

/** FEAT-L6-03 · 后置验证函数类型（只看 after 世界视图） */
export type PostconditionFn = (task: Task, after: WorldStateView) => Verdict;

// ──────────────────────────────────────────────────────────────────
// RuleCritic · 不再硬编码 switch，从注册表查验证函数
// ──────────────────────────────────────────────────────────────────

export class RuleCritic implements ICritic, IPostconditionValidator {
  readonly id = 'rule';
  private verifiers = new Map<string, VerifyFn>();
  /** FEAT-L6-03 · 后置验证器（只看 after）· 与进度验证器分表，避免门禁误用差分逻辑 */
  private postVerifiers = new Map<string, PostconditionFn>();

  /** 业务侧注册进度验证函数（before/after 差分 · 供 Heartbeat ⑨ 周期裁决用） */
  registerVerifier(kind: string, fn: VerifyFn): void {
    this.verifiers.set(kind, fn);
  }

  /** FEAT-L6-03 · 业务侧注册后置验证器（只看 after · 供 complete() 验证门用） */
  registerPostcondition(kind: string, fn: PostconditionFn): void {
    this.postVerifiers.set(kind, fn);
  }

  verify(task: Task, before: WorldStateView, after: WorldStateView): Verdict {
    const fn = this.verifiers.get(task.kind);
    if (fn) return fn(task, before, after);
    return makeVerdict(task, 'unknown', `no verifier registered for: ${task.kind}`);
  }

  /**
   * FEAT-L6-03 · 后置验证门。
   * 没注册后置验证器的 kind → unknown（放行，不误杀 farm/follow 等差分型任务）。
   */
  verifyPostcondition(task: Task, after: WorldStateView): Verdict {
    const fn = this.postVerifiers.get(task.kind);
    if (fn) return fn(task, after);
    return makeVerdict(task, 'unknown', `no postcondition for: ${task.kind}`);
  }
}

// ──────────────────────────────────────────────────────────────────
// CriticRegistry · 框架调度器
// ──────────────────────────────────────────────────────────────────

export class CriticRegistry implements ICriticRegistry {
  private critics = new Map<string, ICritic>();

  register(critic: ICritic): void {
    this.critics.set(critic.id, critic);
  }

  get(id: string): ICritic | undefined {
    return this.critics.get(id);
  }

  verifyAll(tasks: Task[], before: WorldStateView, after: WorldStateView): Verdict[] {
    const verdicts: Verdict[] = [];
    const critic = this.critics.get('rule');
    if (!critic) return verdicts;
    for (const task of tasks) {
      verdicts.push(critic.verify(task, before, after));
    }
    return verdicts;
  }
}

// ──────────────────────────────────────────────────────────────────
// helper
// ──────────────────────────────────────────────────────────────────

export function makeVerdict(
  task: Task,
  status: VerdictStatus,
  reason: string,
  metrics?: Record<string, unknown>,
): Verdict {
  return {
    taskId: task.id,
    taskKind: task.kind,
    status,
    reason,
    evaluatedAt: Date.now(),
    metrics,
  };
}
