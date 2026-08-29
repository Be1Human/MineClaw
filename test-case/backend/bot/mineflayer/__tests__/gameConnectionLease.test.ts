import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

test('BUG-CROSS-82 | reused PID with a different process instance reclaims the stale lease', () => {
  const root = makeRoot();
  const oldProcess = new GameConnectionLease({
    lockRoot: root,
    isProcessAlive: () => true,
    processPid: 38_688,
    processInstanceId: 'old-process-instance',
  });
  const currentProcess = new GameConnectionLease({
    lockRoot: root,
    isProcessAlive: () => true,
    processPid: 38_688,
    processInstanceId: 'current-process-instance',
  });

  oldProcess.acquire(identity);
  currentProcess.acquire(identity);
  const record = JSON.parse(readFileSync(currentProcess.lockPathFor(identity), 'utf8'));
  assert.equal(record.version, 2);
  assert.equal(record.processInstanceId, 'current-process-instance');

  oldProcess.release();
  assert.equal(readFileSync(currentProcess.lockPathFor(identity), 'utf8').length > 0, true);
  currentProcess.release();
});

test('BUG-CROSS-82 | expired heartbeat is reclaimed even when its PID has been reused elsewhere', () => {
  const root = makeRoot();
  let now = Date.parse('2026-08-29T07:00:00.000Z');
  const oldProcess = new GameConnectionLease({
    lockRoot: root,
    isProcessAlive: () => true,
    now: () => now,
    processPid: 10_001,
    processInstanceId: 'old-process-instance',
  });
  oldProcess.acquire(identity);

  now += 61_000;
  const currentProcess = new GameConnectionLease({
    lockRoot: root,
    isProcessAlive: () => true,
    getTiming: () => ({ heartbeatIntervalMs: 5_000, staleAfterMs: 60_000 }),
    now: () => now,
    processPid: 20_002,
    processInstanceId: 'current-process-instance',
  });
  currentProcess.acquire(identity);
  const record = JSON.parse(readFileSync(currentProcess.lockPathFor(identity), 'utf8'));
  assert.equal(record.pid, 20_002);

  oldProcess.release();
  currentProcess.release();
});

test('BUG-CROSS-82 | heartbeat refreshes the current owner record', async () => {
  const root = makeRoot();
  const lease = new GameConnectionLease({
    lockRoot: root,
    isProcessAlive: () => true,
    getTiming: () => ({ heartbeatIntervalMs: 5, staleAfterMs: 1_000 }),
  });
  const path = lease.lockPathFor(identity);
  lease.acquire(identity);
  const before = JSON.parse(readFileSync(path, 'utf8'));

  await new Promise(resolve => setTimeout(resolve, 30));

  const after = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(after.ownerToken, before.ownerToken);
  assert.ok(Date.parse(after.heartbeatAt) > Date.parse(before.heartbeatAt));
  lease.release();
});

test('BUG-CROSS-82 | legacy v1 lease predating the current same-PID process migrates to v2', () => {
  const root = makeRoot();
  const lease = new GameConnectionLease({
    lockRoot: root,
    isProcessAlive: () => true,
    processPid: 38_688,
    processInstanceId: 'current-process-instance',
    processStartedAt: Date.parse('2026-08-29T07:43:51.000Z'),
  });
  const path = lease.lockPathFor(identity);
  writeFileSync(path, JSON.stringify({
    version: 1,
    key: gameIdentityKey(identity),
    pid: 38_688,
    ownerToken: 'legacy-owner',
    acquiredAt: '2026-08-29T07:00:55.000Z',
  }));

  lease.acquire(identity);
  const record = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(record.version, 2);
  assert.equal(record.processInstanceId, 'current-process-instance');
  lease.release();
});
