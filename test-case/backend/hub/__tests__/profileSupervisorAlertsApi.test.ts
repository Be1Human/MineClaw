import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createHubServer } from '../../../../apps/minecraft-companion/src/hub/server.js';

const profileInput = (name: string) => ({
  name,
  personality: { description: 'supervisor API contract', style: 'calm' },
  server: { host: '127.0.0.1', port: 25565, auth: 'offline' as const },
});

test('FEAT-CROSS-20 · Supervisor 告警接口按 Profile 隔离并区分 404/503', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mineclaw-profile-alerts-'));
  const hub = createHubServer({ port: 0, host: '127.0.0.1', dataDir: join(dir, 'data') });
  try {
    const profileA = hub.profileStore.create(profileInput('AlertBotA'));
    const profileB = hub.profileStore.create(profileInput('AlertBotB'));
    await hub.listen();
    const origin = `http://127.0.0.1:${(hub.httpServer.address() as AddressInfo).port}`;

    hub.botManager.getV2SupervisorAlerts = (botId: string) => {
      if (botId === profileA.id) return { suspendedByDanger: ['task-a'], recentDiagnoses: [], narrationCooldowns: {} };
      if (botId === profileB.id) return { suspendedByDanger: [], recentDiagnoses: [{ category: 'b' }], narrationCooldowns: {} };
      return null;
    };

    const [responseA, responseB] = await Promise.all([
      fetch(`${origin}/api/bots/${profileA.id}/v2/supervisor-alerts`),
      fetch(`${origin}/api/bots/${profileB.id}/v2/supervisor-alerts`),
    ]);
    assert.equal(responseA.status, 200);
    assert.equal(responseB.status, 200);
    assert.deepEqual((await responseA.json() as { suspendedByDanger: string[] }).suspendedByDanger, ['task-a']);
    assert.deepEqual((await responseB.json() as { recentDiagnoses: Array<{ category: string }> }).recentDiagnoses, [{ category: 'b' }]);

    hub.botManager.getV2SupervisorAlerts = () => null;
    assert.equal((await fetch(`${origin}/api/bots/${profileA.id}/v2/supervisor-alerts`)).status, 503);
    assert.equal((await fetch(`${origin}/api/bots/not-a-profile/v2/supervisor-alerts`)).status, 404);
  } finally {
    await hub.botManager.stopAll();
    if (hub.httpServer.listening) {
      await new Promise<void>(resolve => hub.httpServer.close(() => resolve()));
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
