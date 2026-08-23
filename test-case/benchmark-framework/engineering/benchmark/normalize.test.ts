import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBodyReport, normalizeGymAttempts } from '../../../../benchmark/engineering/normalize.js';
import type { BenchmarkCaseDefinition, BodyEvalReport, GymTaskResult } from '../../../../benchmark/engineering/types.js';

const bodyDef: BenchmarkCaseDefinition = { id: 'NAV-01', title: 'nav', layer: 'body', source: 'body-full' };
const gymDef: BenchmarkCaseDefinition = { id: 'T01', title: 'move', layer: 'experience', source: 'gym' };

test('Body 报告保留成功率、watchdog 与失败原因', () => {
  const report: BodyEvalReport = { scenarios: [{
    id: 'NAV-01', title: 'nav', repeat: 5, passed: 4, successRate: 0.8,
    avgDurationMs: 1200, watchdogHits: 1, topFailReasons: [{ reason: 'timeout', count: 1 }],
  }] };
  const [result] = normalizeBodyReport(report, [bodyDef], 'report.json');
  assert.equal(result.successRate, 0.8);
  assert.equal(result.watchdogHits, 1);
  assert.equal(result.status, 'fail');
  assert.match(result.reason ?? '', /timeout/);
});

test('Gym 多次结果聚合成功率与回复延迟', () => {
  const pass: GymTaskResult = {
    task: 'T01', name: 'move', verdict: 'PASS', durationMs: 2000,
    instructionDurationMs: 1000, responseLatencyMs: 200, checks: [], notes: [],
  };
  const fail: GymTaskResult = {
    task: 'T01', name: 'move', verdict: 'FAIL', durationMs: 4000,
    instructionDurationMs: 3000, responseLatencyMs: 600, failureKind: 'task_failure', checks: [], notes: ['timeout'],
  };
  const result = normalizeGymAttempts(gymDef, [
    { result: pass, evidencePath: 'r1' }, { result: fail, evidencePath: 'r2' },
  ]);
  assert.equal(result.successRate, 0.5);
  assert.equal(result.durationMs, 2000);
  assert.equal(result.responseLatencyMs, 400);
  assert.equal(result.status, 'fail');
});

test('Gym 缺 result.json 明确标记 Incomplete', () => {
  const result = normalizeGymAttempts(gymDef, []);
  assert.equal(result.status, 'incomplete');
  assert.equal(result.failureKind, 'harness_error');
});
