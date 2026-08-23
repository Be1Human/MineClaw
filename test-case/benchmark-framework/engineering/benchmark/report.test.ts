import test from 'node:test';
import assert from 'node:assert/strict';
import { renderBenchmarkMarkdown, withBaselineDiff } from '../../../../benchmark/engineering/report.js';
import type { BenchmarkReport } from '../../../../benchmark/engineering/types.js';

function report(rate: number): BenchmarkReport {
  return {
    schemaVersion: 'mineclaw-benchmark/v1', runId: 'RUN', startedAt: 'start', finishedAt: 'end',
    environment: { commit: 'abc', dirty: false, server: 'local', backend: 'backend', profile: 'release' },
    expectedCaseIds: ['T01'],
    results: [{
      id: 'T01', title: '移动', layer: 'experience', status: rate === 1 ? 'pass' : 'fail',
      successRate: rate, durationMs: 1000, evidence: ['e'], attempts: 1, passedAttempts: rate === 1 ? 1 : 0,
    }],
    scores: { body: null, experience: rate * 100, reliability: null, overall: rate * 100 },
    gates: { falseComplete: 0, crash: 0, hung: 0, terminalMismatch: 0, incomplete: 0, watchdog: 0 },
    threshold: 80, passed: rate >= 0.8,
  };
}

test('Markdown 包含分层成绩、硬门和证据', () => {
  const markdown = renderBenchmarkMarkdown(report(1));
  assert.match(markdown, /分层成绩/);
  assert.match(markdown, /硬门/);
  assert.match(markdown, /T01/);
  assert.match(markdown, /`e`/);
});

test('Baseline diff 按 Case 输出百分点变化', () => {
  const current = withBaselineDiff(report(1), report(0.5));
  assert.equal(current.baselineDiff?.[0].delta, 50);
});
