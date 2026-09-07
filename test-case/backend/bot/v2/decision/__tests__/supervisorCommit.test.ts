import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { EventBusV2 } from '../../../../../../apps/minecraft-companion/src/bot/v2/infra/eventBus.js';
import type { TaskRuntime } from '../../../../../../apps/minecraft-companion/src/bot/v2/task/taskRuntime.js';
import { commit } from '../../../../../../apps/minecraft-companion/src/bot/v2/decision/supervisorCommit.js';
import type { SupervisorState } from '../../../../../../apps/minecraft-companion/src/bot/v2/decision/supervisorDecide.js';

test('Supervisor 保留非危险任务失败提交', () => {
  const failures: Array<{ taskId: string; reason: string }> = [];
  const tasks = {
    fail(taskId: string, reason: string) {
      failures.push({ taskId, reason });
    },
  } as unknown as TaskRuntime;
  const state = {
    lastProgressTick: new Map<string, number>(),
    recoveryAttempts: new Map<string, number>(),
  } as unknown as SupervisorState;

  commit(
    [{ kind: 'l6.fail', taskId: 'task-1', reason: 'stuck' }],
    state,
    { tasks, narration: null, bus: {} as EventBusV2 },
  );

  assert.deepEqual(failures, [{ taskId: 'task-1', reason: 'stuck' }]);
});
