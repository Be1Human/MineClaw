import assert from 'node:assert/strict';
import test from 'node:test';
import { GoalCompiler } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/goalAgent/goalCompiler.js';
import { GoalPlanAuthority } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/goalAgent/goalPlanAuthority.js';
import { createGoalAgentState } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/goalAgent/goalAgentState.js';
import type { GoalRequestV2 } from '../../../../../../../apps/minecraft-companion/src/bot/v2/decision/goalAgentPort/contracts.js';
import { TEST_SNAPSHOT, testContribution, testTarget } from './goalTestFixtures.js';

const target = testTarget({ kind: 'item', registryId: 'minecraft:stone_axe', aliases: ['石斧'], taskFamilies: ['crafting'],
  successCriteriaPolicy: 'fallback', successCriteria: [{ type: 'inventory', item: 'stone_axe', count: '$quantity' }] });
const operationRef = testContribution('mineclaw.test.execution.craft');

function request(): GoalRequestV2 {
  const now = new Date().toISOString();
  return { meta: { schemaVersion: 2, sessionId: 'i', messageId: 'm', correlationId: 'c', conversationId: 'v', sequence: 1, emittedAt: now, idempotencyKey: 'm' },
    origin: 'player_message', originalText: '做一把石斧', requestText: '做一把石斧', requestKind: 'task', constraints: [] };
}

function state() {
  const value = createGoalAgentState({ sessionId: 'goal', interactionSessionId: 'i', request: request(), snapshotRef: TEST_SNAPSHOT });
  value.world.latest = { tick: 1, timestamp: Date.now(), self: { position: { x: 0, y: 64, z: 0 }, yaw: 0, pitch: 0, health: 20, maxHealth: 20, food: 20, isOnGround: true }, owner: null,
    environment: { dimension: 'overworld', timeOfDay: 0, isDay: true, isRaining: false }, entities: [], inventory: { items: [], held: null, freeSlots: 36 }, taskContext: null };
  return value;
}

function authority() {
  return new GoalPlanAuthority({ resolve: (_state, ref) => {
    assert.deepEqual(ref, operationRef);
    return { contribution: operationRef, predicates: [], operation: {
      operationId: 'craft', goalContributionId: target.contribution.contributionId,
      bindingContributionId: target.contribution.contributionId, factKinds: ['inventory'],
      candidateContributionId: 'mineclaw.test.planning.craft', predicateContributionId: 'mineclaw.test.verification.craft',
      progressContributionId: 'mineclaw.test.progress.craft', resultContributionId: 'mineclaw.test.result.craft', cancellable: true,
      applicability: { outcomes: ['obtain'], targetKinds: ['item'], taskFamilies: ['crafting'], criterionTypes: ['inventory'] },
    } };
  } });
}

test('U08/S04: template input becomes the sole formal Goal and passes the same causal authority', async () => {
  const shared = state();
  const compiler = new GoalCompiler({ predicates: () => [], bindings: () => [] });
  const compiled = await compiler.compile({ input: { kind: 'template', target, arguments: {}, goal: {
    requestId: shared.requestId, objective: shared.request.requestText, outcome: 'obtain',
    target: { kind: 'item', surface: '石斧', registryId: 'minecraft:stone_axe', quantity: 1 }, constraints: [],
  } }, state: shared, profileId: 'test', goalId: 'goal', acceptedAt: shared.createdAt });
  shared.schema = 'mineclaw.goal-agent-state/v2'; shared.rootGoal = compiled.rootGoal;
  shared.goal.definition = compiled.goal; shared.goal.signature = compiled.signature;
  assert.equal(shared.rootGoal.schema, 'mineclaw.goal/v2');
  assert.deepEqual(shared.rootGoal.source.snapshot, TEST_SNAPSHOT);
  assert.deepEqual(shared.rootGoal.source.contributions, [target.contribution]);
  const bound = authority().inspect(shared, { contribution: operationRef, args: { item: 'stone_axe' } });
  assert.deepEqual(bound.satisfies, [{ type: 'inventory', item: 'stone_axe', count: 1 }]);
});

test('U35/P08: changed Generation and inequivalent operation applicability fail closed', async () => {
  const shared = state(), compiler = new GoalCompiler({ predicates: () => [], bindings: () => [] });
  const compiled = await compiler.compile({ input: { kind: 'template', target, arguments: {}, goal: {
    requestId: shared.requestId, objective: shared.request.requestText, outcome: 'obtain',
    target: { kind: 'item', surface: '石斧', registryId: 'minecraft:stone_axe', quantity: 1 }, constraints: [],
  } }, state: shared, profileId: 'test', goalId: 'goal', acceptedAt: shared.createdAt });
  shared.schema = 'mineclaw.goal-agent-state/v2'; shared.rootGoal = compiled.rootGoal;
  shared.goal.definition = compiled.goal; shared.goal.signature = compiled.signature;
  shared.snapshotRef = { ...TEST_SNAPSHOT, generationId: 'gen-latest' };
  assert.throws(() => authority().inspect(shared, { contribution: operationRef, args: {} }), /needs_rebind:goal_snapshot_changed/);
  shared.snapshotRef = { ...TEST_SNAPSHOT };
  const wrong = new GoalPlanAuthority({ resolve: () => ({ contribution: operationRef, predicates: [], operation: {
    operationId: 'combat', goalContributionId: 'mineclaw.test.goal.combat', bindingContributionId: 'mineclaw.test.goal.combat', factKinds: [],
    candidateContributionId: 'mineclaw.test.planning.combat', predicateContributionId: 'mineclaw.test.verification.combat', progressContributionId: 'mineclaw.test.progress.combat', resultContributionId: 'mineclaw.test.result.combat', cancellable: true,
    applicability: { outcomes: ['defeat'], targetKinds: ['entity'], taskFamilies: ['combat'], criterionTypes: ['entity_dead'] },
  } }) });
  assert.throws(() => wrong.inspect(shared, { contribution: operationRef, args: {} }), /operation_effect_unbound/);
});

test('U09: each node in a causal plan binds its own registered effect instead of being forced to claim the root effect', async () => {
  const shared = state(), compiler = new GoalCompiler({ predicates: () => [], bindings: () => [] });
  const compiled = await compiler.compile({ input: { kind: 'template', target, arguments: {}, goal: {
    requestId: shared.requestId, objective: shared.request.requestText, outcome: 'obtain',
    target: { kind: 'item', surface: '石斧', registryId: 'minecraft:stone_axe', quantity: 1 }, constraints: [],
  } }, state: shared, profileId: 'test', goalId: 'goal', acceptedAt: shared.createdAt });
  shared.schema = 'mineclaw.goal-agent-state/v2'; shared.rootGoal = compiled.rootGoal;
  shared.goal.definition = compiled.goal; shared.goal.signature = compiled.signature;
  const gatherRef = testContribution('mineclaw.test.execution.gather');
  const planAuthority = new GoalPlanAuthority({ resolve: (_state, ref) => ({ contribution: ref, predicates: [], operation: {
    operationId: ref.contributionId, goalContributionId: target.contribution.contributionId,
    bindingContributionId: target.contribution.contributionId, factKinds: ['inventory'],
    candidateContributionId: `${ref.contributionId}.candidate`, predicateContributionId: `${ref.contributionId}.predicate`,
    progressContributionId: `${ref.contributionId}.progress`, resultContributionId: `${ref.contributionId}.result`, cancellable: true,
    applicability: { outcomes: ['obtain'], targetKinds: ['item'], taskFamilies: ['crafting'],
      criterionTypes: ref.contributionId.endsWith('gather') ? ['inventory_decrease'] : ['inventory'] },
  } }) });
  const criterion1 = { type: 'inventory_decrease' as const, item: 'oak_log', from: 1 };
  const criterion2 = { type: 'inventory' as const, item: 'stone_axe', count: 1 };
  const graph = { id: 'plan', goalId: 'goal', nodes: [
    { id: 'gather', goal: { id: 'gather', goalText: 'consume log', successCriteria: ['consume'], metadata: { structuredSuccessCriteria: [criterion1] } },
      state: 'ready' as const, preconditions: [], postconditions: ['consume'], planRecoveryRefs: [], estimatedCost: { actions: 1, durationMs: 1, llmRounds: 0, risk: 0 }, provenance: ['test'] },
    { id: 'craft', goal: { id: 'craft', goalText: 'craft axe', successCriteria: ['axe'], metadata: { structuredSuccessCriteria: [criterion2] } },
      state: 'pending' as const, preconditions: ['gather'], postconditions: ['axe'], planRecoveryRefs: [], estimatedCost: { actions: 1, durationMs: 1, llmRounds: 0, risk: 0 }, provenance: ['test'] },
  ], edges: [{ from: 'gather', to: 'craft', type: 'requires' as const }], budget: { maxNodes: 2, maxGraphReplans: 1 }, provenance: ['test'] };
  const bound = planAuthority.validatePlan(shared, graph, [
    { id: 'gather', operation: { contribution: gatherRef, args: { item: 'oak_log' } }, satisfies: [criterion1] },
    { id: 'craft', operation: { contribution: operationRef, args: { item: 'stone_axe' } }, satisfies: [criterion2] },
  ]);
  assert.deepEqual(bound.nodes.map(node => node.causal?.satisfies), [[criterion1], [criterion2]]);
});
