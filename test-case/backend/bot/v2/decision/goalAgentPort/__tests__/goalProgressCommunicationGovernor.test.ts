import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { GoalProgressUpdateKindV2, GoalReportV2 } from '../../../../../../../apps/minecraft-companion/src/bot/v2/decision/goalAgentPort/contracts.js';
import { GoalProgressCommunicationGovernor } from '../../../../../../../apps/minecraft-companion/src/bot/v2/decision/goalAgentPort/goalProgressCommunicationGovernor.js';

function report(requestId: string, kind: GoalProgressUpdateKindV2, key: string): GoalReportV2 {
  return {
    meta: {
      schemaVersion: 2, sessionId: `session-${requestId}`, messageId: `message-${key}`,
      correlationId: `correlation-${requestId}`, conversationId: 'conversation-1', sequence: 1,
      emittedAt: '2026-08-23T00:00:00.000Z', idempotencyKey: `idempotency-${key}`,
    },
    requestId, status: 'running', summary: `${kind}:${key}`, evidence: [],
    update: {
      kind, importance: 'medium', episodeKey: `${requestId}:episode`, dedupeKey: key,
      ownerActionable: false,
    },
  };
}

describe('FEAT-CROSS-18 · GoalProgressCommunicationGovernor', () => {
  it('quiet 抑制全部非终态语义，balanced 只允许障碍和决策', () => {
    const quiet = new GoalProgressCommunicationGovernor({ level: 'quiet' });
    for (const kind of ['milestone', 'obstacle', 'decision', 'recovery', 'resolved'] as const) {
      assert.equal(quiet.evaluate(report('quiet', kind, kind)).reason, 'level_filtered');
    }

    let now = 0;
    const balanced = new GoalProgressCommunicationGovernor({ level: 'balanced', now: () => now });
    assert.equal(balanced.evaluate(report('milestone', 'milestone', 'm1')).reason, 'level_filtered');
    assert.equal(balanced.evaluate(report('obstacle', 'obstacle', 'o1')).allowed, true);
    assert.equal(balanced.evaluate(report('decision', 'decision', 'd1')).allowed, true);
    assert.equal(balanced.evaluate(report('recovery', 'recovery', 'r1')).reason, 'level_filtered');
    now += 1;
  });

  it('talkative 接受全部语义类型', () => {
    let now = 0;
    const governor = new GoalProgressCommunicationGovernor({ level: 'talkative', now: () => now });
    for (const kind of ['milestone', 'obstacle', 'decision', 'recovery', 'resolved'] as const) {
      assert.equal(governor.evaluate(report(`request-${kind}`, kind, kind)).allowed, true);
      now += 12_000;
    }
  });

  it('按 dedupeKey、冷却、单任务预算和小时预算确定性限流', () => {
    let now = 0;
    const governor = new GoalProgressCommunicationGovernor({ level: 'balanced', now: () => now });
    assert.equal(governor.evaluate(report('task-1', 'obstacle', 'a')).reason, 'allowed');
    assert.equal(governor.evaluate(report('task-1', 'obstacle', 'a')).reason, 'duplicate');
    assert.equal(governor.evaluate(report('task-1', 'decision', 'b')).reason, 'cooldown');
    now += 45_000;
    assert.equal(governor.evaluate(report('task-1', 'decision', 'c')).reason, 'allowed');
    now += 45_000;
    assert.equal(governor.evaluate(report('task-1', 'obstacle', 'd')).reason, 'allowed');
    now += 45_000;
    assert.equal(governor.evaluate(report('task-1', 'decision', 'e')).reason, 'task_budget');

    for (let index = 0; index < 9; index += 1) {
      assert.equal(governor.evaluate(report(`hour-${index}`, 'obstacle', `h${index}`)).reason, 'allowed');
    }
    assert.equal(governor.evaluate(report('hour-over', 'obstacle', 'over')).reason, 'hour_budget');
  });
});
