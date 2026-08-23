import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LlmTraceEventStore,
  LlmTraceQueryError,
  LlmTraceQueryService,
  type LlmTraceEventInputV1,
} from '../../../../../../apps/minecraft-companion/src/bot/v2/infra/llmTrace/index.js';

function append(
  store: LlmTraceEventStore,
  eventId: string,
  type: LlmTraceEventInputV1['type'],
  overrides: Partial<LlmTraceEventInputV1> = {},
): void {
  store.append({
    eventId,
    occurredAt: `2026-08-22T04:00:${String(store.listEvents().events.length).padStart(2, '0')}.000Z`,
    type,
    interactionSessionId: 'interaction-a',
    agent: 'mainbrain',
    payload: {},
    ...overrides,
  });
}

function seededStore(): LlmTraceEventStore {
  const store = new LlmTraceEventStore({ filename: ':memory:', profileId: 'profile-a' });
  append(store, 'a-interaction', 'interaction.received', {
    payload: { message: '给我一块石头' },
  });
  append(store, 'a-request', 'llm.request.recorded', {
    callId: 'main-call',
    payload: {
      inputHash: 'hash-main',
      request: {
        provider: 'deepseek', model: 'deepseek-v4-flash', timeoutMs: 30_000,
        messages: [{ role: 'system', content: '人格' }, { role: 'user', content: '给我一块石头' }],
        tools: [{ type: 'function', function: { name: 'delegate_goal' } }],
        context: { selected: [{ kind: 'identity', ref: 'character-card:v1' }], omitted: [] },
      },
    },
  });
  append(store, 'a-delegate', 'delegation.submitted', {
    callId: 'main-call', goalSessionId: 'goal-a', taskId: 'task-a', payload: { goal: '给玩家石头' },
  });
  append(store, 'a-goal-request', 'llm.request.recorded', {
    callId: 'goal-call', goalSessionId: 'goal-a', taskId: 'task-a', agent: 'goalagent', node: 'planner',
    payload: {
      inputHash: 'hash-goal',
      request: {
        provider: 'deepseek', model: 'deepseek-v4-flash', timeoutMs: 30_000,
        messages: [{ role: 'user', content: '规划给玩家一块石头' }], tools: [],
        context: { selected: [{ kind: 'task-state', ref: 'task-a:r1' }], omitted: [] },
      },
    },
  });
  append(store, 'a-goal-response', 'llm.response.recorded', {
    callId: 'goal-call', goalSessionId: 'goal-a', taskId: 'task-a', agent: 'goalagent', node: 'planner',
    payload: { finishReason: 'stop', content: '{"plan":[]}', durationMs: 12 },
  });
  append(store, 'a-terminal', 'session.terminal', {
    goalSessionId: 'goal-a', taskId: 'task-a', agent: 'goalagent', payload: { outcome: 'completed' },
  });
  append(store, 'b-request', 'llm.request.recorded', {
    interactionSessionId: 'interaction-b', callId: 'b-call',
    payload: { request: { provider: 'deepseek', model: 'deepseek-v4-flash', messages: [], tools: [], context: { selected: [], omitted: [] } } },
  });
  return store;
}

test('groups every turn in one persistent Profile conversation', () => {
  const store = seededStore();
  try {
    const query = new LlmTraceQueryService(store);
    const page = query.listSessions({ limit: 1 });
    assert.equal(page.sessions.length, 1);
    assert.equal(page.sessions[0]?.sessionId, 'conversation:profile-a');
    assert.equal(page.sessions[0]?.conversationSessionId, 'conversation:profile-a');
    assert.equal(page.sessions[0]?.eventCount, 7);
    assert.equal(page.sessions[0]?.callCount, 3);
    assert.deepEqual(page.sessions[0]?.agents, ['mainbrain', 'goalagent']);
    assert.equal(page.sessions[0]?.status, 'in_flight');
    assert.equal(page.hasMore, false);
  } finally {
    store.close();
  }
});

test('keeps repeated turn numbers isolated across runtime restarts and filters one turn ledger', () => {
  const store = new LlmTraceEventStore({ filename: ':memory:', profileId: 'profile-dialogue' });
  try {
    for (const [index, interactionSessionId, message] of [
      [1, 'turn-before-restart', '第一轮'],
      [2, 'turn-after-restart', '第二轮'],
    ] as const) {
      append(store, `entry-${index}`, 'interaction.received', {
        interactionSessionId, turn: 0, payload: { message },
      });
      append(store, `request-${index}`, 'llm.request.recorded', {
        interactionSessionId, turn: 0, callId: `call-${index}`,
        payload: { request: { provider: 'deepseek', model: 'v4', messages: [], tools: [] } },
      });
      append(store, `response-${index}`, 'llm.response.recorded', {
        interactionSessionId, turn: 0, callId: `call-${index}`,
        payload: { usage: { cachedInputTokens: index, cacheMissInputTokens: 10 - index, cacheEligibleInputTokens: 10, cacheStatus: 'reported', source: 'fixture' } },
      });
    }
    append(store, 'goal-restart', 'tool.result', {
      interactionSessionId: 'turn-before-restart', goalSessionId: 'goal-one', agent: 'goalagent', payload: {},
    });

    const query = new LlmTraceQueryService(store);
    const session = query.listSessions().sessions[0]!;
    assert.equal(session.sessionId, 'conversation:profile-dialogue');
    assert.equal(session.turnCount, 2);
    assert.deepEqual(session.turns.map(turn => [turn.turnId, turn.turn, turn.title]), [
      ['turn-before-restart', 0, '第一轮'],
      ['turn-after-restart', 0, '第二轮'],
    ]);
    assert.equal(session.cache.cachedInputTokens, 3);
    assert.equal(session.cache.cacheEligibleInputTokens, 20);

    const oneTurn = query.listEvents({
      sessionId: session.sessionId,
      interactionSessionId: 'turn-before-restart',
    });
    assert.deepEqual(oneTurn.events.map(event => event.eventId), ['entry-1', 'request-1', 'response-1', 'goal-restart']);
    assert.equal(oneTurn.cache?.cachedInputTokens, 3);
    assert.equal(oneTurn.turns?.length, 2);
  } finally {
    store.close();
  }
});

test('event list supports filters and does not expose the full request payload', () => {
  const store = seededStore();
  try {
    const page = new LlmTraceQueryService(store).listEvents({
      sessionId: 'interaction-a', agent: 'goalagent', node: 'planner', limit: 10,
    });
    assert.deepEqual(page.events.map(event => event.eventId), ['a-goal-request', 'a-goal-response']);
    assert.equal(page.events[0]?.payloadTruncated, true);
    assert.equal(page.events[0]?.payload.messageCount, 1);
    assert.equal('request' in (page.events[0]?.payload ?? {}), false);
  } finally {
    store.close();
  }
});

test('call detail returns the exact recorded request, context, tools and timing', () => {
  const store = seededStore();
  try {
    const call = new LlmTraceQueryService(store).getCall('goal-call');
    assert.equal(call?.status, 'succeeded');
    assert.deepEqual(call?.request.messages, [{ role: 'user', content: '规划给玩家一块石头' }]);
    assert.deepEqual(call?.context, { selected: [{ kind: 'task-state', ref: 'task-a:r1' }], omitted: [] });
    assert.deepEqual(call?.tools, []);
    assert.equal(call?.timing.durationMs, 12);
    assert.equal(call?.cacheStatus, 'unsupported');
    assert.equal(call?.cacheHitRate, null);
  } finally {
    store.close();
  }
});

test('projects token-weighted cache metrics for calls, the player turn and the session', () => {
  const store = new LlmTraceEventStore({ filename: ':memory:', profileId: 'profile-cache' });
  try {
    append(store, 'turn-entry', 'interaction.received', {
      interactionSessionId: 'cache-interaction', turn: 7, payload: { message: '帮我找煤矿' },
    });
    append(store, 'main-request', 'llm.request.recorded', {
      interactionSessionId: 'cache-interaction', turn: 7, callId: 'cache-main',
      payload: { request: { provider: 'deepseek', model: 'v4', messages: [], tools: [] } },
    });
    append(store, 'main-response', 'llm.response.recorded', {
      interactionSessionId: 'cache-interaction', turn: 7, callId: 'cache-main',
      payload: {
        usage: {
          inputTokens: 100, cachedInputTokens: 80, cacheMissInputTokens: 20,
          cacheEligibleInputTokens: 100, cacheStatus: 'reported', source: 'fixture-main',
        },
      },
    });
    // GoalAgent 只携带 interactionSessionId，查询层应从入口事件解析成同一轮。
    append(store, 'goal-request', 'llm.request.recorded', {
      interactionSessionId: 'cache-interaction', goalSessionId: 'goal-cache',
      callId: 'cache-goal', agent: 'goalagent',
      payload: { request: { provider: 'deepseek', model: 'v4', messages: [], tools: [] } },
    });
    append(store, 'goal-response', 'llm.response.recorded', {
      interactionSessionId: 'cache-interaction', goalSessionId: 'goal-cache',
      callId: 'cache-goal', agent: 'goalagent',
      payload: {
        usage: {
          inputTokens: 10, cachedInputTokens: 1, cacheMissInputTokens: 9,
          cacheEligibleInputTokens: 10, cacheStatus: 'reported', source: 'fixture-goal',
        },
      },
    });
    append(store, 'legacy-request', 'llm.request.recorded', {
      interactionSessionId: 'cache-interaction', turn: 7, callId: 'cache-legacy',
      payload: { request: { provider: 'legacy', model: 'old', messages: [], tools: [] } },
    });
    append(store, 'legacy-response', 'llm.response.recorded', {
      interactionSessionId: 'cache-interaction', turn: 7, callId: 'cache-legacy', payload: {},
    });

    const query = new LlmTraceQueryService(store);
    const session = query.listSessions().sessions[0]!;
    assert.equal(session.cache.cachedInputTokens, 81);
    assert.equal(session.cache.cacheEligibleInputTokens, 110);
    assert.equal(session.cache.cacheHitRate, 81 / 110);
    assert.equal(session.cache.reportedCalls, 2);
    assert.equal(session.cache.totalCalls, 3);
    assert.equal(session.cache.unsupportedCalls, 1);
    assert.equal(session.cache.byAgent.mainbrain?.cacheHitRate, 80 / 100);
    assert.equal(session.cache.byAgent.goalagent?.cacheHitRate, 1 / 10);
    assert.equal(session.turns.length, 1);
    assert.equal(session.turns[0]?.turn, 7);
    assert.equal(session.turns[0]?.cache.cacheHitRate, 81 / 110);

    const eventPage = query.listEvents({ sessionId: 'cache-interaction' });
    const events = eventPage.events;
    assert.equal(eventPage.cache?.cacheHitRate, 81 / 110);
    assert.equal(eventPage.turns?.[0]?.cache.cacheHitRate, 81 / 110);
    assert.equal(events.find(event => event.eventId === 'turn-entry')?.turnCache?.cacheHitRate, 81 / 110);
    assert.equal(events.find(event => event.eventId === 'goal-request')?.cache?.cacheHitRate, 1 / 10);
    assert.equal(query.getCall('cache-main')?.usage.cachedInputTokens, 80);
    assert.equal(query.getCall('cache-main')?.cacheHitRate, 0.8);
  } finally {
    store.close();
  }
});

test('distinguishes true zero from unsupported and counts calls without a turn as unattributed', () => {
  const store = new LlmTraceEventStore({ filename: ':memory:', profileId: 'profile-statuses' });
  try {
    append(store, 'zero-request', 'llm.request.recorded', {
      interactionSessionId: undefined, goalSessionId: 'goal-only', callId: 'zero-call', agent: 'goalagent',
      payload: { request: { provider: 'deepseek', model: 'v4', messages: [], tools: [] } },
    });
    append(store, 'zero-response', 'llm.response.recorded', {
      interactionSessionId: undefined, goalSessionId: 'goal-only', callId: 'zero-call', agent: 'goalagent',
      payload: {
        usage: {
          cachedInputTokens: 0, cacheMissInputTokens: 50, cacheEligibleInputTokens: 50,
          cacheStatus: 'reported', source: 'fixture-zero',
        },
      },
    });
    append(store, 'failed-request', 'llm.request.recorded', {
      interactionSessionId: undefined, goalSessionId: 'goal-only', callId: 'failed-call', agent: 'goalagent',
      payload: { request: { provider: 'deepseek', model: 'v4', messages: [], tools: [] } },
    });
    append(store, 'failed-terminal', 'llm.call.failed', {
      interactionSessionId: undefined, goalSessionId: 'goal-only', callId: 'failed-call', agent: 'goalagent',
      payload: { kind: 'http_error' },
    });

    const query = new LlmTraceQueryService(store);
    const session = query.listSessions().sessions[0]!;
    assert.equal(session.cache.cacheHitRate, 0);
    assert.equal(session.cache.reportedCalls, 1);
    assert.equal(session.cache.unavailableCalls, 1);
    assert.equal(session.cache.unattributedCalls, 2);
    assert.equal(session.turns.length, 0);
    assert.equal(query.getCall('failed-call')?.cacheStatus, 'unavailable');
    assert.equal(query.getCall('failed-call')?.cacheHitRate, null);
  } finally {
    store.close();
  }
});

test('exports one session as ordered lossless JSONL and rejects oversized exports', () => {
  const store = seededStore();
  try {
    const jsonl = new LlmTraceQueryService(store).exportSession('interaction-a');
    const exported = jsonl.trim().split('\n').map(line => JSON.parse(line) as { seq: number; interactionSessionId: string });
    assert.deepEqual(exported.map(event => event.seq), [1, 2, 3, 4, 5, 6]);
    assert.ok(exported.every(event => event.interactionSessionId === 'interaction-a'));
    const conversation = new LlmTraceQueryService(store).exportSession('conversation:profile-a');
    assert.equal(conversation.trim().split('\n').length, 7);
    assert.throws(
      () => new LlmTraceQueryService(store, 20).exportSession('interaction-a'),
      (error: unknown) => error instanceof LlmTraceQueryError && error.code === 'export_too_large',
    );
  } finally {
    store.close();
  }
});

test('rejects malformed cursors and out-of-range limits', () => {
  const store = seededStore();
  try {
    const query = new LlmTraceQueryService(store);
    assert.throws(() => query.listSessions({ cursor: 'broken' }), LlmTraceQueryError);
    assert.throws(() => query.listEvents({ limit: 501 }), LlmTraceQueryError);
  } finally {
    store.close();
  }
});

test('keeps identical call/session ids isolated between Profile stores under interleaved writes', () => {
  const storeA = new LlmTraceEventStore({ filename: ':memory:', profileId: 'profile-a' });
  const storeB = new LlmTraceEventStore({ filename: ':memory:', profileId: 'profile-b' });
  try {
    for (let index = 0; index < 40; index += 1) {
      const store = index % 2 === 0 ? storeA : storeB;
      const profile = index % 2 === 0 ? 'A' : 'B';
      append(store, `${profile}-${index}`, 'tool.result', {
        interactionSessionId: 'shared-session', callId: 'shared-call',
        payload: { profile, index },
      });
    }
    const eventsA = new LlmTraceQueryService(storeA).listEvents({ sessionId: 'shared-session' }).events;
    const eventsB = new LlmTraceQueryService(storeB).listEvents({ sessionId: 'shared-session' }).events;
    assert.equal(eventsA.length, 20);
    assert.equal(eventsB.length, 20);
    assert.ok(eventsA.every(event => event.payload.profile === 'A'));
    assert.ok(eventsB.every(event => event.payload.profile === 'B'));
  } finally {
    storeA.close();
    storeB.close();
  }
});
