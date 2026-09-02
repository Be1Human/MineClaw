/**
 * FEAT-CROSS-28-004 contract side · Trace core (TR-01..TR-06; design §5.8).
 * Request projection reconciles the audit record with the actual outbound
 * request; every omission carries a reason; causality chains are correlatable.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildRequestProjection,
  toolsSchemaHash,
  projectVisibility,
  buildCausalityChain,
  assertNoSilentOmission,
} from '../../../../../../apps/minecraft-companion/src/bot/v2/decision/traceCore.js';
import { buildBaseSystemPrompt } from '../../../../../../apps/minecraft-companion/src/bot/v2/decision/baseSystemPrompt.js';

const BASE = buildBaseSystemPrompt({ ownerName: 'Alice', botName: 'MineFriend' });

test('TR-01 实际 outbound 请求可对账：base id/hash、tools hash、消息与角色映射', () => {
  const projection = buildRequestProjection({
    callId: 'call-1',
    agent: 'mainbrain',
    model: 'deepseek-chat',
    provider: 'deepseek-official',
    base: BASE,
    tools: [{ name: 'say', schema: '{"type":"object"}' }, { name: 'ask_master', schema: '{"type":"object"}' }],
    messages: [{ role: 'system', content: BASE.content }, { role: 'user', content: '你好' }],
  });
  assert.equal(projection.callId, 'call-1');
  assert.equal(projection.baseSystemId, BASE.id);
  assert.equal(projection.baseSystemHash, BASE.hash);
  assert.ok(projection.toolsSchemaHash.length > 0);
  assert.equal(projection.messages.length, 2);
  assert.equal(projection.messages[1]!.contentPreview, '你好');
  // 相同工具集 hash 稳定。
  const again = buildRequestProjection({
    callId: 'call-2', agent: 'mainbrain', model: 'x', provider: 'y', base: BASE,
    tools: [{ name: 'ask_master', schema: '{"type":"object"}' }, { name: 'say', schema: '{"type":"object"}' }],
    messages: [],
  });
  assert.equal(again.toolsSchemaHash, projection.toolsSchemaHash);
});

test('TR-02 事件→surface 映射：model_visible 与 audit_only/compacted 各带 omittedReason', () => {
  const visible = projectVisibility('evt-1', undefined, 'user');
  assert.deepEqual(visible, { eventId: 'evt-1', target: 'user', visibility: 'model_visible' });
  const omitted = projectVisibility('evt-2', 'permission_isolation', 'user');
  assert.deepEqual(omitted, { eventId: 'evt-2', target: null, visibility: 'audit_only', omittedReason: 'permission_isolation' });
});

test('TR-03 因果链：同一 correlationId 从 query 到 answer 可追踪', () => {
  const events = [
    { id: 'kq-submit', correlationId: 'corr-1' },
    { id: 'kq-observe', correlationId: 'corr-1' },
    { id: 'kq-answer', correlationId: 'corr-1' },
    { id: 'other', correlationId: 'corr-2' },
  ];
  const chain = buildCausalityChain('corr-1', events, 'kq-submit');
  assert.deepEqual(chain, ['kq-submit', 'kq-observe', 'kq-answer']);
});

test('TR-04 无静默省略：审计记录每条都有 surface 映射或明确原因', () => {
  const projection = buildRequestProjection({
    callId: 'call-3', agent: 'goalagent', model: 'm', provider: 'p', base: BASE, tools: [],
    messages: [],
    surfaceMap: [
      { eventId: 'e1', target: 'user', visibility: 'model_visible' },
      { eventId: 'e2', target: null, visibility: 'audit_only', omittedReason: 'redacted' },
    ],
  });
  assert.equal(assertNoSilentOmission(projection, ['e1', 'e2']), true);
  assert.equal(assertNoSilentOmission(projection, ['e1', 'e2', 'e3']), false);
});

test('TR-05 hash 稳定：同静态配置与同工具集 → 同一投影标识', () => {
  const a = buildRequestProjection({ callId: 'c1', agent: 'mainbrain', model: 'x', provider: 'y', base: BASE, tools: [], messages: [] });
  const b = buildRequestProjection({ callId: 'c2', agent: 'mainbrain', model: 'x', provider: 'y', base: BASE, tools: [], messages: [] });
  assert.equal(a.baseSystemHash, b.baseSystemHash);
  assert.equal(a.toolsSchemaHash, b.toolsSchemaHash);
  assert.notEqual(toolsSchemaHash([{ name: 'a', schema: '{"x":1}' }]), toolsSchemaHash([{ name: 'a', schema: '{"x":2}' }]));
});

test('TR-06 跨 Agent 不泄漏：MainBrain 投影不含 GoalAgent raw tool 事件', () => {
  const projection = buildRequestProjection({
    callId: 'mb-1', agent: 'mainbrain', model: 'x', provider: 'y', base: BASE, tools: [],
    messages: [{ role: 'user', content: '你好' }],
    surfaceMap: [
      { eventId: 'mb-observe', target: 'user', visibility: 'model_visible' },
    ],
  });
  const ids = projection.surfaceMap.map(entry => entry.eventId);
  assert.ok(!ids.includes('ga-raw-tool'));
  assert.equal(projection.messages.length, 1);
});
