import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureEmbodiedOnline } from '../../../benchmark/engineering/experience/backendLifecycle.js';

function harness(statuses: string[]) {
  const calls: string[] = [];
  let index = 0;
  return {
    calls,
    options: {
      profileId: 'profile-1',
      getStatus: async () => statuses[Math.min(index++, statuses.length - 1)],
      post: async (path: string) => { calls.push(path); },
      sleep: async () => {},
      attempts: 3,
      intervalMs: 1,
    },
  };
}

test('BUG-CROSS-13 · 已在线时不重复启动或进服', async () => {
  const h = harness(['online']);
  await ensureEmbodiedOnline(h.options);
  assert.deepEqual(h.calls, []);
});

test('BUG-CROSS-13 · 未创建实例时先 start 再 join-game', async () => {
  const h = harness(['unknown', 'awake', 'online']);
  await ensureEmbodiedOnline(h.options);
  assert.deepEqual(h.calls, [
    '/api/bots/profile-1/start',
    '/api/bots/profile-1/join-game',
  ]);
});

test('BUG-CROSS-13 · awake/reconnecting 只需重新挂载身体', async () => {
  for (const initial of ['awake', 'reconnecting']) {
    const h = harness([initial, 'online']);
    await ensureEmbodiedOnline(h.options);
    assert.deepEqual(h.calls, ['/api/bots/profile-1/join-game']);
  }
});

test('BUG-CROSS-13 · 超时错误包含最终状态', async () => {
  const h = harness(['awake', 'awake', 'awake', 'awake', 'reconnecting']);
  await assert.rejects(ensureEmbodiedOnline(h.options), /当前状态=reconnecting/);
});
