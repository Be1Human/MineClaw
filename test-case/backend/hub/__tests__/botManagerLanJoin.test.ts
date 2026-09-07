import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BotManager } from '../../../../apps/minecraft-companion/src/hub/botManager.js';
import type { BotProfile } from '../../../../apps/minecraft-companion/src/hub/profileStore.js';

function profile(id: string): BotProfile {
  return {
    id,
    name: 'LanBot',
    personality: { description: 'LAN switch contract', style: 'calm' },
    server: { host: 'saved.example.test', port: 25565, version: '1.21.1', auth: 'microsoft' },
    createdAt: 1,
    updatedAt: 1,
  };
}

test('FEAT-WEBUI-30-002 | BotManager 完整切换到临时 LAN 连接并隔离皮肤同步', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mineclaw-lan-manager-'));
  let embodied = true;
  const calls: Array<{ type: string; connection?: Record<string, unknown> }> = [];
  let skinPrepareCalls = 0;
  const runtime = {
    getFullStatus: () => ({ status: embodied ? 'online' : 'awake', connectionStatus: embodied ? 'connected' : 'disconnected', embodied }),
    getStatus: () => embodied ? 'online' : 'offline',
    leaveGame: async () => { calls.push({ type: 'leave' }); embodied = false; },
    joinGame: async (connection?: Record<string, unknown>) => {
      calls.push({ type: 'join', connection });
      embodied = true;
      return { ok: true };
    },
    applyServerSkin: async () => undefined,
  };
  const skinSyncService = {
    prepare: async () => {
      skinPrepareCalls += 1;
      return { state: 'unsupported', reasonCode: 'disabled', message: 'disabled' };
    },
  };
  const manager = new BotManager(dir, undefined, undefined, skinSyncService as never);
  const activeProfile = profile('lan-bot');
  const entry = {
    runtime,
    profile: activeProfile,
    skinSyncRun: 0,
    connectionSource: 'profile',
    instance: {
      id: activeProfile.id,
      profileId: activeProfile.id,
      status: 'online',
      fullStatus: runtime.getFullStatus(),
      skinSync: { state: 'idle', message: 'not joined', updatedAt: 1 },
      startedAt: 1,
    },
  };
  const internal = manager as unknown as {
    instances: Map<string, typeof entry>;
    handleGameJoined(current: typeof entry): void;
  };
  internal.instances.set(activeProfile.id, entry);

  try {
    const status = await manager.joinLanWorld(activeProfile.id, activeProfile, { host: '192.168.1.9', port: 51234 });
    assert.equal(status?.embodied, true);
    assert.deepEqual(calls, [
      { type: 'leave' },
      { type: 'join', connection: { host: '192.168.1.9', port: 51234, version: undefined, auth: 'offline' } },
    ]);
    assert.equal(entry.connectionSource, 'lan');

    internal.handleGameJoined(entry);
    assert.equal(skinPrepareCalls, 0);
    assert.equal(entry.instance.skinSync.state, 'unsupported');
    assert.match(entry.instance.skinSync.message ?? '', /局域网世界/);

    await manager.joinGame(activeProfile.id, activeProfile);
    assert.equal(entry.connectionSource, 'profile');
    internal.handleGameJoined(entry);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(skinPrepareCalls, 1);
  } finally {
    internal.instances.clear();
    rmSync(dir, { recursive: true, force: true });
  }
});

