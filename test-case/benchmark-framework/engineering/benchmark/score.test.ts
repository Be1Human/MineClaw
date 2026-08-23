import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateScores, passesBenchmark } from '../../../../benchmark/engineering/score.js';
import type { BenchmarkCaseDefinition, BenchmarkCaseResult } from '../../../../benchmark/engineering/types.js';

const definitions: BenchmarkCaseDefinition[] = [
  { id: 'B', title: 'body', layer: 'body', source: 'body-full' },
  { id: 'E', title: 'experience', layer: 'experience', source: 'gym' },
  { id: 'R', title: 'reliability', layer: 'reliability', source: 'gym' },
];

function result(id: string, layer: BenchmarkCaseResult['layer'], rate = 1): BenchmarkCaseResult {
  return {
    id, title: id, layer, status: rate === 1 ? 'pass' : 'fail', successRate: rate,
    durationMs: 100, evidence: ['evidence'], attempts: 1, passedAttempts: rate === 1 ? 1 : 0,
  };
}

test('按 35/45/20 计算三层分数', () => {
  const { scores, gates } = calculateScores([
    result('B', 'body', 0.8), result('E', 'experience', 0.6), result('R', 'reliability', 1),
  ], definitions);
  assert.equal(scores.body, 80);
  assert.equal(scores.experience, 60);
  assert.equal(scores.reliability, 100);
  assert.equal(scores.overall, 75);
  assert.equal(gates.incomplete, 0);
});

test('缺 Case 记 Incomplete，不把缺失当通过', () => {
  const { gates } = calculateScores([result('B', 'body')], definitions);
  assert.equal(gates.incomplete, 2);
});

test('任何硬门都能阻止高分 PASS', () => {
  const results = definitions.map(item => result(item.id, item.layer));
  results[0].failureKind = 'false_complete';
  const { scores, gates } = calculateScores(results, definitions);
  assert.equal(scores.overall, 100);
  assert.equal(passesBenchmark(scores, gates, 80), false);
});

test('单 Case 定向运行按所选层评分', () => {
  const expected = [definitions[2]];
  const { scores, gates } = calculateScores([result('R', 'reliability')], expected);
  assert.equal(scores.overall, 100);
  assert.equal(passesBenchmark(scores, gates, 80), true);
});
