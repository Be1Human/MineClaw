import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useProfileTasks } from '../../../../apps/minecraft-companion/web/src/lib/profileTasks.js';

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('Profile 切换会立即清空旧任务，A 的迟到响应不能覆盖 B', async () => {
  const slowA = deferred();
  const requested = [];
  const taskView = useProfileTasks(async path => {
    requested.push(path);
    if (path.includes('/profile-a/')) return slowA.promise;
    return jsonResponse({ botId: 'profile-b', tasks: [{ id: 'task-b' }] });
  });

  const requestA = taskView.selectBot('profile-a');
  assert.equal(taskView.state.value, 'loading');
  assert.deepEqual(taskView.tasks.value, []);

  const requestB = taskView.selectBot('profile-b');
  assert.deepEqual(taskView.tasks.value, []);
  assert.equal(await requestB, true);
  assert.deepEqual(taskView.tasks.value, [{ id: 'task-b' }]);

  slowA.resolve(jsonResponse({ botId: 'profile-a', tasks: [{ id: 'task-a' }] }));
  assert.equal(await requestA, false);
  assert.deepEqual(taskView.tasks.value, [{ id: 'task-b' }]);
  assert.deepEqual(requested, [
    '/api/bots/profile-a/v2/tasks',
    '/api/bots/profile-b/v2/tasks',
  ]);
});

test('接口错误和 botId 不一致时进入错误态且不保留旧任务', async () => {
  const responses = [
    jsonResponse({ botId: 'profile-a', tasks: [{ id: 'old-task' }] }),
    jsonResponse({ error: 'V2 runtime not active for this bot.' }, 503),
    jsonResponse({ botId: 'wrong-profile', tasks: [{ id: 'wrong-task' }] }),
  ];
  const taskView = useProfileTasks(async () => responses.shift());

  assert.equal(await taskView.selectBot('profile-a'), true);
  assert.deepEqual(taskView.tasks.value, [{ id: 'old-task' }]);

  assert.equal(await taskView.refresh(), false);
  assert.equal(taskView.state.value, 'error');
  assert.match(taskView.error.value, /not active/i);
  assert.deepEqual(taskView.tasks.value, []);

  assert.equal(await taskView.refresh({ showLoading: true }), false);
  assert.equal(taskView.state.value, 'error');
  assert.match(taskView.error.value, /不一致/);
  assert.deepEqual(taskView.tasks.value, []);
});
