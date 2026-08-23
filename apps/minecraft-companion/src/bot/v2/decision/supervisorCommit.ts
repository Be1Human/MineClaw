/**
 * 🛠 Supervisor · commit() 副作用执行器
 *
 * 接受 decide() 输出的 Action[]，执行到各 sink。
 * 与 decide() 分离，保持 decide 可纯函数测试。
 */

import type { Action, SupervisorState } from './supervisorDecide.js';
import type { TaskRuntime } from '../task/taskRuntime.js';
import type { EventBusV2 } from '../infra/eventBus.js';
import type { NarrationSink } from './supervisor.js';
import type { EventLevel } from '../types.js';
import type { ISubtaskInjector } from '../task/subtaskInjector.js';

export interface CommitSinks {
  tasks: TaskRuntime;
  narration: NarrationSink | null;
  bus: EventBusV2;
  injector?: ISubtaskInjector | null;
}

export function commit(
  actions: Action[],
  state: SupervisorState,
  sinks: CommitSinks,
): void {
  for (const a of actions) {
    switch (a.kind) {
      case 'l6.pause':
        sinks.tasks.pause(a.taskId, a.resumePoint, 'automatic');
        break;
      case 'l6.resume':
        sinks.tasks.resume(a.taskId);
        // 重置卡死计时器 · 避免 resume 后立即被判为 stuck
        state.lastProgressTick.delete(a.taskId);
        // 恢复后重置恢复次数 · 允许下一次独立的恢复尝试
        state.recoveryAttempts.delete(a.taskId);
        break;
      case 'l6.fail':
        sinks.tasks.fail(a.taskId, a.reason);
        break;
      case 'state.add_suspended':
        state.suspendedByDanger.add(a.taskId);
        break;
      case 'state.remove_suspended':
        state.suspendedByDanger.delete(a.taskId);
        break;
      case 'state.push_diagnosis':
        state.recentDiagnoses.push(a.diagnosis);
        break;
      case 'hb.submitSay':
        // FEAT-NARR-01：有 topic 且中枢可用 → 走统一语言中枢出中性通知；否则回退旧 submitSay
        if (a.topic && sinks.narration?.narrate) {
          sinks.narration.narrate({ source: 'supervisor', topic: a.topic, urgency: a.priority ?? 50 });
        } else if (a.text) {
          sinks.narration?.submitSay('supervisor', a.text, a.priority);
        }
        break;
      case 'l6.inject':
        sinks.injector?.inject(a.parentTaskId, a.suggestion);
        break;
      case 'bus.publish':
        sinks.bus.publish(a.eventType, a.level as EventLevel, a.payload);
        break;
    }
  }
}
