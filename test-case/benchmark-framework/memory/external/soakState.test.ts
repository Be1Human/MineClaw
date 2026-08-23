import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import {
  acquireSoakLock,
  finishSoak,
  heartbeatSoak,
  resumeSoak,
  startNewSoak,
  type SoakReportV2,
} from '../../../../benchmark/memory/external/soakState.js';

function options(nowMs = 1_000) {
  return {
    nowMs,
    targetDurationMs: 5_000,
    leaseTimeoutMs: 1_000,
    dbPath: join(tmpdir(), 'soak-state.db'),
    reportPath: join(tmpdir(), 'soak-state.json'),
    pid: 42,
    runId: `run-${nowMs}`,
  };
}

test('heartbeat only accumulates active segment time and never goes negative', () => {
  const state = startNewSoak(options());
  heartbeatSoak(state, 3_000);
  assert.equal(state.report.activeElapsedMs, 2_000);
  heartbeatSoak(state, 500);
  assert.equal(state.report.activeElapsedMs, 0);
});

test('resume rejects a report whose lease is still active', () => {
  const state = startNewSoak(options());
  heartbeatSoak(state, 1_500);
  assert.throws(() => resumeSoak(state.report, options(2_000)), /active lease/);
});

test('resume marks an expired segment interrupted and preserves counters', () => {
  const first = startNewSoak(options());
  first.report.iterations = 7;
  heartbeatSoak(first, 2_000);
  const resumed = resumeSoak(first.report, options(4_000));
  assert.equal(resumed.report.iterations, 7);
  assert.equal(resumed.report.resumedCount, 1);
  assert.equal(resumed.report.segments[0]?.status, 'interrupted');
  assert.equal(resumed.report.activeElapsedMs, 1_000);
  heartbeatSoak(resumed, 5_500);
  assert.equal(resumed.report.activeElapsedMs, 2_500);
});

test('finish closes the active segment and preserves the target cap', () => {
  const state = startNewSoak(options());
  finishSoak(state, 'completed', 7_000);
  assert.equal(state.report.status, 'completed');
  assert.equal(state.report.activeElapsedMs, 5_000);
  assert.equal(state.report.segments[0]?.status, 'completed');
  assert.ok(state.report.completedAt);
});

test('resume rejects incompatible duration and paths', () => {
  const state = startNewSoak(options());
  const expired = structuredClone(state.report) as SoakReportV2;
  expired.lastHeartbeatAt = new Date(0).toISOString();
  assert.throws(() => resumeSoak(expired, { ...options(4_000), targetDurationMs: 9_000 }), /targetDurationMs mismatch/);
  assert.throws(() => resumeSoak(expired, { ...options(4_000), dbPath: join(tmpdir(), 'other.db') }), /dbPath mismatch/);
});

test('exclusive lock rejects a live holder and reclaims a stale lock', () => {
  const directory = mkdtempSync(join(tmpdir(), 'soak-lock-'));
  const path = join(directory, 'run.lock');
  try {
    const first = acquireSoakLock(path, 10_000, Date.now());
    first.heartbeat(Date.now());
    assert.throws(() => acquireSoakLock(path, 10_000, Date.now()), /active lease/);
    first.release();
    writeFileSync(path, 'stale');
    const old = new Date(Date.now() - 20_000);
    utimesSync(path, old, old);
    const reclaimed = acquireSoakLock(path, 1_000, Date.now());
    reclaimed.release();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
