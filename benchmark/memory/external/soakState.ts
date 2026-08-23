import { closeSync, openSync, readFileSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

export type SoakStatus = 'running' | 'completed' | 'failed' | 'cancelled';
export type SoakSegmentStatus = SoakStatus | 'interrupted';

export interface SoakSegment {
  runId: string;
  pid: number;
  startedAt: string;
  lastHeartbeatAt: string;
  endedAt?: string;
  status: SoakSegmentStatus;
}

export interface SoakError {
  at: string;
  message: string;
}

export interface SoakReportV2 {
  schemaVersion: 'mineclaw-memory-soak/v2';
  status: SoakStatus;
  runId: string;
  pid: number;
  startedAt: string;
  updatedAt: string;
  targetEndAt: string;
  completedAt?: string;
  targetDurationMs: number;
  activeElapsedMs: number;
  elapsedMs: number;
  leaseTimeoutMs: number;
  resumedCount: number;
  iterations: number;
  messagesWritten: number;
  retrievalChecks: number;
  profileSwitches: number;
  reopens: number;
  flushes: number;
  crashes: number;
  deadlockSignals: number;
  profileLeaks: number;
  dataLoss: number;
  promptBudgetViolations: number;
  maxEventLoopDelayMs: number;
  lastHeartbeatAt: string;
  dbPath: string;
  reportPath: string;
  segments: SoakSegment[];
  errors: SoakError[];
}

interface LegacySoakReport {
  schemaVersion: 'mineclaw-memory-soak/v1';
  status: SoakStatus;
  startedAt: string;
  updatedAt: string;
  targetEndAt: string;
  completedAt?: string;
  targetDurationMs: number;
  elapsedMs: number;
  iterations: number;
  messagesWritten: number;
  retrievalChecks: number;
  profileSwitches: number;
  reopens: number;
  flushes: number;
  crashes: number;
  deadlockSignals: number;
  profileLeaks: number;
  dataLoss: number;
  promptBudgetViolations: number;
  maxEventLoopDelayMs: number;
  lastHeartbeatAt: string;
  dbPath: string;
  reportPath: string;
  errors: SoakError[];
}

export interface StartSoakOptions {
  nowMs: number;
  targetDurationMs: number;
  leaseTimeoutMs: number;
  dbPath: string;
  reportPath: string;
  pid?: number;
  runId?: string;
}

export interface RunningSoakState {
  report: SoakReportV2;
  baseActiveElapsedMs: number;
  segmentStartedAtMs: number;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function timestamp(value: string, field: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`invalid ${field}: ${value}`);
  return parsed;
}

function samePath(left: string, right: string): boolean {
  return resolve(left).toLowerCase() === resolve(right).toLowerCase();
}

function assertCompatible(report: LegacySoakReport | SoakReportV2, options: StartSoakOptions): void {
  if (report.targetDurationMs !== options.targetDurationMs) {
    throw new Error(`resume targetDurationMs mismatch: ${report.targetDurationMs} != ${options.targetDurationMs}`);
  }
  if (!samePath(report.dbPath, options.dbPath)) throw new Error(`resume dbPath mismatch: ${report.dbPath} != ${options.dbPath}`);
  if (!samePath(report.reportPath, options.reportPath)) throw new Error(`resume reportPath mismatch: ${report.reportPath} != ${options.reportPath}`);
}

function migrateLegacy(report: LegacySoakReport, options: StartSoakOptions): SoakReportV2 {
  assertCompatible(report, options);
  const lastHeartbeatMs = timestamp(report.lastHeartbeatAt, 'lastHeartbeatAt');
  const startedAtMs = timestamp(report.startedAt, 'startedAt');
  const observedMs = Math.max(0, lastHeartbeatMs - startedAtMs);
  const activeElapsedMs = Math.min(report.targetDurationMs, Math.max(0, Math.min(report.elapsedMs, observedMs)));
  const interrupted = report.status === 'running';
  return {
    ...report,
    schemaVersion: 'mineclaw-memory-soak/v2',
    status: interrupted ? 'cancelled' : report.status,
    runId: 'legacy-v1',
    pid: 0,
    targetEndAt: iso(options.nowMs + Math.max(0, report.targetDurationMs - activeElapsedMs)),
    activeElapsedMs,
    elapsedMs: activeElapsedMs,
    leaseTimeoutMs: options.leaseTimeoutMs,
    resumedCount: 0,
    segments: [{
      runId: 'legacy-v1',
      pid: 0,
      startedAt: report.startedAt,
      lastHeartbeatAt: report.lastHeartbeatAt,
      endedAt: report.lastHeartbeatAt,
      status: interrupted ? 'interrupted' : report.status,
    }],
    errors: interrupted
      ? [...report.errors, { at: iso(options.nowMs), message: 'migrated stale v1 running report; previous process was interrupted' }]
      : [...report.errors],
  };
}

export function readSoakReport(path: string): LegacySoakReport | SoakReportV2 {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as LegacySoakReport | SoakReportV2;
  if (parsed.schemaVersion !== 'mineclaw-memory-soak/v1' && parsed.schemaVersion !== 'mineclaw-memory-soak/v2') {
    throw new Error(`unsupported soak report schema: ${(parsed as { schemaVersion?: string }).schemaVersion ?? 'missing'}`);
  }
  return parsed;
}

export function startNewSoak(options: StartSoakOptions): RunningSoakState {
  const runId = options.runId ?? randomUUID();
  const pid = options.pid ?? process.pid;
  const now = iso(options.nowMs);
  const report: SoakReportV2 = {
    schemaVersion: 'mineclaw-memory-soak/v2',
    status: 'running',
    runId,
    pid,
    startedAt: now,
    updatedAt: now,
    targetEndAt: iso(options.nowMs + options.targetDurationMs),
    targetDurationMs: options.targetDurationMs,
    activeElapsedMs: 0,
    elapsedMs: 0,
    leaseTimeoutMs: options.leaseTimeoutMs,
    resumedCount: 0,
    iterations: 0,
    messagesWritten: 0,
    retrievalChecks: 0,
    profileSwitches: 0,
    reopens: 0,
    flushes: 0,
    crashes: 0,
    deadlockSignals: 0,
    profileLeaks: 0,
    dataLoss: 0,
    promptBudgetViolations: 0,
    maxEventLoopDelayMs: 0,
    lastHeartbeatAt: now,
    dbPath: options.dbPath,
    reportPath: options.reportPath,
    segments: [{ runId, pid, startedAt: now, lastHeartbeatAt: now, status: 'running' }],
    errors: [],
  };
  return { report, baseActiveElapsedMs: 0, segmentStartedAtMs: options.nowMs };
}

export function resumeSoak(source: LegacySoakReport | SoakReportV2, options: StartSoakOptions): RunningSoakState {
  const report = source.schemaVersion === 'mineclaw-memory-soak/v1'
    ? migrateLegacy(source, options)
    : structuredClone(source);
  assertCompatible(report, options);
  if (report.status === 'completed' && report.activeElapsedMs >= report.targetDurationMs) {
    throw new Error('soak report is already completed');
  }
  const heartbeatAgeMs = Math.max(0, options.nowMs - timestamp(report.lastHeartbeatAt, 'lastHeartbeatAt'));
  if (report.status === 'running' && heartbeatAgeMs <= report.leaseTimeoutMs) {
    throw new Error(`soak report has an active lease (${heartbeatAgeMs}ms <= ${report.leaseTimeoutMs}ms)`);
  }
  const last = report.segments.at(-1);
  if (last?.status === 'running') {
    last.status = 'interrupted';
    last.endedAt = last.lastHeartbeatAt;
    report.errors.push({ at: iso(options.nowMs), message: `recovered interrupted run ${last.runId}` });
  }
  const runId = options.runId ?? randomUUID();
  const pid = options.pid ?? process.pid;
  const now = iso(options.nowMs);
  report.status = 'running';
  report.runId = runId;
  report.pid = pid;
  report.updatedAt = now;
  report.lastHeartbeatAt = now;
  report.targetEndAt = iso(options.nowMs + Math.max(0, report.targetDurationMs - report.activeElapsedMs));
  report.leaseTimeoutMs = options.leaseTimeoutMs;
  report.resumedCount += 1;
  delete report.completedAt;
  report.segments.push({ runId, pid, startedAt: now, lastHeartbeatAt: now, status: 'running' });
  return { report, baseActiveElapsedMs: report.activeElapsedMs, segmentStartedAtMs: options.nowMs };
}

export function heartbeatSoak(state: RunningSoakState, nowMs: number): void {
  const segmentElapsedMs = Math.max(0, nowMs - state.segmentStartedAtMs);
  state.report.activeElapsedMs = Math.min(state.report.targetDurationMs, state.baseActiveElapsedMs + segmentElapsedMs);
  state.report.elapsedMs = state.report.activeElapsedMs;
  state.report.updatedAt = iso(nowMs);
  state.report.lastHeartbeatAt = state.report.updatedAt;
  state.report.targetEndAt = iso(nowMs + Math.max(0, state.report.targetDurationMs - state.report.activeElapsedMs));
  const segment = state.report.segments.at(-1);
  if (!segment || segment.runId !== state.report.runId) throw new Error('active soak segment is missing');
  segment.lastHeartbeatAt = state.report.lastHeartbeatAt;
}

export function finishSoak(state: RunningSoakState, status: SoakStatus, nowMs: number): void {
  heartbeatSoak(state, nowMs);
  state.report.status = status;
  state.report.completedAt = iso(nowMs);
  const segment = state.report.segments.at(-1);
  if (!segment || segment.runId !== state.report.runId) throw new Error('active soak segment is missing');
  segment.status = status;
  segment.endedAt = iso(nowMs);
}

export function atomicWriteSoak(path: string, report: SoakReportV2): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${report.runId}.tmp`;
  writeFileSync(temporary, JSON.stringify(report, null, 2));
  renameSync(temporary, path);
}

export interface SoakLock {
  path: string;
  heartbeat(nowMs?: number): void;
  release(): void;
}

export function acquireSoakLock(path: string, leaseTimeoutMs: number, nowMs = Date.now()): SoakLock {
  mkdirSync(dirname(path), { recursive: true });
  let descriptor: number | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      descriptor = openSync(path, 'wx');
      writeFileSync(descriptor, JSON.stringify({ pid: process.pid, acquiredAt: iso(nowMs) }));
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST' || attempt > 0) throw error;
      const ageMs = Math.max(0, nowMs - statSync(path).mtimeMs);
      if (ageMs <= leaseTimeoutMs) throw new Error(`soak lock has an active lease (${Math.floor(ageMs)}ms <= ${leaseTimeoutMs}ms)`);
      unlinkSync(path);
    }
  }
  if (descriptor === undefined) throw new Error(`failed to acquire soak lock: ${path}`);
  let released = false;
  return {
    path,
    heartbeat(heartbeatMs = Date.now()) {
      if (released) throw new Error('cannot heartbeat a released soak lock');
      const time = new Date(heartbeatMs);
      utimesSync(path, time, time);
    },
    release() {
      if (released) return;
      released = true;
      closeSync(descriptor!);
      try { unlinkSync(path); } catch { /* 已由异常清理流程移除 */ }
    },
  };
}
