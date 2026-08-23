import { createHash, randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConnectionConfig } from './types.js';

interface LeaseRecord {
  version: 1;
  key: string;
  pid: number;
  ownerToken: string;
  acquiredAt: string;
}

export interface GameConnectionLeaseOptions {
  lockRoot?: string;
  isProcessAlive?: (pid: number) => boolean;
}

export class GameIdentityInUseError extends Error {
  constructor(readonly identityKey: string, readonly holderPid: number | null) {
    super(`游戏身份已被占用：${identityKey}${holderPid ? `（进程 ${holderPid}）` : ''}。请关闭重复运行的 MineClaw，或为每个伙伴配置不同的游戏用户名。`);
    this.name = 'GameIdentityInUseError';
  }
}

export class GameConnectionLease {
  private readonly lockRoot: string;
  private readonly isProcessAlive: (pid: number) => boolean;
  private held: { path: string; record: LeaseRecord } | null = null;

  constructor(options: GameConnectionLeaseOptions = {}) {
    this.lockRoot = options.lockRoot ?? join(tmpdir(), 'mineclaw-game-connection-leases');
    this.isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
  }

  acquire(config: Pick<ConnectionConfig, 'host' | 'port' | 'auth' | 'username'>): void {
    const key = gameIdentityKey(config);
    if (this.held?.record.key === key) return;
    const previous = this.held;

    mkdirSync(this.lockRoot, { recursive: true });
    const path = this.lockPathFor(config);
    const record: LeaseRecord = {
      version: 1,
      key,
      pid: process.pid,
      ownerToken: randomUUID(),
      acquiredAt: new Date().toISOString(),
    };

    for (let attempt = 0; attempt < 2; attempt++) {
      let fd: number | null = null;
      try {
        fd = openSync(path, 'wx', 0o600);
        writeFileSync(fd, JSON.stringify(record), 'utf8');
        closeSync(fd);
        fd = null;
        if (previous) this.releaseHeld(previous);
        this.held = { path, record };
        return;
      } catch (error) {
        if (fd !== null) {
          try { closeSync(fd); } catch { /* ignore */ }
          try { unlinkSync(path); } catch { /* ignore */ }
        }
        if (!isAlreadyExists(error)) throw error;
        const existing = readLeaseRecord(path);
        if (existing && !this.isProcessAlive(existing.pid)) {
          try { unlinkSync(path); } catch { /* another contender won the race */ }
          continue;
        }
        throw new GameIdentityInUseError(key, existing?.pid ?? null);
      }
    }
    throw new GameIdentityInUseError(key, readLeaseRecord(path)?.pid ?? null);
  }

  release(): void {
    const held = this.held;
    this.held = null;
    if (!held) return;
    this.releaseHeld(held);
  }

  private releaseHeld(held: { path: string; record: LeaseRecord }): void {
    const current = readLeaseRecord(held.path);
    if (!current || current.ownerToken !== held.record.ownerToken) return;
    try { unlinkSync(held.path); } catch { /* already released */ }
  }

  lockPathFor(config: Pick<ConnectionConfig, 'host' | 'port' | 'auth' | 'username'>): string {
    const digest = createHash('sha256').update(gameIdentityKey(config)).digest('hex');
    return join(this.lockRoot, `${digest}.lock`);
  }
}

export function gameIdentityKey(config: Pick<ConnectionConfig, 'host' | 'port' | 'auth' | 'username'>): string {
  const host = config.host.trim().replace(/\.$/, '').toLowerCase();
  const username = config.username.trim().toLowerCase();
  return `${config.auth.toLowerCase()}://${username}@${host}:${config.port}`;
}

function readLeaseRecord(path: string): LeaseRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<LeaseRecord>;
    if (parsed.version !== 1 || typeof parsed.key !== 'string' || typeof parsed.pid !== 'number'
      || typeof parsed.ownerToken !== 'string' || typeof parsed.acquiredAt !== 'string') return null;
    return parsed as LeaseRecord;
  } catch { return null; }
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as { code?: string }).code === 'EEXIST';
}

function defaultIsProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return typeof error === 'object' && error !== null && 'code' in error
      && (error as { code?: string }).code === 'EPERM';
  }
}
