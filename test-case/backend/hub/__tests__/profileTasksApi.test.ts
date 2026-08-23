import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createHubServer } from '../../../../apps/minecraft-companion/src/hub/server.js';

const profileInput = (name: string) => ({
  name,
  personality: { description: 'task API contract', style: 'calm' },
  server: { host: '127.0.0.1', port: 25565, auth: 'offline' as const },
});

test('FEAT-WEBUI-18 · Bot 作用域任务路由区分 404/503 并隔离 A/B 数据', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mineclaw-profile-tasks-'));
  const hub = createHubServer({ port: 0, host: '127.0.0.1', dataDir: join(dir, 'data') });
  try {
    const profileA = hub.profileStore.create(profileInput('TaskBotA'));
    const profileB = hub.profileStore.create(profileInput('TaskBotB'));
    await hub.listen();
    const origin = `http://127.0.0.1:${(hub.httpServer.address() as AddressInfo).port}`;

    const originalGetV2Tasks = hub.botManager.getV2Tasks.bind(hub.botManager);
    hub.botManager.getV2Tasks = (botId: string) => {
      if (botId === profileA.id) return [{ id: 'task-a', state: 'running' }];
      if (botId === profileB.id) return [{ id: 'task-b', state: 'paused' }];
      return originalGetV2Tasks(botId);
    };

    const [responseA, responseB] = await Promise.all([
      fetch(`${origin}/api/bots/${profileA.id}/v2/tasks`),
      fetch(`${origin}/api/bots/${profileB.id}/v2/tasks`),
    ]);
    assert.equal(responseA.status, 200);
    assert.equal(responseB.status, 200);
    assert.deepEqual(await responseA.json(), {
      botId: profileA.id,
      tasks: [{ id: 'task-a', state: 'running' }],
    });
    assert.deepEqual(await responseB.json(), {
      botId: profileB.id,
      tasks: [{ id: 'task-b', state: 'paused' }],
    });

    hub.botManager.getV2Tasks = () => null;
    const inactive = await fetch(`${origin}/api/bots/${profileA.id}/v2/tasks`);
    assert.equal(inactive.status, 503);
    assert.match((await inactive.json() as { error: string }).error, /not active/i);

    const missing = await fetch(`${origin}/api/bots/not-a-profile/v2/tasks`);
    assert.equal(missing.status, 404);
    assert.match((await missing.json() as { error: string }).error, /not found/i);

    const legacy = await fetch(`${origin}/api/v2/tasks`);
    assert.equal(legacy.status, 503);
  } finally {
    await hub.botManager.stopAll();
    if (hub.httpServer.listening) {
      await new Promise<void>(resolve => hub.httpServer.close(() => resolve()));
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
