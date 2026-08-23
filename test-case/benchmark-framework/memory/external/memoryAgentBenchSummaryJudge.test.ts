import assert from 'node:assert/strict';
import test from 'node:test';
import { FatalModelRequestError, type ExternalCaseTrace } from '../../../../benchmark/memory/external/external.js';
import { judgeSummaryCase, parseJudgeJson, runSummaryJudge, scoreSummaryJudge, type SummaryReference } from '../../../../benchmark/memory/external/memoryAgentBenchSummaryJudge.js';

test('parseJudgeJson accepts reasoning followed by fenced JSON', () => {
  assert.deepEqual(parseJudgeJson('Reasoning...\n```json\n{"recall": 3}\n```'), { recall: 3 });
});

test('scoreSummaryJudge follows official fluency-weighted harmonic mean', () => {
  const score = scoreSummaryJudge({ fluency: 1, recallFound: 3, recallTotal: 4, precisionFound: 2, precisionTotal: 4 });
  assert.equal(score.recall, 0.75);
  assert.equal(score.precision, 0.5);
  assert.equal(score.f1, 0.6);
  assert.equal(scoreSummaryJudge({ fluency: 0, recallFound: 4, recallTotal: 4, precisionFound: 4, precisionTotal: 4 }).f1, 0);
});

test('judgeSummaryCase combines the three rubric responses', async () => {
  const responses = ['{"fluency":1}', '{"supported_key_points":[1,2],"recall":2}', '{"precision":3,"sentence_count":4}'];
  const result = await judgeSummaryCase({
    trace: { id: 'q1', category: 'Long_Range_Understanding', question: 'summarize', status: 'ok', answer: 'A coherent summary.', latencyMs: 1 },
    reference: { id: 'q1', keypoints: ['a', 'b', 'c', 'd'], expertSummary: 'Reference.' },
    client: async () => ({ text: responses.shift()! }),
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.recall, 0.5);
  assert.equal(result.precision, 0.75);
  assert.equal(result.f1, 0.6);
});

test('MAB Summary Judge 遇到 Fatal 后停止领题并输出 Partial Report', async () => {
  const traces: ExternalCaseTrace[] = Array.from({ length: 20 }, (_, index) => ({
    id: `summary-${index}`,
    category: 'Long_Range_Understanding',
    question: 'summarize',
    status: 'ok',
    answer: 'summary',
    metric: 'llm_judge_f1',
    metricStatus: 'judge_pending',
    latencyMs: 1,
  }));
  const references = new Map<string, SummaryReference>(traces.map(trace => [trace.id, { id: trace.id, keypoints: ['fact'], expertSummary: 'fact' }]));
  let calls = 0;
  let fatalCases = 0;
  await assert.rejects(
    runSummaryJudge({
      sourceReport: 'source.json',
      sourceTraces: traces,
      references,
      client: async () => { calls += 1; throw new FatalModelRequestError(402, 'balance'); },
      judgeModel: 'deepseek-v4-flash',
      endpoint: 'https://api.deepseek.com',
      concurrency: 2,
      onFatal: report => { fatalCases = report.failed; },
    }),
    FatalModelRequestError,
  );
  assert.ok(calls > 0 && calls <= 6, `calls=${calls}`);
  assert.ok(fatalCases >= 1 && fatalCases <= 2, `fatalCases=${fatalCases}`);
});
