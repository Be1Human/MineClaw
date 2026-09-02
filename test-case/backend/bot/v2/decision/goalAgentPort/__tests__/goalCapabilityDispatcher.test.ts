import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { GoalRequestV2, GoalStatusProbeV2 } from '../../../../../../../apps/minecraft-companion/src/bot/v2/decision/goalAgentPort/contracts.js';
import { GoalCapabilityDispatcher } from '../../../../../../../apps/minecraft-companion/src/bot/v2/decision/goalAgentPort/goalCapabilityDispatcher.js';

function request(text: string, kind: GoalRequestV2['requestKind'] = 'task'): GoalRequestV2 {
  return {
    meta: {
      schemaVersion: 2, sessionId: `session-${text}`, messageId: `request-${text}`,
      correlationId: `correlation-${text}`, conversationId: 'conversation', sequence: 1,
      emittedAt: '2026-08-22T00:00:00.000Z', idempotencyKey: `request-${text}`,
    },
    origin: 'player_message', originalText: text, requestText: text, requestKind: kind, constraints: [],
  };
}

function probe(value: GoalRequestV2): GoalStatusProbeV2 {
  return { meta: value.meta, sessionId: value.meta.sessionId, requestId: value.meta.messageId, reason: 'user_requested' };
}

describe('GoalCapabilityDispatcher', () => {
  it('dispatches follow aliases to the registered persistent handler instead of planned goal', () => {
    const dispatcher = new GoalCapabilityDispatcher();
    const calls: string[] = [];
    dispatcher.register('task_runtime.follow_owner', {
      submit: () => { calls.push('follow'); return { accepted: true, details: { runtimeRef: 'task-follow' } }; },
      inspect: value => ({
        sessionId: value.sessionId, requestId: value.requestId, state: 'executing', stage: 'follow_owner',
        runtimeRef: 'task-follow', evidence: [], observedAt: '2026-08-22T00:00:01.000Z',
      }),
    });
    dispatcher.register('production_planner_gateway', {
      submit: () => { calls.push('planned'); return { accepted: true }; },
    });
    const follow = request('跟着我走');
    const result = dispatcher.submit(follow);
    assert.equal(result.accepted, true);
    assert.equal(result.details?.capabilityId, 'follow_owner');
    assert.deepEqual(calls, ['follow']);
    assert.equal(dispatcher.inspect(probe(follow)).state, 'executing');
    assert.equal(dispatcher.findByRuntimeRef('task-follow')?.request.meta.messageId, follow.meta.messageId);
    assert.equal(dispatcher.findByRequestId(follow.meta.messageId)?.runtimeRef, 'task-follow');
  });

  it('delegates planned and cancel requests to their registered handlers', () => {
    const dispatcher = new GoalCapabilityDispatcher();
    const calls: string[] = [];
    for (const id of ['production_planner_gateway', 'goal_agent.cancel']) {
      dispatcher.register(id, { submit: () => { calls.push(id); return { accepted: true }; } });
    }
    dispatcher.submit(request('制作木板'));
    dispatcher.submit(request('停下', 'cancel'));
    assert.deepEqual(calls, ['production_planner_gateway', 'goal_agent.cancel']);
  });

  it('fails closed when a matched capability handler is not registered', () => {
    const result = new GoalCapabilityDispatcher().submit(request('跟我来'));
    assert.equal(result.accepted, false);
    assert.equal(result.reason, 'goal_capability_handler_missing:task_runtime.follow_owner');
  });
});
