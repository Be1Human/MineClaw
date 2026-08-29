import { createHash, randomUUID } from 'node:crypto';
import { closeSync, ftruncateSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConnectionConfig } from './types.js';

interface LeaseRecordV1 {
  version: 1;
  key: string;
  pid: number;
  ownerToken: string;
  acquiredAt: string;
}

interface LeaseRecordV2 {
  version: 2;
  key: string;
  pid: number;
  processInstanceId: string;
  ownerToken: string;
  acquiredAt: string;
  heartbeatAt: string;
}

type LeaseRecord = LeaseRecordV1 | LeaseRecordV2;

export interface GameConnectionLeaseTiming {
  heartbeatIntervalMs: number;
  staleAfterMs: number;
}

export interface GameConnectionLeaseOptions {
  lockRoot?: string;
  isProcessAlive?: (pid: number) => boolean;
  getTiming?: () => GameConnectionLeaseTiming | null;
  now?: () => number;
  processPid?: number;
  processInstanceId?: string;
  processStartedAt?: number;
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
  private readonly getTiming: () => GameConnectionLeaseTiming | null;
  private readonly now: () => number;
  private readonly processPid: number;
  private readonly processInstanceId: string;
  private readonly processStartedAt: number;
  private held: { path: string; record: LeaseRecordV2 } | null = null;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: GameConnectionLeaseOptions = {}) {
    this.lockRoot = options.lockRoot ?? join(tmpdir(), 'mineclaw-game-connection-leases');
    this.isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
    this.getTiming = options.getTiming ?? (() => null);
    this.now = options.now ?? Date.now;
    this.processPid = options.processPid ?? process.pid;
    this.processInstanceId = options.processInstanceId ?? PROCESS_INSTANCE_ID;
    this.processStartedAt = options.processStartedAt ?? PROCESS_STARTED_AT;
  }

  acquire(config: Pick<ConnectionConfig, 'host' | 'port' | 'auth' | 'username'>): void {
    const key = gameIdentityKey(config);
    if (this.held?.record.key === key) return;
    const previous = this.held;

    mkdirSync(this.lockRoot, { recursive: true });
    const path = this.lockPathFor(config);
    const acquiredAt = new Date(this.now()).toISOString();
    const record: LeaseRecordV2 = {
      version: 2,
      key,
      pid: this.processPid,
      processInstanceId: this.processInstanceId,
      ownerToken: randomUUID(),
      acquiredAt,
      heartbeatAt: acquiredAt,
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
        registerActiveLease(this);
        this.scheduleHeartbeat();
        return;
      } catch (error) {
        if (fd !== null) {
          try { closeSync(fd); } catch { /* ignore */ }
          try { unlinkSync(path); } catch { /* ignore */ }
        }
        if (!isAlreadyExists(error)) throw error;
        const existing = readLeaseRecord(path);
        if (existing && this.isStale(existing)) {
          try { unlinkSync(path); } catch { /* another contender won the race */ }
          continue;
        }
        throw new GameIdentityInUseError(key, existing?.pid ?? null);
      }
    }
    throw new GameIdentityInUseError(key, readLeaseRecord(path)?.pid ?? null);
  }

  release(): void {
    this.stopHeartbeat();
    const held = this.held;
    this.held = null;
    unregisterActiveLease(this);
    if (!held) return;
    this.releaseHeld(held);
  }

  private releaseHeld(held: { path: string; record: LeaseRecordV2 }): void {
    const current = readLeaseRecord(held.path);
    if (!current || current.ownerToken !== held.record.ownerToken) return;
    try { unlinkSync(held.path); } catch { /* already released */ }
  }

  private isStale(existing: LeaseRecord): boolean {
    if (!this.isProcessAlive(existing.pid)) return true;

    if (existing.version === 1) {
      const acquiredAt = Date.parse(existing.acquiredAt);
      return existing.pid === this.processPid
        && Number.isFinite(acquiredAt)
        && acquiredAt < this.processStartedAt;
    }

    if (existing.pid === this.processPid
      && existing.processInstanceId !== this.processInstanceId) return true;

    const timing = validTiming(this.getTiming());
    const heartbeatAt = Date.parse(existing.heartbeatAt);
    return Boolean(timing)
      && Number.isFinite(heartbeatAt)
      && this.now() - heartbeatAt > timing!.staleAfterMs;
  }

  private scheduleHeartbeat(): void {
    this.stopHeartbeat();
    if (!this.held) return;
    const timing = validTiming(this.getTiming());
    if (!timing) return;
    const held = this.held;
    this.heartbeatTimer = setTimeout(() => {
      this.heartbeatTimer = null;
      if (this.held !== held) return;
      this.refreshHeartbeat(held);
      this.scheduleHeartbeat();
    }, timing.heartbeatIntervalMs);
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeat(): void {
    if (!this.heartbeatTimer) return;
    clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private refreshHeartbeat(held: { path: string; record: LeaseRecordV2 }): void {
    let fd: number | null = null;
    try {
      fd = openSync(held.path, 'r+');
      const current = parseLeaseRecord(readFileSync(fd, 'utf8'));
      if (current?.version !== 2 || current.ownerToken !== held.record.ownerToken) return;
      const next: LeaseRecordV2 = { ...current, heartbeatAt: new Date(this.now()).toISOString() };
      ftruncateSync(fd, 0);
      writeSync(fd, JSON.stringify(next), 0, 'utf8');
      held.record = next;
    } catch { /* lease was replaced or removed; the current holder must not overwrite it */ }
    finally {
      if (fd !== null) {
        try { closeSync(fd); } catch { /* ignore */ }
      }
    }
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
    return parseLeaseRecord(readFileSync(path, 'utf8'));
  } catch { return null; }
}

function parseLeaseRecord(raw: string): LeaseRecord | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed.key !== 'string' || typeof parsed.pid !== 'number'
      || typeof parsed.ownerToken !== 'string' || typeof parsed.acquiredAt !== 'string') return null;
    if (parsed.version === 1) return parsed as unknown as LeaseRecordV1;
    if (parsed.version === 2 && typeof parsed.processInstanceId === 'string'
      && typeof parsed.heartbeatAt === 'string') return parsed as unknown as LeaseRecordV2;
    return null;
  } catch { return null; }
}

function validTiming(value: GameConnectionLeaseTiming | null): GameConnectionLeaseTiming | null {
  if (!value || !Number.isFinite(value.heartbeatIntervalMs) || value.heartbeatIntervalMs <= 0
    || !Number.isFinite(value.staleAfterMs) || value.staleAfterMs <= value.heartbeatIntervalMs) return null;
  return value;
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

const PROCESS_INSTANCE_ID = randomUUID();
const PROCESS_STARTED_AT = Date.now() - process.uptime() * 1000;
const activeLeases = new Set<GameConnectionLease>();
let exitHookInstalled = false;

function registerActiveLease(lease: GameConnectionLease): void {
  activeLeases.add(lease);
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once('exit', releaseActiveLeases);
}

function unregisterActiveLease(lease: GameConnectionLease): void {
  activeLeases.delete(lease);
}

function releaseActiveLeases(): void {
  for (const lease of [...activeLeases]) lease.release();
}
