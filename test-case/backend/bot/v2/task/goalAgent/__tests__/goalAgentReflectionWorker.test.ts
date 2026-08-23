import assert from 'node:assert/strict';
import test from 'node:test';
import type { GoalRequestV2 } from '../../../../../../../apps/minecraft-companion/src/bot/v2/decision/goalAgentPort/contracts.js';
import { GoalAgentReflectionWorker } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/goalAgent/goalAgentReflectionWorker.js';
import { InMemoryGoalAgentSessionEventLog } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/goalAgent/goalAgentSessionEventLog.js';
import { createGoalAgentState } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/goalAgent/goalAgentState.js';

function request(): GoalRequestV2 {
  return {
    meta: {
      schemaVersion: 2, sessionId: 'interaction-1', messageId: 'request-1', correlationId: 'corr-1',
      conversationId: 'conversation-1', sequence: 1, emittedAt: '2026-08-23T00:00:00.000Z', idempotencyKey: 'request-1',
    },
    origin: 'player_message', originalText: '拿石头过来', requestText: '拿石头过来',
    requestKind: 'task', constraints: [],
  };
}

function terminal(verified: boolean) {
  const state = createGoalAgentState({ sessionId: 'goal-1', interactionSessionId: 'interaction-1', request: request() });
  state.revision = 4;
  state.phase = 'completed';
  state.terminal = {
    outcome: 'completed', summary: 'stone delivered', completedAt: state.updatedAt,
    evidenceRefs: verified ? ['delivery:1'] : [],
  };
  state.verdict = verified ? {
    decision: 'complete', summary: 'stone delivered', machineCriteriaSatisfied: true,
    ownerActionable: false, retryable: false, evidenceRefs: ['delivery:1'],
  } : null;
  return state;
}

test('verified terminal reflects asynchronously into quarantine without mutating terminal state', async () => {
  const eventLog = new InMemoryGoalAgentSessionEventLog();
  const state = terminal(true);
  const before = structuredClone(state);
  const proposals: Array<Record<string, unknown>> = [];
  const worker = new GoalAgentReflectionWorker({
    eventLog,
    model: { async reflectTerminal() {
      return { callId: 'reflection-1', modelCallIndex: 5, summary: 'verify delivery after action', promptTokens: 10, completionTokens: 5 };
    } },
    experience: {
      freeze() { throw new Error('not used'); },
      commitProposal(proposal) { proposals.push(structuredClone(proposal)); return { proposalId: 'proposal-1' }; },
    },
  });
  await worker.consume(state);
  assert.deepEqual(state, before);
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].outcome, 'completed');
  assert.deepEqual(proposals[0].evidenceRefs, ['delivery:1']);
  assert.equal(eventLog.listSessionEvents(state.sessionId).at(-1)?.type, 'reflection.proposed');
  assert.deepEqual(eventLog.deriveMessages(state.sessionId), []);
});

test('unverified success is skipped before model and cannot enter success experience', async () => {
  const eventLog = new InMemoryGoalAgentSessionEventLog();
  let modelCalls = 0;
  let proposals = 0;
  const worker = new GoalAgentReflectionWorker({
    eventLog,
    model: { async reflectTerminal() { modelCalls += 1; throw new Error('must not run'); } },
    experience: {
      freeze() { throw new Error('not used'); },
      commitProposal() { proposals += 1; return { proposalId: 'bad' }; },
    },
  });
  await worker.consume(terminal(false));
  assert.equal(modelCalls, 0);
  assert.equal(proposals, 0);
  const skipped = eventLog.listSessionEvents('goal-1').at(-1);
  assert.equal(skipped?.type, 'reflection.skipped');
  assert.equal(skipped?.payload.reason, 'success_not_machine_verified');
});

test('query terminals never produce task experience', async () => {
  const eventLog = new InMemoryGoalAgentSessionEventLog();
  const state = terminal(true);
  state.request.requestKind = 'query';
  let modelCalls = 0;
  let proposals = 0;
  const worker = new GoalAgentReflectionWorker({
    eventLog,
    model: { async reflectTerminal() { modelCalls += 1; throw new Error('must not run'); } },
    experience: {
      freeze() { throw new Error('not used'); },
      commitProposal() { proposals += 1; return { proposalId: 'bad' }; },
    },
  });
  await worker.consume(state);
  assert.equal(modelCalls, 0);
  assert.equal(proposals, 0);
  assert.equal(eventLog.listSessionEvents(state.sessionId).at(-1)?.payload.reason, 'non_task_session');
});
