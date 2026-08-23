import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { EventBusV2 } from '../../../../../../apps/minecraft-companion/src/bot/v2/infra/eventBus.js';
import type { TaskRuntime, TaskResumePolicy } from '../../../../../../apps/minecraft-companion/src/bot/v2/task/taskRuntime.js';
import { commit } from '../../../../../../apps/minecraft-companion/src/bot/v2/decision/supervisorCommit.js';
import type { SupervisorState } from '../../../../../../apps/minecraft-companion/src/bot/v2/decision/supervisorDecide.js';

test('BUG-CROSS-56-005 · Supervisor 中断写入 automatic 恢复策略', () => {
  const pauses: Array<{
    taskId: string;
    resumePoint?: Record<string, unknown>;
    policy?: TaskResumePolicy;
  }> = [];
  const tasks = {
    pause(taskId: string, resumePoint?: Record<string, unknown>, policy?: TaskResumePolicy) {
      pauses.push({ taskId, resumePoint, policy });
    },
  } as unknown as TaskRuntime;
  const state = {
    lastProgressTick: new Map<string, number>(),
    recoveryAttempts: new Map<string, number>(),
  } as unknown as SupervisorState;

  commit(
    [{ kind: 'l6.pause', taskId: 'task-1', resumePoint: { suspendedAtMs: 123 } }],
    state,
    { tasks, narration: null, bus: {} as EventBusV2 },
  );

  assert.deepEqual(pauses, [{
    taskId: 'task-1',
    resumePoint: { suspendedAtMs: 123 },
    policy: 'automatic',
  }]);
});
