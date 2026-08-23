import { test } from 'node:test';
import assert from 'node:assert/strict';
import { finalizeMemoryAgentBench } from '../../../../benchmark/memory/external/memoryAgentBenchFinalize.js';
import type { ExternalRunReport } from '../../../../benchmark/memory/external/external.js';
import type { SummaryJudgeReport } from '../../../../benchmark/memory/external/memoryAgentBenchSummaryJudge.js';
import type { LongMemJudgeReport } from '../../../../benchmark/memory/external/memoryAgentBenchLongMemJudge.js';

const sourcePath = 'source-memoryagentbench.json';
const source: ExternalRunReport = {
  dataset: 'memoryagentbench', mode: 'hybrid', answerModel: 'answer-model', endpoint: 'endpoint', promptVersion: 'v1',
  datasetFile: 'dataset', datasetSha256: 'sha', startedAt: 'start', completedAt: 'old', cases: 3, completed: 3, failed: 0,
  byCategory: {}, byMetric: {},
  traces: [
    { id: 'exact', category: 'Accurate_Retrieval', question: 'q', status: 'ok', answer: 'a', expected: ['a'], score: 1, metric: 'substring_exact_match', metricStatus: 'scored', latencyMs: 1 },
    { id: 'summary', category: 'Long_Range_Understanding', question: 'q', status: 'ok', answer: 's', expected: ['s'], metric: 'llm_judge_f1', metricStatus: 'judge_pending', latencyMs: 1 },
    { id: 'longmem', category: 'Accurate_Retrieval', question: 'q', status: 'ok', answer: 'a', expected: ['a'], metric: 'llm_as_judge', metricStatus: 'judge_pending', latencyMs: 1 },
  ],
};

const summary: SummaryJudgeReport = {
  schemaVersion: 'mineclaw-memoryagentbench-summary-judge/v1', protocol: 'MemoryAgentBench summarization_evaluate.py compatible',
  officialJudgeModel: 'gpt-4o-2024-05-13', judgeModel: 'deepseek', endpoint: 'endpoint', officialModelMatched: false,
  sourceReport: sourcePath, startedAt: 'start', completedAt: 'done', cases: 1, completed: 1, failed: 0,
  averages: { fluency: 1, recall: 0.5, precision: 0.5, f1: 0.5 },
  traces: [{ id: 'summary', status: 'ok', fluency: 1, recall: 0.5, precision: 0.5, f1: 0.5 }],
};

const longMem: LongMemJudgeReport = {
  schemaVersion: 'mineclaw-memoryagentbench-longmem-judge/v1', protocol: 'MemoryAgentBench longmem_qa_evaluate.py compatible',
  officialJudgeModel: 'gpt-4o', judgeModel: 'deepseek', endpoint: 'endpoint', officialModelMatched: false,
  sourceReport: sourcePath, startedAt: 'start', completedAt: 'done', cases: 1, completed: 1, failed: 0, accuracy: 0,
  byQuestionType: { 'multi-session': { cases: 1, correct: 0, accuracy: 0 } },
  traces: [{ id: 'longmem', questionId: 'q1', questionType: 'multi-session', status: 'ok', label: false, judgeResponse: 'no' }],
};

test('MAB Finalizer 回填两类 Judge 并重算分项，不产生混合总分', () => {
  const final = finalizeMemoryAgentBench({
    source: structuredClone(source), sourceReportPath: sourcePath,
    summaryJudge: summary, summaryJudgeReportPath: 'summary.json',
    longMemJudge: longMem, longMemJudgeReportPath: 'longmem.json',
  });
  assert.equal(final.traces.find(trace => trace.id === 'summary')?.score, 0.5);
  assert.equal(final.traces.find(trace => trace.id === 'longmem')?.score, 0);
  assert.equal(final.traces.some(trace => trace.metricStatus === 'judge_pending'), false);
  assert.equal(final.byMetric?.llm_judge_f1?.score, 0.5);
  assert.equal(final.byMetric?.llm_as_judge?.score, 0);
  assert.equal(final.score, undefined);
  assert.equal(final.judgeEvaluation.officialModelsMatched, false);
});

test('MAB Finalizer 对错源和不完整 Judge fail closed', () => {
  assert.throws(() => finalizeMemoryAgentBench({
    source: structuredClone(source), sourceReportPath: sourcePath,
    summaryJudge: { ...summary, sourceReport: 'other.json' }, summaryJudgeReportPath: 'summary.json',
    longMemJudge: longMem, longMemJudgeReportPath: 'longmem.json',
  }), /sourceReport mismatch/);
  assert.throws(() => finalizeMemoryAgentBench({
    source: structuredClone(source), sourceReportPath: sourcePath,
    summaryJudge: { ...summary, completed: 0, failed: 1 }, summaryJudgeReportPath: 'summary.json',
    longMemJudge: longMem, longMemJudgeReportPath: 'longmem.json',
  }), /judge is incomplete/);
});

test('MAB Finalizer 按复合身份回填重复 qa_pair_id', () => {
  const duplicateSource: ExternalRunReport = {
    ...structuredClone(source),
    cases: 3,
    traces: [
      source.traces[0]!,
      { ...source.traces[2]!, id: 'duplicate', question: 'Question A' },
      { ...source.traces[2]!, id: 'duplicate', question: 'Question B' },
    ],
  };
  const duplicateLongMem: LongMemJudgeReport = {
    ...structuredClone(longMem),
    cases: 2,
    completed: 2,
    accuracy: 0.5,
    traces: [
      { id: 'duplicate', sourceQuestion: 'Question A', questionId: 'qa', questionType: 'multi-session', status: 'ok', label: true },
      { id: 'duplicate', sourceQuestion: 'Question B', questionId: 'qb', questionType: 'multi-session', status: 'ok', label: false },
    ],
  };
  const emptySummary: SummaryJudgeReport = { ...structuredClone(summary), cases: 0, completed: 0, traces: [] };
  const final = finalizeMemoryAgentBench({
    source: duplicateSource,
    sourceReportPath: sourcePath,
    summaryJudge: emptySummary,
    summaryJudgeReportPath: 'summary.json',
    longMemJudge: duplicateLongMem,
    longMemJudgeReportPath: 'longmem.json',
  });
  assert.equal(final.traces.find(trace => trace.question === 'Question A')?.score, 1);
  assert.equal(final.traces.find(trace => trace.question === 'Question B')?.score, 0);
});

test('MAB Finalizer 拒绝重复 ID 的旧歧义 Judge 报告', () => {
  const duplicateSource: ExternalRunReport = {
    ...structuredClone(source),
    cases: 3,
    traces: [
      source.traces[0]!,
      { ...source.traces[2]!, id: 'duplicate', question: 'Question A' },
      { ...source.traces[2]!, id: 'duplicate', question: 'Question B' },
    ],
  };
  const ambiguousLongMem: LongMemJudgeReport = {
    ...structuredClone(longMem),
    cases: 2,
    completed: 2,
    traces: [
      { id: 'duplicate', questionId: 'qa', questionType: 'multi-session', status: 'ok', label: true },
      { id: 'duplicate', questionId: 'qb', questionType: 'multi-session', status: 'ok', label: false },
    ],
  };
  const emptySummary: SummaryJudgeReport = { ...structuredClone(summary), cases: 0, completed: 0, traces: [] };
  assert.throws(() => finalizeMemoryAgentBench({
    source: duplicateSource,
    sourceReportPath: sourcePath,
    summaryJudge: emptySummary,
    summaryJudgeReportPath: 'summary.json',
    longMemJudge: ambiguousLongMem,
    longMemJudgeReportPath: 'longmem.json',
  }), /ambiguous duplicate id/);
});
