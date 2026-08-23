/**
 * L6 · PreconditionRegistry
 *
 * 框架提供注册能力，业务侧注册具体检查函数。
 * TaskRuntime.start() 调 check() 做 preflight。
 */

import type { WorldStateView } from '../types.js';
import type { Task } from './taskRuntime.js';

export type PreconditionChecker = (task: Task, world: WorldStateView) => boolean;

export class PreconditionRegistry {
  private checkers = new Map<string, PreconditionChecker>();

  register(label: string, checker: PreconditionChecker): void {
    this.checkers.set(label, checker);
  }

  check(labels: string[], task: Task, world: WorldStateView): { ok: boolean; missing: string[] } {
    const missing: string[] = [];
    for (const label of labels) {
      const checker = this.checkers.get(label);
      if (!checker) {
        // 未注册的 precondition 视为不满足
        missing.push(`${label}:unregistered`);
        continue;
      }
      if (!checker(task, world)) {
        missing.push(label);
      }
    }
    return { ok: missing.length === 0, missing };
  }

  has(label: string): boolean {
    return this.checkers.has(label);
  }
}
