import assert from 'node:assert/strict';
import test from 'node:test';

import type { GoalRequestV2 } from '../../../../../../../apps/minecraft-companion/src/bot/v2/decision/goalAgentPort/contracts.js';
import { createGoalAgentState } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/goalAgent/goalAgentState.js';
import { GoalAgentRoundToolRuntime } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/goalAgent/goalAgentRoundTools.js';
import { defaultGoalKnowledge } from '../../../../../../../apps/minecraft-companion/src/bot/v2/knowledge/goalTargetKnowledge.js';

function requestWith(text: string): GoalRequestV2 {
  return {
    meta: {
      schemaVersion: 2,
      sessionId: 'interaction-outcome',
      messageId: 'request-outcome',
      correlationId: 'correlation-outcome',
      conversationId: 'conversation-outcome',
      sequence: 1,
      emittedAt: '2026-08-29T00:00:00.000Z',
      idempotencyKey: 'request-outcome',
    },
    origin: 'player_message',
    originalText: text,
    requestText: text,
    requestKind: 'task',
    constraints: [],
  };
}

function makeState(text: string) {
  return createGoalAgentState({
    sessionId: 'goal-outcome', interactionSessionId: 'interaction-outcome', request: requestWith(text),
  });
}

async function createAxeGoal(runtime: GoalAgentRoundToolRuntime, state: ReturnType<typeof makeState>, outcome: string) {
  const signal = new AbortController().signal;
  await runtime.execute({ id: 'search', name: 'goal_search_targets', arguments: { query: '石斧', kind: 'item' } }, state, signal);
  return runtime.execute({ id: 'goal', name: 'goal_create', arguments: {
    outcome, target: { registryId: 'minecraft:stone_axe', quantity: 1 },
  } }, state, signal);
}

test('BUG-CROSS-80 · "给我一把斧头" with outcome=obtain is rejected (delivery semantics fail closed)', async () => {
  const runtime = new GoalAgentRoundToolRuntime({ profileId: 'outcome-test', tools: { knowledge: defaultGoalKnowledge } });
  const state = makeState('给我一把斧头');
  const receipt = await createAxeGoal(runtime, state, 'obtain');
  assert.equal(receipt.content.ok, false);
  assert.match(String(receipt.content.detail ?? receipt.summary), /goal_create_outcome_mismatch/);
  assert.equal(state.rootGoal, null, '不得创建背包持有判据的根目标');
});

test('BUG-CROSS-80 · "给我一把斧头" with outcome=deliver creates item_delivered root goal', async () => {
  const runtime = new GoalAgentRoundToolRuntime({ profileId: 'outcome-test', tools: { knowledge: defaultGoalKnowledge } });
  const state = makeState('给我一把斧头');
  const receipt = await createAxeGoal(runtime, state, 'deliver');
  assert.equal(receipt.content.ok, true);
  assert.deepEqual(state.rootGoal?.successCriteria, [{ type: 'item_delivered', item: 'stone_axe', count: 1, since: receipt.content.goalId ? 0 : 0 }].map(c => ({ ...c, since: (state.rootGoal!.successCriteria[0] as { since: number }).since })));
  assert.equal(state.goal.definition?.outcome, 'deliver');
});

test('BUG-CROSS-80 · "做一把石斧" without handover wording may use outcome=obtain', async () => {
  const runtime = new GoalAgentRoundToolRuntime({ profileId: 'outcome-test', tools: { knowledge: defaultGoalKnowledge } });
  const state = makeState('做一把石斧');
  const receipt = await createAxeGoal(runtime, state, 'obtain');
  assert.equal(receipt.content.ok, true);
  assert.equal(state.goal.definition?.outcome, 'obtain');
  assert.deepEqual(state.rootGoal?.successCriteria[0]?.type, 'inventory');
});
