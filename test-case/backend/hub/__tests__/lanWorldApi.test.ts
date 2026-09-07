import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHubServer } from '../../../../apps/minecraft-companion/src/hub/server.js';
import type {
  DiscoveredLanWorld,
  LanWorldDiscoveryPort,
  LanWorldDiscoverySnapshot,
} from '../../../../apps/minecraft-companion/src/hub/lanWorldDiscovery.js';

const requireFromWeb = createRequire(new URL('../../../../apps/minecraft-companion/web/package.json', import.meta.url));
const { io: createClient } = requireFromWeb('socket.io-client') as {
  io: (url: string, options: Record<string, unknown>) => {
    on(event: string, listener: (...args: any[]) => void): void;
    connect(): void;
    close(): void;
  };
};

class FakeLanWorldDiscovery implements LanWorldDiscoveryPort {
  started = 0;
  stopped = 0;
  private listeners = new Set<(snapshot: LanWorldDiscoverySnapshot) => void>();

  constructor(private current: LanWorldDiscoverySnapshot) {}

  async start(): Promise<void> { this.started += 1; }
  stop(): void { this.stopped += 1; }
  snapshot(): LanWorldDiscoverySnapshot { return structuredClone(this.current); }
  get(worldId: string): DiscoveredLanWorld | undefined {
    const world = this.current.worlds.find(candidate => candidate.id === worldId);
    return world ? { ...world } : undefined;
  }
  subscribe(listener: (snapshot: LanWorldDiscoverySnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  publish(snapshot: LanWorldDiscoverySnapshot): void {
    this.current = structuredClone(snapshot);
    for (const listener of this.listeners) listener(this.snapshot());
  }
}

test('FEAT-WEBUI-30-001 | Hub 通过 REST 与 Socket.IO 发布同一 LAN 候选快照', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mineclaw-lan-api-'));
  const discovery = new FakeLanWorldDiscovery({ state: 'listening', worlds: [] });
  const hub = createHubServer(
    { port: 0, host: '127.0.0.1', dataDir: join(dir, 'data') },
    undefined,
    { lanWorldDiscovery: discovery },
  );
  let client: ReturnType<typeof createClient> | undefined;
  try {
    await hub.listen();
    const origin = `http://127.0.0.1:${(hub.httpServer.address() as AddressInfo).port}`;
    assert.equal(discovery.started, 1);

    const rest = await fetch(`${origin}/api/minecraft/lan-worlds`);
    assert.equal(rest.status, 200);
    assert.deepEqual(await rest.json(), { state: 'listening', worlds: [] });

    client = createClient(origin, { transports: ['websocket'], autoConnect: false });
    const snapshots: LanWorldDiscoverySnapshot[] = [];
    const received = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('LAN world socket snapshot timeout')), 3_000);
      client!.on('connect_error', (error: Error) => { clearTimeout(timeout); reject(error); });
      client!.on('minecraft:lan-worlds', (snapshot: LanWorldDiscoverySnapshot) => {
        snapshots.push(snapshot);
        if (snapshots.length === 2) { clearTimeout(timeout); resolve(); }
      });
    });
    client.connect();
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('initial LAN world socket snapshot timeout')), 3_000);
      const poll = (): void => {
        if (snapshots.length > 0) { clearTimeout(timeout); resolve(); return; }
        setTimeout(poll, 5);
      };
      poll();
    });
    discovery.publish({
      state: 'listening',
      worlds: [{ id: 'world-1', motd: 'Shared world', host: '192.168.1.8', port: 51234, lastSeenAt: 456 }],
    });
    await received;
    assert.deepEqual(snapshots[1]?.worlds[0], {
      id: 'world-1', motd: 'Shared world', host: '192.168.1.8', port: 51234, lastSeenAt: 456,
    });
  } finally {
    client?.close();
    await hub.botManager.stopAll();
    if (hub.httpServer.listening) await new Promise<void>(resolve => hub.httpServer.close(() => resolve()));
    assert.equal(discovery.stopped, 1);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('FEAT-WEBUI-30-002 | 一键加入只接受已发现 worldId 且不改写 Profile 服务器', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mineclaw-lan-join-'));
  const dataDir = join(dir, 'data');
  const world: DiscoveredLanWorld = {
    id: 'world-join', motd: 'Friend LAN', host: '192.168.1.19', port: 50123, lastSeenAt: 789,
  };
  const discovery = new FakeLanWorldDiscovery({ state: 'listening', worlds: [world] });
  const hub = createHubServer(
    { port: 0, host: '127.0.0.1', dataDir },
    undefined,
    { lanWorldDiscovery: discovery },
  );
  try {
    const profile = hub.profileStore.create({
      name: 'LanJoiner',
      personality: { description: 'LAN API contract', style: 'calm' },
      server: { host: 'saved.example.test', port: 25565, version: '1.21.1', auth: 'microsoft' },
    });
    const profilePath = join(dataDir, 'profiles', `${profile.id}.json`);
    const persistedBefore = readFileSync(profilePath, 'utf8');
    await hub.listen();
    const origin = `http://127.0.0.1:${(hub.httpServer.address() as AddressInfo).port}`;
    let joined: { botId: string; host: string; port: number } | undefined;
    hub.botManager.joinLanWorld = async (botId, _profile, target) => {
      joined = { botId, ...target };
      return hub.botManager.getFullStatus(botId);
    };

    const missingId = await fetch(`${origin}/api/bots/${profile.id}/join-lan-world`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.equal(missingId.status, 400);
    const unknown = await fetch(`${origin}/api/bots/${profile.id}/join-lan-world`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ worldId: 'unknown' }),
    });
    assert.equal(unknown.status, 404);

    const response = await fetch(`${origin}/api/bots/${profile.id}/join-lan-world`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ worldId: world.id, host: 'attacker.example', port: 1 }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(joined, { botId: profile.id, host: world.host, port: world.port });
    assert.equal(readFileSync(profilePath, 'utf8'), persistedBefore);
    assert.deepEqual(hub.profileStore.get(profile.id)?.server, profile.server);
  } finally {
    await hub.botManager.stopAll();
    if (hub.httpServer.listening) await new Promise<void>(resolve => hub.httpServer.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

