import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cartesian, expand, type ScenarioTemplate } from '../../../benchmark/engineering/core/template.js';
import { selectScenarios } from '../../../benchmark/engineering/body/index.js';
import { buildReport, renderMarkdown } from '../../../benchmark/engineering/core/report.js';
import type { RunResult } from '../../../benchmark/engineering/core/types.js';

type Params = { distance: number; count: number };

test('FEAT-CROSS-03：模板以笛卡尔积展开，保留 pinned ID，并隔离 matrix 套件', () => {
  const template: ScenarioTemplate<Params> = {
    idPrefix: 'UNIT', category: 'nav', axes: { distance: [8, 16], count: [1, 2] }, repeat: 2,
    pinned: [{ id: 'UNIT-01', suite: 'full', params: { distance: 8, count: 1 } }],
    build: params => ({
      title: `walk ${params.distance}/${params.count}`,
      timeoutMs: 1_000, setup: async () => {}, inject: async () => {}, success: () => false,
    }),
  };

  assert.deepEqual(cartesian(template.axes), [
    { distance: 8, count: 1 }, { distance: 8, count: 2 },
    { distance: 16, count: 1 }, { distance: 16, count: 2 },
  ]);
  const scenarios = expand(template).map(factory => factory());
  assert.deepEqual(scenarios.map(s => s.id), ['UNIT-01', 'UNIT-M01', 'UNIT-M02', 'UNIT-M03', 'UNIT-M04']);
  assert.equal(scenarios[0]?.suite, 'full');
  assert.ok(scenarios.slice(1).every(s => s.suite === 'matrix' && s.repeat === 2));
});

test('FEAT-CROSS-03：quick/full/matrix 与单场景选择保持契约', () => {
  const quick = selectScenarios({ suite: 'quick' }).map(factory => factory());
  const full = selectScenarios({ suite: 'full' }).map(factory => factory());
  const matrix = selectScenarios({ suite: 'matrix' }).map(factory => factory());

  assert.ok(quick.length > 0 && quick.every(s => s.suite === 'quick'));
  assert.ok(full.length >= quick.length && full.every(s => s.suite !== 'matrix'));
  assert.ok(matrix.length > 0 && matrix.every(s => s.suite === 'matrix'));
  assert.equal(selectScenarios({ suite: 'matrix', only: 'SURV-01' })[0]?.().id, 'SURV-01');
  assert.ok(full.some(s => s.category === 'survival'));
  assert.ok(full.some(s => s.category === 'combat'));
});

test('FEAT-CROSS-03：报告保留场景明细，并生成类目小计', () => {
  const runs: RunResult[] = [{ ok: true, durationMs: 120, watchdogHits: 0 }];
  const result = { id: 'SURV-01', title: 'eat', suite: 'full' as const, category: 'survival' as const, repeat: 1, passed: 1, successRate: 1, avgDurationMs: 120, watchdogHits: 0, topFailReasons: [], runs };
  const combat = { ...result, id: 'COMB-01', category: 'combat' as const, successRate: 0, passed: 0, watchdogHits: 1, topFailReasons: [{ reason: 'timeout', count: 1 }], runs: [{ ok: false, durationMs: 1_000, reason: 'timeout', watchdogHits: 1 }] };
  const report = buildReport([result, combat], { startedAt: 'a', finishedAt: 'b', suite: 'full', server: 'localhost' });
  const markdown = renderMarkdown(report);

  assert.equal(report.summary.totalWatchdogHits, 1);
  assert.match(markdown, /survival/);
  assert.match(markdown, /combat/);
  assert.match(markdown, /类目小计/);
});
