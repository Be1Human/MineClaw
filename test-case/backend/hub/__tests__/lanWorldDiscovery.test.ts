import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { Socket } from 'node:dgram';
import {
  JavaLanWorldDiscovery,
  LanWorldRegistry,
  parseJavaLanAnnouncement,
} from '../../../../apps/minecraft-companion/src/hub/lanWorldDiscovery.js';

class FakeDatagramSocket extends EventEmitter {
  memberships: Array<{ multicastAddress: string; interfaceAddress?: string }> = [];
  boundPort: number | null = null;
  closed = false;

  bind(port: number): void {
    this.boundPort = port;
    queueMicrotask(() => this.emit('listening'));
  }

  addMembership(multicastAddress: string, interfaceAddress?: string): void {
    this.memberships.push({ multicastAddress, interfaceAddress });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }
}

test('FEAT-WEBUI-30-001 | 解析 Java LAN 广播并拒绝无效端口', () => {
  assert.deepEqual(
    parseJavaLanAnnouncement('[MOTD]My\n World[/MOTD][AD]53123[/AD]'),
    { motd: 'My World', port: 53123 },
  );
  assert.deepEqual(
    parseJavaLanAnnouncement('[MOTD][/MOTD][AD]25565[/AD]'),
    { motd: 'Minecraft LAN World', port: 25565 },
  );
  assert.equal(parseJavaLanAnnouncement('[MOTD]No address[/MOTD]'), null);
  assert.equal(parseJavaLanAnnouncement('[MOTD]Bad[/MOTD][AD]0[/AD]'), null);
  assert.equal(parseJavaLanAnnouncement('[MOTD]Bad[/MOTD][AD]65536[/AD]'), null);
  assert.equal(parseJavaLanAnnouncement('[AD]25565[/AD][MOTD]Wrong order[/MOTD]'), null);
});

test('FEAT-WEBUI-30-001 | 候选以来源 IPv4 和端口去重并按最近发现排序', () => {
  const registry = new LanWorldRegistry();
  const first = registry.observe('192.168.1.20', { motd: 'First', port: 51000 }, 10);
  const second = registry.observe('192.168.1.21', { motd: 'Second', port: 52000 }, 20);
  const refreshed = registry.observe('192.168.1.20', { motd: 'First updated', port: 51000 }, 30);

  assert.ok(first);
  assert.ok(second);
  assert.equal(refreshed?.id, first.id);
  assert.equal(registry.list().length, 2);
  assert.deepEqual(registry.list().map(world => world.motd), ['First updated', 'Second']);
  assert.equal(registry.observe('::1', { motd: 'IPv6', port: 53000 }, 40), null);

  const detached = registry.get(first.id)!;
  detached.motd = 'mutated outside';
  assert.equal(registry.get(first.id)?.motd, 'First updated');
});

test('FEAT-WEBUI-30-001 | UDP 监听生命周期发布快照且隔离订阅者异常', async () => {
  const socket = new FakeDatagramSocket();
  const snapshots: string[] = [];
  const discovery = new JavaLanWorldDiscovery({
    now: () => 1234,
    socketFactory: () => socket as unknown as Socket,
    interfaceAddresses: () => ['192.168.1.5'],
  });
  discovery.subscribe(() => { throw new Error('observer failure must not escape'); });
  discovery.subscribe(snapshot => snapshots.push(snapshot.state));

  await discovery.start();
  assert.equal(socket.boundPort, 4445);
  assert.deepEqual(socket.memberships, [{ multicastAddress: '224.0.2.60', interfaceAddress: '192.168.1.5' }]);
  assert.equal(discovery.snapshot().state, 'listening');

  socket.emit(
    'message',
    Buffer.from('[MOTD]Living room[/MOTD][AD]54321[/AD]'),
    { address: '192.168.1.99', family: 'IPv4', port: 4445, size: 47 },
  );
  assert.deepEqual(discovery.snapshot().worlds.map(world => ({
    motd: world.motd,
    host: world.host,
    port: world.port,
    lastSeenAt: world.lastSeenAt,
  })), [{ motd: 'Living room', host: '192.168.1.99', port: 54321, lastSeenAt: 1234 }]);

  discovery.stop();
  assert.equal(socket.closed, true);
  assert.equal(discovery.snapshot().state, 'idle');
  assert.deepEqual(snapshots, ['listening', 'listening', 'idle']);
});

test('FEAT-WEBUI-30-001 | 组播监听失败可见降级且不会拒绝启动', async () => {
  const socket = new FakeDatagramSocket();
  socket.addMembership = () => { throw new Error('membership denied'); };
  const discovery = new JavaLanWorldDiscovery({
    socketFactory: () => socket as unknown as Socket,
    interfaceAddresses: () => ['192.168.1.5'],
  });

  await assert.doesNotReject(discovery.start());
  assert.deepEqual(discovery.snapshot(), {
    state: 'unavailable',
    worlds: [],
    error: 'membership denied',
  });
  assert.equal(socket.closed, true);
  discovery.stop();
  assert.equal(discovery.snapshot().state, 'idle');
});

