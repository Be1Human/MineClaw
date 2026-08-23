/**
 * L6 · SubtaskInjector — 子任务注入器
 *
 * 职责：
 *   - 接收 Supervisor / MainBrain 发出的 SubtaskSuggestion
 *   - 在 TaskRuntime 里创建对应子任务
 *   - 暂停父任务（让子任务先跑）
 *   - TaskRuntime.complete() 里自动唤醒父任务（见 taskRuntime.ts 修改）
 *
 * 接口定义放在本文件，其他模块 import 本文件即可，无循环依赖。
 */

import type { TaskRuntime } from './taskRuntime.js';
import type { EventBusV2 } from '../infra/eventBus.js';

// ──────────────────────────────────────────────────────────────────
// 公开接口
// ──────────────────────────────────────────────────────────────────

export interface SubtaskSuggestion {
  kind: 'fetch_from_chest' | 'craft_item' | 'reset_pathfinder';
  params: Record<string, unknown>;
  /** 子任务完成后是否自动恢复父任务（默认 true） */
  autoResumeParent?: boolean;
  /** 子任务优先级（默认 50） */
  priority?: number;
  /** 子任务超时 ms（默认无限制） */
  timeoutMs?: number;
}

export interface InjectionResult {
  ok: boolean;
  subtaskId?: string;
  error?: string;
}

export interface ISubtaskInjector {
  inject(parentTaskId: string, suggestion: SubtaskSuggestion): InjectionResult;
  isAlive(subtaskId: string): boolean;
}

// ──────────────────────────────────────────────────────────────────
// 实现
// ──────────────────────────────────────────────────────────────────

export class SubtaskInjector implements ISubtaskInjector {
  constructor(
    private readonly tasks: TaskRuntime,
    private readonly bus: EventBusV2,
  ) {}

  /**
   * 注入子任务流程：
   *   1. 检查父任务存在且 running
   *   2. createSubtask → 得到子任务（pending）
   *   3. pause(parentId)
   *   4. 把子任务推入栈顶（TaskRuntime.pushToStack）
   *   5. 返回 subtaskId
   */
  inject(parentTaskId: string, suggestion: SubtaskSuggestion): InjectionResult {
    const parent = this.tasks.getById(parentTaskId);
    if (!parent) {
      return { ok: false, error: `parent_task_not_found:${parentTaskId}` };
    }
    if (parent.state !== 'running') {
      return { ok: false, error: `parent_task_not_running:${parent.state}` };
    }

    // 创建子任务
    const subtask = this.tasks.createSubtask(suggestion, parentTaskId);

    // 暂停父任务，保留断点
    this.tasks.pause(parentTaskId, { pausedForSubtask: subtask.id });

    // 把子任务压栈（使其成为当前 active）
    this.tasks.pushToStack(subtask.id);

    this.bus.publish('task.subtask_injected', 'info', {
      parentTaskId,
      subtaskId: subtask.id,
      kind: suggestion.kind,
    });

    return { ok: true, subtaskId: subtask.id };
  }

  /** 子任务是否仍在运行或暂停中（即"还活着"） */
  isAlive(subtaskId: string): boolean {
    const t = this.tasks.getById(subtaskId);
    if (!t) return false;
    return t.state === 'running' || t.state === 'paused';
  }
}
