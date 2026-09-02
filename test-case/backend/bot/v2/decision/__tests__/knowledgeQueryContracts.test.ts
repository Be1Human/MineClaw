/**
 * FEAT-CROSS-28-001 contract side · Typed query contracts and session lifecycle
 * (test cases KQ-01..KQ-07, IT-02/IT-03; design §5.2/§5.6).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  KnowledgeQuerySessionStore,
  logicalTerminalOutcome,
} from '../../../../../../apps/minecraft-companion/src/bot/v2/decision/goalAgentPort/knowledgeQuerySession.js';
import {
  replyKeyFor,
  isKnowledgeQuery,
  isTaskRequest,
  isCancelRequest,
  type KnowledgeQueryV1,
  type KnowledgeAnswerV1,
} from '../../../../../../apps/minecraft-companion/src/bot/v2/decision/goalAgentPort/knowledgeQueryContracts.js';

const SNAPSHOT = { generationId: 'gen-41', buildId: 'build-1', graphHash: 'h1' };

function query(overrides: Partial<KnowledgeQueryV1> = {}): KnowledgeQueryV1 {
  return {
    schemaVersion: 'mineclaw.knowledge-query/v1',
    kind: 'knowledge_query',
    requestId: overrides.requestId ?? 'kq-req-1',
    correlationId: 'corr-1',
    idempotencyKey: 'idem-1',
    emittedAt: '2026-09-02T00:00:00.000Z',
    source: 'player',
    replyMode: 'answer_player',
    originalText: '周围有什么农作物？',
    factKinds: ['nearby_crops'],
    anchor: { kind: 'bot_self' },
    scope: { radius: 8 },
    freshness: { maxAgeMs: 5000 },
    registryGeneration: SNAPSHOT,
    ...overrides,
  };
}

function answer(requestId: string, outcome: KnowledgeAnswerV1['outcome'] = 'answered'): KnowledgeAnswerV1 {
  return {
    schemaVersion: 'mineclaw.knowledge-answer/v1',
    kind: 'knowledge_answer',
    requestId,
    correlationId: 'corr-1',
    outcome,
    facts: outcome === 'answered' ? [{ factKind: 'nearby_crops', payload: { wheat: 5 }, observedAt: '2026-09-02T00:00:00.100Z', requestedBounds: {}, observedBounds: {}, complete: true, truncated: false, evidenceRefs: [{ ref: 'w1', source: 'scan', at: '2026-09-02T00:00:00.100Z' }] }] : [],
    observedAt: '2026-09-02T00:00:00.100Z',
    freshness: { fresh: true, observedAt: '2026-09-02T00:00:00.100Z' },
    coverage: { dimension: 'overworld', requested: {}, covered: {}, loaded: true },
    completeness: 'complete',
    evidenceRefs: [],
    replyKey: replyKeyFor(query({ requestId })),
    registryGeneration: SNAPSHOT,
  };
}

test('KQ-01 判别合同：query/task/cancel 是可判别闭合联合', () => {
  const typedQuery = query();
  const typedTask = { ...query(), kind: 'task' as const, requestText: '把树砍了', constraints: [] };
  const typedCancel = { ...query(), kind: 'cancel' as const, targetRequestId: 'kq-req-1' };
  assert.ok(isKnowledgeQuery(typedQuery));
  assert.ok(isTaskRequest(typedTask));
  assert.ok(isCancelRequest(typedCancel));
  assert.equal(isTaskRequest(typedQuery), false);
  assert.equal(replyKeyFor(query()), 'kq:corr-1:kq-req-1');
});

test('KQ-02 session：一次逻辑终态；重复终态是合同违规', () => {
  const store = new KnowledgeQuerySessionStore();
  const receipt = store.create(query());
  assert.equal(receipt.requestId, 'kq-req-1');
  store.markRunning('kq-req-1');
  const recorded = store.recordAnswer('kq-req-1', answer('kq-req-1'));
  assert.equal(recorded.answer!.outcome, 'answered');
  // A second logical terminal is rejected.
  assert.throws(() => store.recordAnswer('kq-req-1', answer('kq-req-1')),
    (error: unknown) => (error as { code?: string }).code === 'id_conflict');
});

test('KQ-03 幂等：同 requestId/idempotencyKey 重提交返回同一 receipt；已终态拒绝', () => {
  const store = new KnowledgeQuerySessionStore();
  const first = store.create(query());
  const second = store.create(query());
  assert.equal(second.sessionId, first.sessionId);
  store.markRunning('kq-req-1');
  store.recordAnswer('kq-req-1', answer('kq-req-1'));
  store.resolveDelivery('kq-req-1', 'player_reply');
  assert.throws(() => store.create(query()), (error: unknown) => (error as { code?: string }).code === 'id_conflict');
  // Same requestId with a different idempotency key is a conflict.
  assert.throws(() => store.create(query({ idempotencyKey: 'idem-2' })),
    (error: unknown) => (error as { code?: string }).code === 'id_conflict');
});

test('KQ-04 投递：至少一次 + replyKey 去重；确定性 fallback 可终止', () => {
  const store = new KnowledgeQuerySessionStore();
  store.create(query());
  store.markRunning('kq-req-1');
  store.recordAnswer('kq-req-1', answer('kq-req-1'));
  store.markDeliveryPending('kq-req-1');
  store.markDeliveryPending('kq-req-1');
  const record = store.get('kq-req-1')!;
  assert.equal(record.deliveryAttempts, 2);
  const delivery = store.resolveDelivery('kq-req-1', 'deterministic_fallback');
  assert.equal(delivery.replyKey, 'kq:corr-1:kq-req-1');
  assert.equal(store.get('kq-req-1')!.state, 'delivered');
  assert.throws(() => store.resolveDelivery('kq-req-1', 'player_reply'),
    (error: unknown) => (error as { code?: string }).code === 'id_conflict');
});

test('KQ-05 取消晚到结果不复活会话', () => {
  const store = new KnowledgeQuerySessionStore();
  store.create(query());
  store.markRunning('kq-req-1');
  store.recordAnswer('kq-req-1', answer('kq-req-1', 'cancelled'));
  assert.equal(store.get('kq-req-1')!.state, 'cancelled');
  store.recordLateRejected('kq-req-1');
  assert.equal(store.get('kq-req-1')!.state, 'cancelled');
  assert.throws(() => store.markDeliveryPending('kq-req-1'),
    (error: unknown) => (error as { code?: string }).code === 'plugin_cancelled');
});

test('KQ-06 超时确定性回退：无答案也可合成终态', () => {
  const store = new KnowledgeQuerySessionStore();
  store.create(query());
  store.markRunning('kq-req-1');
  const failed = store.fail('kq-req-1', 'provider_timeout');
  assert.equal(failed.state, 'failed');
  assert.throws(() => store.recordAnswer('kq-req-1', answer('kq-req-1', 'answered')),
    (error: unknown) => (error as { code?: string }).code === 'plugin_cancelled');
});

test('KQ-07 终态语义：每个 outcome 映射到唯一逻辑终态', () => {
  assert.equal(logicalTerminalOutcome('answered'), 'answered');
  for (const outcome of ['not_found', 'unsupported', 'ambiguous', 'unavailable', 'cancelled'] as const) {
    assert.equal(logicalTerminalOutcome(outcome), 'not_answered');
  }
});

test('IT-02 查询会话与任务会话状态空间分离：query 永不成为 task supplement', () => {
  const store = new KnowledgeQuerySessionStore();
  store.create(query({ requestId: 'kq-a', correlationId: 'corr-a' }));
  store.markRunning('kq-a');
  store.recordAnswer('kq-a', answer('kq-a', 'unavailable'));
  store.resolveDelivery('kq-a', 'timeout_fallback');
  const record = store.get('kq-a')!;
  assert.equal(record.state, 'delivered');
  // 独立查询会话不创建任何 task 会话记录。
  assert.equal(store.listByState('running').length, 0);
  assert.equal(store.listByState('delivered').length, 1);
});
