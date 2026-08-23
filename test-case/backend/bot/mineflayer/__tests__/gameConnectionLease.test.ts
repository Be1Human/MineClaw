import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import {
  GameConnectionLease,
  GameIdentityInUseError,
  gameIdentityKey,
} from '../../../../../apps/minecraft-companion/src/bot/mineflayer/gameConnectionLease.js';

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'mineclaw-lease-test-'));
  tempRoots.push(root);
  return root;
}

const identity = {
  host: '127.0.0.1',
  port: 25565,
  auth: 'offline' as const,
  username: 'LanYi',
};

test('TC-L1-01/02: same server identity has exactly one holder', () => {
  const root = makeRoot();
  const first = new GameConnectionLease({ lockRoot: root, isProcessAlive: () => true });
  const second = new GameConnectionLease({ lockRoot: root, isProcessAlive: () => true });

  first.acquire(identity);
  first.acquire(identity);
  assert.throws(() => second.acquire(identity), (error: unknown) => {
    assert.ok(error instanceof GameIdentityInUseError);
    assert.match(error.message, /每个伙伴配置不同的游戏用户名/);
    return true;
  });

  first.release();
  second.acquire(identity);
  second.release();
});

test('TC-L1-03: different usernames on the same server do not conflict', () => {
  const root = makeRoot();
  const first = new GameConnectionLease({ lockRoot: root, isProcessAlive: () => true });
  const second = new GameConnectionLease({ lockRoot: root, isProcessAlive: () => true });
  first.acquire(identity);
  second.acquire({ ...identity, username: 'XiaoXin' });
  first.release();
  second.release();
});

test('TC-L1-04: stale lease is reclaimed only after its process is dead', () => {
  const root = makeRoot();
  const lease = new GameConnectionLease({ lockRoot: root, isProcessAlive: pid => pid !== 999_999 });
  const path = lease.lockPathFor(identity);
  writeFileSync(path, JSON.stringify({
    version: 1,
    key: gameIdentityKey(identity),
    pid: 999_999,
    ownerToken: 'stale-owner',
    acquiredAt: '2026-01-01T00:00:00.000Z',
  }));

  lease.acquire(identity);
  lease.release();
});

test('failed identity switch keeps the previous live lease', () => {
  const root = makeRoot();
  const first = new GameConnectionLease({ lockRoot: root, isProcessAlive: () => true });
  const second = new GameConnectionLease({ lockRoot: root, isProcessAlive: () => true });
  const observer = new GameConnectionLease({ lockRoot: root, isProcessAlive: () => true });
  const otherIdentity = { ...identity, username: 'XiaoXin' };

  first.acquire(identity);
  second.acquire(otherIdentity);
  assert.throws(() => first.acquire(otherIdentity), GameIdentityInUseError);
  assert.throws(() => observer.acquire(identity), GameIdentityInUseError);

  first.release();
  second.release();
});
