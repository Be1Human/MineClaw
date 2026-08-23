import assert from 'node:assert/strict';
import test from 'node:test';
import type { GoalRequestV2 } from '../../../../../../../apps/minecraft-companion/src/bot/v2/decision/goalAgentPort/contracts.js';
import {
  assertGoalAgentStateV1,
  cloneGoalAgentState,
  createGoalAgentState,
  migrateGoalAgentStateV1,
} from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/goalAgent/goalAgentState.js';

function request(): GoalRequestV2 {
  return {
    meta: {
      schemaVersion: 2,
      sessionId: 'interaction-1',
      messageId: 'request-1',
      correlationId: 'correlation-1',
      conversationId: 'conversation-1',
      sequence: 1,
      emittedAt: '2026-08-20T00:00:00.000Z',
      idempotencyKey: 'request-1',
    },
    origin: 'player_message',
    originalText: 'make a pickaxe',
    requestText: 'make a pickaxe',
    requestKind: 'task',
    constraints: [],
  };
}

test('creates one complete shared state for a root request', () => {
  const state = createGoalAgentState({
    sessionId: 'goal-1',
    interactionSessionId: 'interaction-1',
    request: request(),
    now: '2026-08-20T00:00:00.000Z',
  });
  assert.equal(state.revision, 0);
  assert.equal(state.mode, 'planned_goal');
  assert.equal(state.epoch, 1);
  assert.equal(state.phase, 'ingress');
  assert.equal(state.activeNode, 'ingress');
  assert.deepEqual(state.interpretation, {
    candidates: [], evidenceRefs: [], attempts: 0,
    lastValidationError: null, clarificationReason: null,
  });
  assert.deepEqual(state.goal, { definition: null, signature: null, context: null });
  assert.deepEqual(state.context, { timeline: [] });
  assert.equal(state.plan.graph, null);
  assert.equal(state.action.proposal, null);
  assert.equal(state.terminal, null);
  assertGoalAgentStateV1(state);
});

test('clone isolates the persisted snapshot from caller mutation', () => {
  const state = createGoalAgentState({
    sessionId: 'goal-1', interactionSessionId: 'interaction-1', request: request(),
  });
  const cloned = cloneGoalAgentState(state);
  cloned.context.timeline.push({
    sequence: 1, node: 'round', phase: 'running', kind: 'transition', summary: 'changed',
    stateRevision: 0, occurredAt: cloned.updatedAt, evidenceRefs: [],
  });
  cloned.request.constraints.push('new constraint');
  assert.deepEqual(state.context.timeline, []);
  assert.deepEqual(state.request.constraints, []);
});

test('BUG-CROSS-73 · migrates missing mode and preserves persistent monitor mode', () => {
  const legacy = createGoalAgentState({
    sessionId: 'goal-mode-legacy', interactionSessionId: 'interaction-1', request: request(),
  }) as ReturnType<typeof createGoalAgentState> & { mode?: ReturnType<typeof createGoalAgentState>['mode'] };
  delete legacy.mode;
  assert.equal(migrateGoalAgentStateV1(legacy as ReturnType<typeof createGoalAgentState>).mode, 'planned_goal');

  const persistent = createGoalAgentState({
    sessionId: 'goal-monitor', interactionSessionId: 'interaction-1', request: request(),
    mode: 'persistent_monitor',
  });
  assert.equal(persistent.mode, 'persistent_monitor');
  assertGoalAgentStateV1(persistent);
});

test('rejects terminal phase without a terminal payload', () => {
  const state = createGoalAgentState({
    sessionId: 'goal-1', interactionSessionId: 'interaction-1', request: request(),
  });
  state.phase = 'completed';
  assert.throws(() => assertGoalAgentStateV1(state), /terminal payload and phase must agree/);
});

test('rejects non-contiguous shared timeline', () => {
  const state = createGoalAgentState({
    sessionId: 'goal-1', interactionSessionId: 'interaction-1', request: request(),
  });
  state.context.timeline.push({
    sequence: 2,
    node: 'round',
    phase: 'running',
    kind: 'model_call',
    summary: 'planned',
    stateRevision: 0,
    occurredAt: new Date().toISOString(),
    evidenceRefs: [],
  });
  assert.throws(() => assertGoalAgentStateV1(state), /sequence must be contiguous/);
});
