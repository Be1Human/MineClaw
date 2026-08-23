import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ExternalCaseTrace, ExternalRunReport } from '../../../../benchmark/memory/external/external.js';
import type { SummaryJudgeReport, SummaryReference } from '../../../../benchmark/memory/external/memoryAgentBenchSummaryJudge.js';
import { buildSummaryJudgeBlindReview } from '../../../../benchmark/memory/external/summaryJudgeBlindReview.js';

const sourcePath = 'D:/tmp/final-answer.json';

function fixtures(count = 60): { source: ExternalRunReport; judge: SummaryJudgeReport; references: Map<string, SummaryReference> } {
  const sourceTraces: ExternalCaseTrace[] = Array.from({ length: count }, (_, index) => ({
    id: `summary-${index}`,
    category: 'Long_Range_Understanding',
    question: 'Summarize.',
    status: 'ok',
    answer: `Provided summary ${index}.`,
    subDataset: 'infbench_sum_test',
    metric: 'llm_judge_f1',
    metricStatus: 'judge_pending',
    latencyMs: 1,
  }));
  const source: ExternalRunReport = {
    dataset: 'memoryagentbench',
    mode: 'hybrid',
    answerModel: 'test-answer',
    endpoint: 'local',
    promptVersion: 'v1',
    datasetFile: 'fixture',
    datasetSha256: 'fixture-sha',
    startedAt: '2026-07-27T00:00:00.000Z',
    completedAt: '2026-07-27T00:01:00.000Z',
    cases: count,
    completed: count,
    failed: 0,
    byCategory: {},
    traces: sourceTraces,
  };
  const traces = sourceTraces.map((trace, index) => ({
    id: trace.id,
    status: 'ok' as const,
    fluency: 1,
    recallFound: 1,
    recallTotal: 2,
    precisionFound: 1,
    precisionTotal: 1,
    recall: 0.5,
    precision: 1,
    f1: 2 / 3,
    fluencyOutput: '{"fluency":1}',
    recallOutput: '{"recall":1}',
    precisionOutput: '{"precision":1,"sentence_count":1}',
  }));
  const judge: SummaryJudgeReport = {
    schemaVersion: 'mineclaw-memoryagentbench-summary-judge/v1',
    protocol: 'MemoryAgentBench summarization_evaluate.py compatible',
    officialJudgeModel: 'gpt-4o-2024-05-13',
    judgeModel: 'test-judge',
    endpoint: 'local',
    officialModelMatched: false,
    sourceReport: sourcePath,
    startedAt: '2026-07-27T00:01:00.000Z',
    completedAt: '2026-07-27T00:02:00.000Z',
    cases: count,
    completed: count,
    failed: 0,
    averages: { fluency: 1, recall: 0.5, precision: 1, f1: 2 / 3 },
    traces,
  };
  const references = new Map(sourceTraces.map((trace, index) => [trace.id, {
    id: trace.id,
    keypoints: [`keypoint A ${index}`, `keypoint B ${index}`],
    expertSummary: `Expert summary ${index}.`,
  }]));
  return { source, judge, references };
}

test('FEAT-MEM-09-F · Summary Judge 固定抽取 50 条且盲包不泄露机器分数', () => {
  const { source, judge, references } = fixtures();
  const first = buildSummaryJudgeBlindReview({ sourceReportPath: sourcePath, sourceReport: source, judgeReport: judge, references, generatedAt: '2026-07-27T00:00:00.000Z' });
  const second = buildSummaryJudgeBlindReview({ sourceReportPath: sourcePath, sourceReport: source, judgeReport: judge, references, generatedAt: '2026-07-27T00:00:00.000Z' });
  assert.equal(first.reviewPack.samples.length, 50);
  assert.deepEqual(first.reviewPack.samples, second.reviewPack.samples);
  assert.equal(new Set(first.answerKey.samples.map(item => item.reviewId)).size, 50);
  const serialized = JSON.stringify(first.reviewPack);
  for (const forbidden of ['"caseId":', '"machineJudge":', '"recallFound":', '"precisionFound":', '"fluencyOutput":', '"f1":']) {
    assert.equal(serialized.includes(forbidden), false, `审阅包不应包含 ${forbidden}`);
  }
});

test('FEAT-MEM-09-F · Summary Judge 盲审拒绝不完整和错源报告', () => {
  const incomplete = fixtures();
  incomplete.judge.completed -= 1;
  incomplete.judge.failed = 1;
  assert.throws(() => buildSummaryJudgeBlindReview({ sourceReportPath: sourcePath, sourceReport: incomplete.source, judgeReport: incomplete.judge, references: incomplete.references }), /complete Judge report/);
  const wrongSource = fixtures();
  wrongSource.judge.sourceReport = 'D:/tmp/other.json';
  assert.throws(() => buildSummaryJudgeBlindReview({ sourceReportPath: sourcePath, sourceReport: wrongSource.source, judgeReport: wrongSource.judge, references: wrongSource.references }), /sourceReport mismatch/);
});
