/**
 * FEAT-CROSS-28-002 contract side · FactIntentGate / FactClaimGuard / renderer
 * (QI-01..QI-06, CX-01..CX-08; design §5.3).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { FactIntentGate, KnowledgeQueryFactory } from '../../../../../../apps/minecraft-companion/src/bot/v2/decision/factIntentGate.js';
import { FactClaimGuard, renderKnowledgeAnswer } from '../../../../../../apps/minecraft-companion/src/bot/v2/decision/factClaimGuard.js';
import type { KnowledgeAnswerV1 } from '../../../../../../apps/minecraft-companion/src/bot/v2/decision/goalAgentPort/knowledgeQueryContracts.js';

const SNAPSHOT = { generationId: 'gen-41', buildId: 'build-1', graphHash: 'h1' };

function answered(overrides: Partial<KnowledgeAnswerV1> = {}): KnowledgeAnswerV1 {
  return {
    schemaVersion: 'mineclaw.knowledge-answer/v1',
    kind: 'knowledge_answer',
    requestId: 'kq-1',
    correlationId: 'corr-1',
    outcome: 'answered',
    facts: [{ factKind: 'nearby_crops', payload: { crops: '小麦' }, observedAt: new Date().toISOString(), requestedBounds: {}, observedBounds: {}, complete: true, truncated: false, evidenceRefs: [{ ref: 'w1', source: 'scan', at: new Date().toISOString() }] }],
    observedAt: new Date().toISOString(),
    freshness: { fresh: true, observedAt: new Date().toISOString() },
    coverage: { dimension: 'overworld', requested: {}, covered: {}, loaded: true },
    completeness: 'complete',
    evidenceRefs: [],
    replyKey: 'kq-r1',
    registryGeneration: SNAPSHOT,
    ...overrides,
  };
}

test('QI-01 实时事实表达（中文）判定 knowledge_query 并留证据', () => {
  const gate = new FactIntentGate();
  for (const text of ['旁边有什么农作物？', '周围有哪些方块', '我背包里有什么', '主人现在在哪', '附近有僵尸吗', '还剩多少小麦']) {
    const decision = gate.classify(text);
    assert.equal(decision.intent, 'knowledge_query', text);
    assert.ok(decision.evidence.length > 0, text);
  }
});

test('QI-02 语义负例：讨论/寒暄/建议保持 chat', () => {
  const gate = new FactIntentGate();
  for (const text of ['你觉得哪种木头做工具更好', '今天天气不错吧', '讲个笑话', '谢谢', '你好呀', '你怎么看待建造']) {
    assert.equal(gate.classify(text).intent, 'chat', text);
  }
});

test('QI-03 高召回偏向：行动词与查询词并存时按查询处理', () => {
  const gate = new FactIntentGate();
  const decision = gate.classify('帮我看看附近有什么矿石可以挖');
  assert.equal(decision.intent, 'knowledge_query');
  assert.equal(decision.leaning, 'query');
});

test('QI-04 任务指令判定 task；取消判定 cancel；待答上下文行动词不新开任务', () => {
  const gate = new FactIntentGate();
  assert.equal(gate.classify('去砍一棵橡树').intent, 'task');
  assert.equal(gate.classify('别跟了，停下').intent, 'cancel');
  assert.equal(gate.classify('继续做').intent, 'task');
  assert.equal(gate.classify('继续做', { conversationMode: 'awaiting_player' }).intent, 'chat');
});

test('QI-05 查询工厂产出闭合 query（request/idempotency/reply key 域）', () => {
  const factory = new KnowledgeQueryFactory({
    factKinds: ['nearby_crops'], anchor: { kind: 'bot_self' }, scope: { radius: 8 }, freshness: { maxAgeMs: 5000 },
  });
  const decision = new FactIntentGate().classify('旁边有什么作物');
  const query = factory.create(decision, { text: '旁边有什么作物', source: 'player' }, SNAPSHOT, 3);
  assert.equal(query.kind, 'knowledge_query');
  assert.ok(query.requestId);
  assert.ok(query.idempotencyKey);
  assert.match(query.correlationId, /^corr-/);
  assert.deepEqual(query.factKinds, ['nearby_crops']);
  assert.equal(query.registryGeneration, SNAPSHOT);
});

test('CX-01 无答案证据的事实草稿被拒绝', () => {
  const guard = new FactClaimGuard();
  const blocked = guard.validateDraft({ kind: 'say', text: '你和旁边有小麦已经成熟了' }, []);
  assert.equal(blocked.decision, 'block');
  assert.match(blocked.reason!, /without a machine-validated/);
});

test('CX-02 有新鲜匹配答案时放行；过期答案拒绝', () => {
  const guard = new FactClaimGuard();
  const fresh = answered({ observedAt: new Date().toISOString() });
  assert.equal(guard.validateDraft({ kind: 'answer', text: '旁边有小麦' }, [fresh]).decision, 'allow');
  const stale = answered({ observedAt: '2020-01-01T00:00:00.000Z' });
  assert.equal(guard.validateDraft({ kind: 'answer', text: '旁边有小麦' }, [stale]).decision, 'block');
});

test('CX-03 partial/incomplete 证据不得支撑绝对声称', () => {
  const guard = new FactClaimGuard();
  const partial = answered({ completeness: 'partial' });
  const decision = guard.validateDraft({ kind: 'answer', text: '完成任务了' }, [partial]);
  assert.equal(decision.decision, 'block');
  assert.match(decision.reason!, /partial/);
});

test('CX-04 纯聊天草稿不触发事实规则', () => {
  const guard = new FactClaimGuard();
  assert.equal(guard.validateDraft({ kind: 'say', text: '你今天开心吗' }, []).decision, 'allow');
});

test('CX-05 确定性渲染：六种终态模板、无模型追加事实', () => {
  assert.match(renderKnowledgeAnswer(answered()), /小麦/);
  assert.match(renderKnowledgeAnswer({ ...answered(), outcome: 'not_found', facts: [] }), /没有找到/);
  assert.match(renderKnowledgeAnswer({ ...answered(), outcome: 'unsupported', facts: [] }), /不具备/);
  assert.match(renderKnowledgeAnswer({ ...answered(), outcome: 'ambiguous', facts: [], clarification: { questionKind: 'field', options: ['A'], question: '哪块田？' } }), /确认/);
  assert.match(renderKnowledgeAnswer({ ...answered(), outcome: 'unavailable', facts: [] }), /无法取得/);
  assert.match(renderKnowledgeAnswer({ ...answered(), outcome: 'cancelled', facts: [] }), /取消/);
});
