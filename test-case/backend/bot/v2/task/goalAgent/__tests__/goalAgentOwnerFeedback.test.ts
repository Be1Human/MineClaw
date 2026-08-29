import assert from 'node:assert/strict';
import test from 'node:test';

import { computeOwnerFeedback } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/goalAgent/goalAgentOwnerFeedback.js';
import { createGoalAgentState, type GoalAgentStateV1 } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/goalAgent/goalAgentState.js';
import { __setTuningOverride } from '../../../../../../../apps/minecraft-companion/src/bot/v2/infra/tuning.js';

function baseState(): GoalAgentStateV1 {
  const state = createGoalAgentState({
    sessionId: 'goal-feedback',
    interactionSessionId: 'interaction-feedback',
    request: {
      meta: {
        schemaVersion: 2,
        sessionId: 'interaction-feedback',
        messageId: 'request-feedback',
        correlationId: 'correlation-feedback',
        conversationId: 'conversation-feedback',
        sequence: 1,
        emittedAt: '2026-08-29T00:00:00.000Z',
        idempotencyKey: 'request-feedback',
      },
      origin: 'player_message',
      originalText: '做一个石斧',
      requestText: '制作1个石斧',
      requestKind: 'task',
      constraints: [],
    },
  });
  state.rootGoal = {
    schema: 'mineclaw.goal/v1',
    goalId: 'root-feedback',
    profileId: 'profile-feedback',
    goalText: '制作1个石斧',
    successCriteria: [{ type: 'item_delivered', item: 'stone_axe', count: 1, since: 1 }],
    createdAt: '2026-08-29T00:00:00.000Z',
  };
  state.budget = {
    llmCalls: 100,
    promptTokens: 0,
    completionTokens: 0,
    actions: 2,
    recoveries: 0,
    graphReplans: 0,
    maxLlmCalls: 120,
    maxTotalTokens: null,
    maxActions: 80,
    maxRecoveries: 3,
    maxGraphReplans: 3,
  };
  state.mode = 'planned_goal';
  return state;
}

function failedState(): GoalAgentStateV1 {
  const state = baseState();
  state.action = {
    proposal: {
      source: 'registered_behavior',
      action: 'invoke_behavior',
      rationale: 'gather',
      args: { behavior: 'gather_block', behaviorParams: { blockName: 'cobblestone', pos: { x: 0, y: 64, z: 0 } } },
    },
    result: {
      executionSessionId: 'exec-1',
      idempotencyKey: 'action-1',
      ok: false,
      detail: 'atomic.equip_unverified: equip_unverified: 手持为 spruce_log，期望 wooden_pickaxe',
      startedAt: '2026-08-29T00:00:00.000Z',
      completedAt: '2026-08-29T00:00:01.000Z',
      evidenceRefs: ['action:action-1:failed'],
      failure: {
        code: 'atomic.equip_unverified',
        origin: 'behavior',
        stage: 'executing',
        category: 'transient',
        retryable: true,
        ownerActionable: false,
        evidenceRefs: ['action:action-1:failed'],
        detail: 'equip_unverified: 手持为 spruce_log，期望 wooden_pickaxe',
      },
    },
    executionSessionId: 'exec-1',
    idempotencyKey: 'action-1',
  };
  return state;
}

test('empty search streak reaching tuning threshold emits blocked feedback once', () => {
  const state = failedState();
  const feedback = computeOwnerFeedback({
    state,
    emptySearchStreak: 3,
    lastCandidateCount: 2,
    alreadySentKinds: new Set(),
  });
  assert.ok(feedback);
  assert.equal(feedback.kind, 'blocked');
  assert.match(feedback.summary, /3 次/);
  assert.ok(!feedback.ownerActionable);
  // 已发过 blocked（并把预算告警也隔离掉）→ 不再重复
  assert.equal(computeOwnerFeedback({
    state,
    emptySearchStreak: 5,
    lastCandidateCount: 2,
    alreadySentKinds: new Set(['blocked', 'budget_warning']),
  }), null);
});

test('streak below threshold stays silent', () => {
  const state = failedState();
  state.budget.llmCalls = 50; // 隔离预算告警
  assert.equal(computeOwnerFeedback({
    state,
    emptySearchStreak: 2,
    lastCandidateCount: 2,
    alreadySentKinds: new Set(),
  }), null);
});

test('budget at 80% of maxLlmCalls emits budget warning once', () => {
  const state = baseState();
  const feedback = computeOwnerFeedback({
    state,
    emptySearchStreak: 0,
    lastCandidateCount: null,
    alreadySentKinds: new Set(),
  });
  assert.ok(feedback);
  assert.equal(feedback.kind, 'budget_warning');
  assert.match(feedback.summary, /100\/120/);
  assert.equal(computeOwnerFeedback({
    state,
    emptySearchStreak: 0,
    lastCandidateCount: null,
    alreadySentKinds: new Set(['budget_warning']),
  }), null);
});

test('budget below threshold stays silent', () => {
  const state = baseState();
  state.budget.llmCalls = 50;
  assert.equal(computeOwnerFeedback({
    state,
    emptySearchStreak: 0,
    lastCandidateCount: null,
    alreadySentKinds: new Set(),
  }), null);
});

test('equip_unverified with zero available candidates emits help_needed with ownerActionable', () => {
  const feedback = computeOwnerFeedback({
    state: failedState(),
    emptySearchStreak: 0,
    lastCandidateCount: 0,
    alreadySentKinds: new Set(),
  });
  assert.ok(feedback);
  assert.equal(feedback.kind, 'help_needed');
  assert.match(feedback.summary, /wooden_pickaxe|木镐|工具/);
  assert.equal(feedback.ownerActionable, true);
});

test('equip_unverified with candidates still available does not ask for help yet', () => {
  const state = failedState();
  state.budget.llmCalls = 50; // 隔离预算告警
  assert.equal(computeOwnerFeedback({
    state,
    emptySearchStreak: 0,
    lastCandidateCount: 3,
    alreadySentKinds: new Set(),
  }), null);
});

test('tuning override changes the streak threshold', () => {
  __setTuningOverride({ goalAgent: { feedbackEmptySearchStreak: 2, feedbackBudgetRatio: 0.9 } });
  try {
    assert.equal(computeOwnerFeedback({
      state: failedState(),
      emptySearchStreak: 2,
      lastCandidateCount: 5,
      alreadySentKinds: new Set(),
    })?.kind, 'blocked');
    const state = baseState();
    state.budget.llmCalls = 107; // 107/120 = 0.89 < 0.9（override）但 > 0.8（默认）→ 证明热覆盖生效
    assert.equal(computeOwnerFeedback({
      state,
      emptySearchStreak: 0,
      lastCandidateCount: null,
      alreadySentKinds: new Set(),
    }), null);
  } finally {
    __setTuningOverride(null);
  }
});
