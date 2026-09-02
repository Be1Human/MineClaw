/**
 * FEAT-CROSS-28-002 exit side · deterministic answer bridge (E2E offline subset).
 * Query → answer → deterministic speech; no answer → obligation-closing prompt;
 * fact draft without fresh evidence → blocked before expression.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  answerTurnSpeech,
  applyAnswerToTurn,
  guardDraft,
  composeTurn,
} from '../../../../../../apps/minecraft-companion/src/bot/v2/decision/knowledgeAnswerBridge.js';
import type { KnowledgeAnswerV1 } from '../../../../../../apps/minecraft-companion/src/bot/v2/decision/goalAgentPort/knowledgeQueryContracts.js';

function answered(): KnowledgeAnswerV1 {
  return {
    schemaVersion: 'mineclaw.knowledge-answer/v1',
    kind: 'knowledge_answer',
    requestId: 'kq-1', correlationId: 'corr-1', outcome: 'answered',
    facts: [{ factKind: 'nearby_crops', payload: { crops: '小麦' }, observedAt: new Date().toISOString(), requestedBounds: {}, observedBounds: {}, complete: true, truncated: false, evidenceRefs: [{ ref: 'w1', source: 'scan', at: new Date().toISOString() }] }],
    observedAt: new Date().toISOString(),
    freshness: { fresh: true, observedAt: new Date().toISOString() },
    coverage: { dimension: 'overworld', requested: {}, covered: {}, loaded: true },
    completeness: 'complete', evidenceRefs: [], replyKey: 'kq-r1',
    registryGeneration: { generationId: 'g1', buildId: 'b1', graphHash: 'h1' },
  };
}

test('E2E 查询→答案→确定性发言（只转述，不追加事实）', () => {
  const { speech, event } = composeTurn(answered(), '旁边有什么农作物');
  assert.match(speech, /小麦/);
  assert.equal(event.trust, 'machine_validated');
  assert.equal(event.source, 'knowledge_answer');
});

test('无答案 → 义务闭合的确定性询问（不编造事实）', () => {
  const speech = answerTurnSpeech(null, '旁边有什么作物');
  assert.match(speech, /查询一下/);
  assert.doesNotMatch(speech, /小麦|成熟/);
});

test('答案不可用 → 确定性终态模板', () => {
  const unavailable = answered();
  (unavailable as { outcome: string }).outcome = 'unavailable';
  (unavailable as { facts: unknown[] }).facts = [];
  (unavailable as { reason?: string }).reason = 'provider_timeout';
  const speech = answerTurnSpeech(unavailable, '附近有僵尸吗');
  assert.match(speech, /无法取得/);
});

test('fact 草稿无新鲜证据时在被表达前被拦截', () => {
  const decision = guardDraft({ kind: 'answer', text: '旁边有小麦已经成熟了' }, []);
  assert.equal(decision.decision, 'block');
  const allowed = guardDraft({ kind: 'answer', text: '旁边有小麦已经成熟了' }, [answered()]);
  assert.equal(allowed.decision, 'allow');
});

test('turn 桥接：speech 与 context 事件对账（同 correlationId）', () => {
  const answer = answered();
  const turn = applyAnswerToTurn(answer, '附近有作物吗');
  assert.equal(turn.contextEvent?.causationId, answer.correlationId);
  assert.equal(turn.blockedDraft, null);
  assert.match(turn.speech, /小麦/);
});
