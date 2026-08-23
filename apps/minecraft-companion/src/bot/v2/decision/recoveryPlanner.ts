/**
 * RecoveryPlanner — 纯函数 · 根据诊断 + 任务上下文决定恢复策略
 *
 * 输入：Diagnosis + 当前任务 + WorldState + Config + 已有恢复次数
 * 输出：RecoveryVerdict（subtask | ask_master | abort）
 *
 * 无副作用，可单元测试。
 */

import type { Diagnosis } from './supervisor.js';
import type { Task } from '../task/taskRuntime.js';
import type { WorldStateView } from '../types.js';
import type { SupervisorConfig } from './supervisorDecide.js';
import type { SubtaskSuggestion } from '../task/subtaskInjector.js';

// ──────────────────────────────────────────────────────────────────
// RecoveryVerdict
// ──────────────────────────────────────────────────────────────────

export type RecoveryVerdict =
  | { kind: 'subtask'; suggestion: SubtaskSuggestion }
  | { kind: 'ask_master'; reason: string }
  | { kind: 'abort'; reason: string };

// ──────────────────────────────────────────────────────────────────
// planRecovery — pure function
// ──────────────────────────────────────────────────────────────────

export function planRecovery(
  diag: Diagnosis,
  task: Task,
  _world: WorldStateView | null,
  cfg: SupervisorConfig,
  recoveryAttempts: Map<string, number>,
): RecoveryVerdict {
  // 超出最大恢复次数 → 放弃
  const attempts = recoveryAttempts.get(task.id) ?? 0;
  if (attempts >= cfg.RECOVERY_MAX_ATTEMPTS) {
    return { kind: 'abort', reason: 'max_attempts_reached' };
  }

  // 卡死 → 重置寻路器（带超时兜底，防止子任务无实现时卡死父任务）
  if (diag.category === 'stuck') {
    return {
      kind: 'subtask',
      suggestion: {
        kind: 'reset_pathfinder',
        params: { taskId: task.id, _timeoutMs: 10000 },
        timeoutMs: 10000,
      },
    };
  }

  // 资源缺失 或 未知类型（来自 tool_broken）
  if (diag.category === 'resource_missing' || diag.category === 'unknown') {
    const hoeName = (task.params as Record<string, unknown>)?.hoeName as string | undefined;
    if (hoeName) {
      return {
        kind: 'subtask',
        suggestion: {
          kind: 'craft_item',
          params: {
            // SubtaskInjector 直连 L6，不经过 L7 SlotNormalizer；必须使用 CraftBehavior
            // 与 craft_item.task.yaml 共同约定的 canonical slot `item`。
            item: hoeName,
            recipe: ['wooden_planks:2', 'stick:2'],
          },
        },
      };
    }
    return { kind: 'ask_master', reason: 'cannot_auto_recover' };
  }

  // 默认兜底
  return { kind: 'ask_master', reason: 'unknown_category' };
}
