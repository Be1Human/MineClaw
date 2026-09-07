import assert from 'node:assert/strict';
import { createSocket } from 'node:dgram';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHubServer } from '../../../apps/minecraft-companion/src/hub/server.js';

const multicastAddress = '224.0.2.60';
const multicastPort = 4445;
const minecraftPort = Number(process.env.MINECLAW_SMOKE_MINECRAFT_PORT ?? 25565);
const dataRoot = mkdtempSync(join(tmpdir(), 'mineclaw-lan-join-smoke-'));
const dataDir = join(dataRoot, 'data');
const hub = createHubServer({ port: 0, host: '127.0.0.1', dataDir });
const sender = createSocket('udp4');

async function waitFor<T>(read: () => Promise<T | undefined>, label: string, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`${label} timed out after ${timeoutMs}ms`);
}

try {
  const profile = hub.profileStore.create({
    name: `LanSmoke${String(Date.now()).slice(-6)}`,
    personality: { description: 'temporary LAN join smoke profile', style: 'calm' },
    server: { host: 'saved.example.test', port: 25565, version: '1.21.1', auth: 'microsoft' },
  });
  const profilePath = join(dataDir, 'profiles', `${profile.id}.json`);
  const persistedBefore = readFileSync(profilePath, 'utf8');
  await hub.listen();
  const origin = `http://127.0.0.1:${(hub.httpServer.address() as AddressInfo).port}`;
  const motd = `MineClaw join smoke ${Date.now()}`;
  const payload = Buffer.from(`[MOTD]${motd}[/MOTD][AD]${minecraftPort}[/AD]`);

  await new Promise<void>((resolve, reject) => {
    sender.once('error', reject);
    sender.bind(0, () => {
      sender.setMulticastTTL(1);
      sender.setMulticastLoopback(true);
      sender.send(payload, multicastPort, multicastAddress, error => error ? reject(error) : resolve());
    });
  });

  const world = await waitFor(async () => {
    const response = await fetch(`${origin}/api/minecraft/lan-worlds`);
    assert.equal(response.status, 200);
    const snapshot = await response.json() as { worlds: Array<{ id: string; motd: string; host: string; port: number }> };
    return snapshot.worlds.find(candidate => candidate.motd === motd);
  }, 'LAN candidate');

  const joined = await fetch(`${origin}/api/bots/${profile.id}/join-lan-world`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ worldId: world.id }),
  });
  const status = await joined.json() as { embodied?: boolean; connectionStatus?: string; lastError?: string };
  assert.equal(joined.status, 200, JSON.stringify(status));
  assert.equal(status.embodied, true);
  assert.equal(status.connectionStatus, 'connected');
  assert.equal(readFileSync(profilePath, 'utf8'), persistedBefore);
  console.log(JSON.stringify({ world, bot: { id: profile.id, name: profile.name }, status: {
    embodied: status.embodied,
    connectionStatus: status.connectionStatus,
  }, profileUnchanged: true }, null, 2));
} finally {
  await new Promise<void>(resolve => sender.close(() => resolve()));
  await hub.botManager.stopAll();
  hub.io.disconnectSockets(true);
  if (hub.httpServer.listening) {
    const closed = new Promise<void>(resolve => hub.httpServer.close(() => resolve()));
    hub.httpServer.closeAllConnections();
    await closed;
  }
  void hub.io.close();
  rmSync(dataRoot, { recursive: true, force: true });
}

// 独立冒烟进程已清理自身 UDP、HTTP、Socket.IO、BotRuntime 和临时目录；
// 等待底层网络句柄完成 close 回调后退出，避免第三方全局观察器让脚本常驻。
await new Promise(resolve => setTimeout(resolve, 1_000));
process.exit(0);
