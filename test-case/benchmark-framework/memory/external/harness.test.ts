import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mineClawZhCases } from '../../../../benchmark/memory/shared/datasets.js';
import { MemoryBenchmarkHarness } from '../../../../benchmark/memory/shared/harness.js';
import { summarizeMemoryResults } from '../../../../benchmark/memory/external/metrics.js';
import type { MemoryBenchCase } from '../../../../benchmark/memory/shared/types.js';

function baseCase(overrides: Partial<MemoryBenchCase> = {}): MemoryBenchCase {
  return {
    id: 'unit-coffee',
    category: 'semantic',
    split: 'test',
    sessions: [{ id: 's-1', messages: [{ id: 'm-1', role: 'owner', content: '我喜欢咖啡', timestamp: 1 }] }],
    question: '我的 coffee 偏好是什么？',
    answers: ['咖啡'],
    expectedCaptureMessageIds: ['m-1'],
    relevantMessageIds: ['m-1'],
    expectedOperation: 'add',
    ...overrides,
  };
}

test('MineClaw-MemoryBench-ZH 包含 130 个带完整标注且互斥的 dev/test Case', () => {
  const cases = mineClawZhCases();
  assert.equal(cases.length, 130);
  assert.equal(new Set(cases.map(item => item.id)).size, cases.length);
  assert.ok(cases.some(item => item.split === 'dev'));
  assert.ok(cases.some(item => item.split === 'test'));
  for (const item of cases) {
    assert.ok(item.id && item.question);
    assert.ok(Array.isArray(item.expectedCaptureMessageIds));
    assert.ok(Array.isArray(item.relevantMessageIds));
    assert.ok(Array.isArray(item.alternativeMessageIds));
    assert.equal(typeof item.shouldAbstain, 'boolean');
  }
  const crud = cases.filter(item => item.category === 'crud');
  assert.equal(crud.filter(item => item.expectedOperation === 'add').length, 5);
  assert.equal(crud.filter(item => item.expectedOperation === 'replace').length, 5);
  assert.equal(crud.filter(item => item.expectedOperation === 'remove').length, 5);
});

test('Harness 输出 Capture/Retrieve/Inject/Answer 四层可评分 Trace', () => {
  const result = new MemoryBenchmarkHarness().runCase(baseCase(), 'hybrid');
  assert.equal(result.answerCorrect, true);
  assert.equal(result.capturePrecision, 1);
  assert.equal(result.captureRecall, 1);
  assert.equal(result.operationCorrect, true);
  assert.equal(result.retrievalRecall, 1);
  assert.equal(result.retrievalPrecision, 1);
  assert.equal(result.reciprocalRank, 1);
  assert.equal(result.sourceCoverage, 1);
  assert.equal(result.memorySuccess, true);
  assert.ok(result.trace.injectedFactIds.length > 0);
  assert.deepEqual(result.trace.injectedSourceMessageIds, ['m-1']);
});

test('Profile 隔离在同一数据库内使用外部诱饵验证零泄漏', () => {
  const result = new MemoryBenchmarkHarness().runCase(baseCase({
    id: 'unit-isolation',
    category: 'isolation',
    foreignProfiles: [{
      profileId: 'other-profile',
      sessions: [{ id: 'foreign-s', messages: [{ id: 'foreign-m', role: 'owner', content: '我喜欢外部咖啡', timestamp: 0 }] }],
    }],
    forbiddenMessageIds: ['foreign-m'],
  }), 'hybrid');
  assert.equal(result.profileLeak, false);
  assert.deepEqual(result.trace.foreignLeakMessageIds, []);
  assert.doesNotMatch(result.answer, /外部咖啡/);
});

test('安全样本真实进入拒绝链路，Trace 只保留原因而不保留秘密正文', () => {
  const result = new MemoryBenchmarkHarness().runCase(baseCase({
    id: 'unit-secret',
    category: 'security',
    sessions: [{ id: 's-1', messages: [{ id: 'm-1', role: 'owner', content: '记住，api_key=top-secret-value', timestamp: 1 }] }],
    question: '公开安全记忆？',
    answers: [],
    expectedCaptureMessageIds: [],
    relevantMessageIds: [],
    expectedOperation: 'reject',
    expectedRejectionReason: 'sensitive_secret',
    shouldAbstain: true,
  }), 'hybrid');
  assert.equal(result.operationCorrect, true);
  assert.equal(result.captureActualCount, 0);
  assert.equal(result.trace.rejected.sensitive_secret, 1);
  assert.doesNotMatch(JSON.stringify(result.trace), /top-secret-value/);
});

test('显式 replace 与 remove 按最终事实状态评分', () => {
  const replace = new MemoryBenchmarkHarness().runCase(baseCase({
    id: 'unit-replace',
    category: 'crud',
    sessions: [{ id: 's-1', messages: [
      { id: 'old', role: 'owner', content: '记住，我喜欢旧咖啡', timestamp: 1 },
      { id: 'new', role: 'owner', content: '改成，我喜欢新咖啡', timestamp: 2 },
    ] }],
    question: '我现在喜欢新咖啡吗？',
    answers: ['新咖啡'],
    expectedCaptureMessageIds: ['old', 'new'],
    relevantMessageIds: ['new'],
    forbiddenMessageIds: ['old'],
    expectedOperation: 'replace',
  }), 'hybrid');
  assert.equal(replace.operationCorrect, true);
  assert.equal(replace.forbiddenInjected, false);
  assert.equal(replace.newFactAdopted, true);

  const remove = new MemoryBenchmarkHarness().runCase(baseCase({
    id: 'unit-remove',
    category: 'crud',
    sessions: [{ id: 's-1', messages: [
      { id: 'old', role: 'owner', content: '记住，我喜欢旧咖啡', timestamp: 1 },
      { id: 'forget', role: 'owner', content: '忘掉，我喜欢旧咖啡这件事', timestamp: 2 },
    ] }],
    question: '我还喜欢旧咖啡吗？',
    answers: [],
    expectedCaptureMessageIds: ['old'],
    relevantMessageIds: [],
    forbiddenMessageIds: ['old'],
    expectedOperation: 'remove',
    shouldAbstain: true,
  }), 'hybrid');
  assert.equal(remove.operationCorrect, true);
  assert.equal(remove.forbiddenInjected, false);
  assert.equal(remove.memorySuccess, true);
});

test('冲突旧事实不能与新事实共同注入', () => {
  const conflictCase = mineClawZhCases().find(item => item.category === 'conflict')!;
  const result = new MemoryBenchmarkHarness().runCase(conflictCase, 'hybrid');
  assert.equal(result.operationCorrect, true);
  assert.equal(result.conflictCoInjected, false);
  assert.equal(result.oldFactPolluted, false);
  assert.equal(result.newFactAdopted, true);
});

test('Flush 保留承诺与未决事项且 Prompt 不超过预算', () => {
  const flushCase = mineClawZhCases().find(item => item.category === 'flush')!;
  const result = new MemoryBenchmarkHarness().runCase(flushCase, 'hybrid');
  assert.equal(result.flushExecuted, true);
  assert.equal(result.openLoopRetention, 1);
  assert.equal(result.commitmentRetention, 1);
  assert.equal(result.promptBudgetRespected, true);
  assert.ok(result.trace.promptChars <= result.trace.promptBudgetChars);
});

test('聚合报告按 micro-average 输出 Gate 与分类结果', () => {
  const harness = new MemoryBenchmarkHarness();
  const cases = mineClawZhCases().filter(item => item.split === 'test').slice(0, 12);
  const results = cases.map(item => harness.runCase(item, 'hybrid'));
  const scored = summarizeMemoryResults(results, 'hybrid', 'test');
  assert.equal(scored.summary.cases, 12);
  assert.equal(scored.summary.capturePrecision, 1);
  assert.equal(scored.summary.captureRecall, 1);
  assert.ok(scored.gates.gate2.capturePrecision.pass);
  assert.ok(scored.byCategory.preference);
});

test('降级 Case 的 Embedding 失败走 FTS5 并保持回答可用', () => {
  const degradedCase = mineClawZhCases().find(item => item.category === 'degraded')!;
  const result = new MemoryBenchmarkHarness().runCase(degradedCase, 'hybrid');
  assert.equal(result.trace.degradedMode, 'fts5_only');
  assert.equal(result.answerCorrect, true);
});
