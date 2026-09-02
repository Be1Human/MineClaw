/**
 * FEAT-CROSS-28-002 message surface side (CX-06..CX-08, IT-05/IT-07; design §5.7).
 * Base system stability, message surface compilation rules, runtime context
 * events never enter the system and never masquerade as chat.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildBaseSystemPrompt, baseSystemStable } from '../../../../../../apps/minecraft-companion/src/bot/v2/decision/baseSystemPrompt.js';
import { MessageSurfaceCompiler, surfaceInvariant } from '../../../../../../apps/minecraft-companion/src/bot/v2/decision/messageSurfaceCompiler.js';
import { knowledgeAnswerContextEvent } from '../../../../../../apps/minecraft-companion/src/bot/v2/decision/runtimeContextEvent.js';
import { renderKnowledgeAnswer } from '../../../../../../apps/minecraft-companion/src/bot/v2/decision/factClaimGuard.js';
import type { KnowledgeAnswerV1 } from '../../../../../../apps/minecraft-companion/src/bot/v2/decision/goalAgentPort/knowledgeQueryContracts.js';

const CONFIG = { ownerName: 'Alice', botName: 'MineFriend', persona: '随和、有主见' };

function answer(): KnowledgeAnswerV1 {
  return {
    schemaVersion: 'mineclaw.knowledge-answer/v1',
    kind: 'knowledge_answer',
    requestId: 'kq-1',
    correlationId: 'corr-1',
    outcome: 'answered',
    facts: [{ factKind: 'nearby_crops', payload: { crops: '小麦' }, observedAt: '2026-09-02T00:00:00.000Z', requestedBounds: {}, observedBounds: {}, complete: true, truncated: false, evidenceRefs: [{ ref: 'w1', source: 'scan', at: '2026-09-02T00:00:00.000Z' }] }],
    observedAt: '2026-09-02T00:00:00.000Z',
    freshness: { fresh: true, observedAt: '2026-09-02T00:00:00.000Z' },
    coverage: { dimension: 'overworld', requested: {}, covered: {}, loaded: true },
    completeness: 'complete',
    evidenceRefs: [{ ref: 'w1', source: 'scan', at: '2026-09-02T00:00:00.000Z' }],
    replyKey: 'kq-r1',
    registryGeneration: { generationId: 'g1', buildId: 'b1', graphHash: 'h1' },
  };
}

test('CX-06 同静态配置下 base system hash 稳定；不同配置变化', () => {
  assert.equal(baseSystemStable(CONFIG), true);
  const first = buildBaseSystemPrompt(CONFIG);
  const second = buildBaseSystemPrompt(CONFIG);
  assert.equal(first.hash, second.hash);
  assert.equal(first.id, second.id);
  const different = buildBaseSystemPrompt({ ...CONFIG, persona: '高冷' });
  assert.notEqual(different.hash, first.hash);
  // 动态内容不参与：同一配置每次生成一致。
  assert.doesNotMatch(first.content, /对话记录|记忆块|userMessage|conversationHistory/);
});

test('CX-07 消息面：chat 保留 user/assistant，tool 结果保留 tool role', () => {
  const base = buildBaseSystemPrompt(CONFIG);
  const compiler = new MessageSurfaceCompiler({ providerSupportsDeveloperRole: true });
  const surface = compiler.compile(base, [
    { id: 'm1', role: 'user', content: '嗨' },
    { id: 'm2', role: 'assistant', content: '你好呀' },
    { id: 'm3', role: 'assistant', content: '', toolCallId: 'call-1' },
    { id: 'm4', role: 'tool', content: '{"ok":true}', toolCallId: 'call-1' },
  ]);
  assert.deepEqual(surface.messages.map(m => m.role), ['user', 'assistant', 'assistant', 'tool']);
  assert.equal(surface.messages[0]!.role, 'user');
  assert.equal(surface.messages[3]!.role, 'tool');
  assert.equal(surface.omitted.length, 0);
  // base 从未被改写。
  assert.equal(surface.base.hash, base.hash);
});

test('CX-08 runtime context 事件映射为受控 developer/context 消息且不进 system；audit_only 省略并记录原因', () => {
  const base = buildBaseSystemPrompt(CONFIG);
  const compiler = new MessageSurfaceCompiler({ providerSupportsDeveloperRole: false });
  const event = knowledgeAnswerContextEvent(answer());
  const surface = compiler.compile(base, [
    { id: 'e1', role: 'runtime_context', content: '', event },
    { id: 'e2', role: 'runtime_context', content: '', event: { ...event, visibility: 'audit_only' } },
  ]);
  const mapped = surface.messages.find(m => m.role === 'context');
  assert.ok(mapped, 'context event must map to a controlled context message');
  assert.match(mapped!.content, /knowledge_answer · trust=machine_validated/);
  assert.equal(surface.omitted.length, 1);
  assert.equal(surface.omitted[0]!.reason, 'audit_only');
  assert.equal(surface.trace.find(t => t.eventId === 'e1')?.mappedRole, 'context');
  // developer 支持版映射为 developer 角色。
  const developerCompiler = new MessageSurfaceCompiler({ providerSupportsDeveloperRole: true });
  const devSurface = developerCompiler.compile(base, [{ id: 'e1', role: 'runtime_context', content: '', event }]);
  assert.equal(devSurface.messages[0]!.role, 'developer');
});

test('IT-05 知识答案事件经渲染器与消息面到达玩家面：不丢事实、可对账', () => {
  const event = knowledgeAnswerContextEvent(answer());
  const rendered = renderKnowledgeAnswer(answer());
  assert.match(rendered, /小麦/);
  assert.equal(event.source, 'knowledge_answer');
  assert.equal(event.trust, 'machine_validated');
  const surface = new MessageSurfaceCompiler({ providerSupportsDeveloperRole: true }).compile(
    buildBaseSystemPrompt(CONFIG),
    [{ id: 'e1', role: 'runtime_context', content: '', event }],
  );
  assert.equal(surfaceInvariant(surface.base), surface.base.id + '@' + surface.base.hash);
});
