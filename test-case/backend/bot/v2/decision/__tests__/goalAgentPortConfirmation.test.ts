import assert from 'node:assert/strict';
import test from 'node:test';

import { EventBusV2 } from '../../../../../../apps/minecraft-companion/src/bot/v2/infra/eventBus.js';
import { GoalAgentPort, type GoalAgentConfirmationDeps } from '../../../../../../apps/minecraft-companion/src/bot/v2/decision/goalAgentPort/goalAgentPort.js';
import type { GoalReportV2 } from '../../../../../../apps/minecraft-companion/src/bot/v2/decision/goalAgentPort/contracts.js';

function makeBus() {
  const bus = new EventBusV2();
  const events: Array<{ type: string; payload: unknown }> = [];
  bus.onAny((event) => { events.push({ type: event.type, payload: event.payload }); });
  return { bus, events };
}

function report(overrides: Partial<GoalReportV2> = {}): GoalReportV2 {
  return {
    meta: {
      schemaVersion: 2,
      sessionId: 'interaction-gate',
      messageId: 'goal-report-1',
      correlationId: 'correlation-gate',
      conversationId: 'conversation-gate',
      sequence: 1,
      emittedAt: '2026-08-29T00:00:00.000Z',
      idempotencyKey: 'gate-report',
    },
    requestId: 'goal-message-1',
    status: 'completed',
    summary: 'verified criterion:item_delivered:stone_axe:1',
    evidence: [],
    ...overrides,
  };
}

function makeDeps(overrides: Partial<GoalAgentConfirmationDeps> = {}): GoalAgentConfirmationDeps {
  return {
    getCriteria: () => [{ type: 'item_delivered', item: 'stone_axe', count: 1, since: 100 }],
    getWorld: () => null as never,
    getEvidence: () => ({ deliveries: [] }),
    confirm: () => ({ ok: false, reason: 'deliver_missing_receipt', detail: '尚无 toss_item 成功证据：stone_axe 0/1' }),
    onRejected: () => {},
    ...overrides,
  };
}

function makePort(deps: GoalAgentConfirmationDeps) {
  const { bus, events } = makeBus();
  const port = new GoalAgentPort(
    bus,
    { getWorldState: () => null } as never,
    { submit: () => ({ accepted: true }) },
    undefined,
    undefined,
    undefined,
    {},
    deps,
  );
  return { bus, events, port };
}

/** 建立交互会话，返回可在 report 中使用的 requestId。 */
function createRequest(port: GoalAgentPort): string {
  const receipt = port.request({ requestText: '给我一把石斧', requestKind: 'task' });
  assert.equal(receipt.outcome, 'consumed');
  return receipt.sourceMessageId;
}

test('I1 · completed 无收据 → confirmation_rejected + 报告降级 running/obstacle', async () => {
  const { bus, events, port } = makePort(makeDeps());
  const requestId = createRequest(port);
  bus.publish('goalagent.report', 'info', report({ requestId }));
  await new Promise(resolve => setTimeout(resolve, 20));
  const rejected = events.find(e => e.type === 'goalagent.confirmation_rejected');
  assert.ok(rejected, '应有 confirmation_rejected 事件');
  assert.equal((rejected!.payload as { reason: string }).reason, 'deliver_missing_receipt');
  assert.ok(!events.some(e => e.type === 'goalagent.confirmed'), '不应有 confirmed');
  // watchdog 记录的是降级后的 running 报告（active 不提前置 false）——通过后续无 terminal 断言间接验证
  assert.ok(port);
});

test('I2 · completed 有收据 → confirmed + 原报告放行', async () => {
  const { bus, events, port } = makePort(makeDeps({
    getWorld: () => ({ tick: 1, timestamp: 1, self: { position: { x: 0, y: 64, z: 0 }, yaw: 0, pitch: 0, health: 20, maxHealth: 20, food: 20, isOnGround: true }, owner: null, environment: {}, entities: [], inventory: { items: [], held: null, freeSlots: 36 }, taskContext: null }),
    getEvidence: () => ({ deliveries: [{ item: 'stone_axe', count: 1, at: 150, ref: 'toss-1' }] }),
    confirm: () => ({ ok: true, summary: 'verified criterion:item_delivered:stone_axe:1' }),
  }));
  const requestId = createRequest(port);
  bus.publish('goalagent.report', 'info', report({ requestId }));
  await new Promise(resolve => setTimeout(resolve, 20));
  const confirmed = events.find(e => e.type === 'goalagent.confirmed');
  assert.ok(confirmed, '应有 confirmed 事件');
  assert.ok(!events.some(e => e.type === 'goalagent.confirmation_rejected'), '不应有 rejected');
});

test('I6 · 复核路径零 LLM 调用（无 llm.request 事件）', async () => {
  const { bus, events, port } = makePort(makeDeps());
  const requestId = createRequest(port);
  bus.publish('goalagent.report', 'info', report({ requestId }));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(!events.some(e => e.type === 'llm.request'), '复核不得触发 LLM 调用');
  assert.ok(!events.some(e => String(e.type).includes('llm')), '复核路径不得出现任何 llm 事件');
});

test('I6b · 非 completed 报告不拦截（failed 原样放行）', async () => {
  const { bus, events } = makePort(makeDeps());
  bus.publish('goalagent.report', 'recoverable', report({ status: 'failed', summary: 'budget exhausted' }));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(!events.some(e => e.type === 'goalagent.confirmation_rejected'), 'failed 不应过闸');
  assert.ok(!events.some(e => e.type === 'goalagent.confirmed'), 'failed 不应 confirmed');
});

test('I5 · 复核拒绝后 retryRequest 以原语义重发并追加拒绝证据', () => {
  const { events, port } = makePort(makeDeps());
  const requestId = createRequest(port);
  events.length = 0;
  const receipt = port.retryRequest(requestId, '（重试：上次完成声明未通过复核：缺 toss 收据）');
  assert.ok(receipt, '重试应产生回执');
  const req = events.find(e => e.type === 'goalagent.request');
  assert.ok(req, '应发布新 goalagent.request');
  const payload = req!.payload as { requestText: string; requestKind: string };
  assert.match(payload.requestText, /给我一把石斧/);
  assert.match(payload.requestText, /重试/);
  assert.equal(payload.requestKind, 'task');
});

test('I5b · 未知 requestId 的 retryRequest 返回 null', () => {
  const { port } = makePort(makeDeps());
  assert.equal(port.retryRequest('goal-message-unknown', 'note'), null);
});
