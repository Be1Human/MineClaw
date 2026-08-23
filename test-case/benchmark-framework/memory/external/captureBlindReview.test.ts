import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildCaptureBlindReview, selectCaptureBlindCases } from '../../../../benchmark/memory/external/captureBlindReview.js';
import { mineClawZhCases } from '../../../../benchmark/memory/shared/datasets.js';
import type { MemoryBenchCase, MemoryBenchResult } from '../../../../benchmark/memory/shared/types.js';

function fakeResult(testCase: MemoryBenchCase): MemoryBenchResult {
  const captured = [...testCase.expectedCaptureMessageIds];
  return {
    caseId: testCase.id,
    category: testCase.category,
    split: testCase.split,
    mode: 'hybrid',
    answer: '',
    trace: {
      caseId: testCase.id,
      capturedFactIds: captured.map(id => `fact-${id}`),
      capturedMessageIds: captured,
      activeFactIds: captured.map(id => `fact-${id}`),
      activeSourceMessageIds: captured,
      retrievedFactIds: [],
      retrievedSourceMessageIds: [],
      injectedFactIds: [],
      injectedSourceMessageIds: [],
      summaryCoveredMessageIds: [],
      foreignLeakMessageIds: [],
      rejected: testCase.expectedRejectionReason ? { [testCase.expectedRejectionReason]: 1 } : {},
      degradedMode: null,
      promptChars: 0,
      promptBudgetChars: 6000,
      latencyMs: { retrieval: 0, total: 0 },
    },
    answerCorrect: true,
    captureEvaluated: true,
    captureExpectedCount: captured.length,
    captureActualCount: captured.length,
    captureCorrectCount: captured.length,
    capturePrecision: 1,
    captureRecall: 1,
    operationCorrect: true,
    retrievalRecall: 1,
    retrievalPrecision: 1,
    reciprocalRank: 1,
    retrievalRelevantCount: 0,
    retrievedSourceCount: 0,
    retrievalCorrectCount: 0,
    sourceCoverage: 1,
    injectedSourceCount: 0,
    injectedRelevantCount: 0,
    irrelevantInjectionRate: 0,
    forbiddenInjected: false,
    conflictCoInjected: false,
    profileLeak: false,
    promptBudgetRespected: true,
    abstentionCorrect: null,
    newFactAdopted: null,
    oldFactPolluted: null,
    memorySuccess: true,
    flushExecuted: false,
    openLoopRetention: null,
    commitmentRetention: null,
  };
}

test('FEAT-MEM-09-E · 固定种子确定性分层抽取 50 条 Capture 盲审样本', () => {
  const cases = mineClawZhCases();
  const first = selectCaptureBlindCases(cases);
  const second = selectCaptureBlindCases(cases);
  assert.equal(first.length, 50);
  assert.deepEqual(first.map(item => item.id), second.map(item => item.id));
  const counts = first.reduce<Record<string, number>>((acc, item) => ({ ...acc, [item.category]: (acc[item.category] ?? 0) + 1 }), {});
  assert.deepEqual(counts, {
    preference: 6,
    crud: 6,
    conflict: 6,
    do_not_store: 6,
    semantic: 6,
    isolation: 5,
    security: 5,
    flush: 5,
    degraded: 5,
  });
});

test('FEAT-MEM-09-E · 审阅包不泄露 Ground Truth，答案键可唯一对账', () => {
  const cases = mineClawZhCases();
  const selected = selectCaptureBlindCases(cases);
  const built = buildCaptureBlindReview(cases, selected, selected.map(fakeResult), { generatedAt: '2026-07-27T00:00:00.000Z' });
  assert.equal(built.reviewPack.samples.length, 50);
  assert.equal(built.answerKey.samples.length, 50);
  assert.equal(new Set(built.answerKey.samples.map(item => item.reviewId)).size, 50);
  const serialized = JSON.stringify(built.reviewPack);
  for (const forbidden of ['caseId', 'category', 'expectedCaptureMessageIds', 'expectedOperation', 'answerCorrect', 'operationCorrect']) {
    assert.equal(serialized.includes(forbidden), false, `审阅包不应包含 ${forbidden}`);
  }
  assert.equal((built.reviewForm.match(/- \[ \] 通过/g) ?? []).length, 50);
  assert.equal((built.reviewForm.match(/- \[ \] 失败/g) ?? []).length, 50);
  assert.equal((built.reviewForm.match(/- \[ \] 不确定/g) ?? []).length, 50);
});
