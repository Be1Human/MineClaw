import { freezeGoalContractV2 } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/contracts/goalContractV2.js';
import { GoalCompiler } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/goalAgent/goalCompiler.js';
import type { GoalAgentStateV1 } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/goalAgent/goalAgentState.js';
import type { GoalTargetDefinition } from '../../../../../../../apps/minecraft-companion/src/bot/v2/knowledge/goalTargetKnowledge.js';
import type { GoalSuccessCriterion } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/contracts/goalTypes.js';
import type { GoalPlanAuthorizationPort } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/goalAgent/ports/goalPlanPort.js';

export const TEST_SNAPSHOT = Object.freeze({ generationId: 'gen-test', buildId: 'build-test', graphHash: 'graph-test' });

export function testContribution(id = 'mineclaw.test.goal.target') {
  return { pluginId: 'mineclaw.test', pluginVersion: '1.0.0', contributionId: id, contributionVersion: '1.0.0' } as const;
}

export function testTarget(input: Omit<GoalTargetDefinition, 'contribution'>): GoalTargetDefinition {
  return { contribution: testContribution(`mineclaw.test.goal.${input.registryId.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`), ...input };
}

export function testGoalCompiler() {
  return new GoalCompiler({ predicates: () => [], bindings: () => [] });
}

export function formalizeState(state: GoalAgentStateV1, successCriteria: GoalSuccessCriterion[] = [{ type: 'inventory', item: 'stone_axe', count: 1 }]): GoalAgentStateV1 {
  state.snapshotRef = { ...TEST_SNAPSHOT };
  const contribution = testContribution();
  const createdAt = state.createdAt;
  const target = { kind: 'item' as const, surface: 'test target', registryId: 'minecraft:stone_axe', quantity: 1 };
  state.rootGoal = freezeGoalContractV2({
    schema: 'mineclaw.goal/v2', goalId: 'root', profileId: 'test', goalText: state.request.requestText,
    requestRef: state.requestId, intent: { outcome: 'obtain', target },
    source: { snapshot: state.snapshotRef, contributions: [contribution] },
    successCriteria,
    scope: {
      dimension: state.world.latest?.environment.dimension ?? 'overworld', targetRefs: ['target:test'],
      bindings: [{ contribution, id: 'target:test', version: '1.0.0', kind: 'item', summary: 'test target',
        dimension: state.world.latest?.environment.dimension ?? 'overworld', registryId: target.registryId,
        mutationAllowed: false, allowedAccess: ['observe', 'use'], required: true, requiredPredicates: [], evidenceRefs: ['test:binding'] }],
    },
    constraints: state.request.constraints.map(value => ({ type: 'natural_language' as const, value })), createdAt,
  });
  state.schema = 'mineclaw.goal-agent-state/v2';
  state.goal.definition = { requestId: state.requestId, objective: state.request.requestText, outcome: 'obtain', target, constraints: [...state.request.constraints], successCriteria: structuredClone(successCriteria) as unknown as Record<string, unknown>[] };
  state.goal.signature = { key: 'test', outcome: 'obtain', targetKind: 'item', targetId: target.registryId, quantity: 1, constraintsHash: 'test', compatibleTaskFamilies: ['crafting'], schemaVersion: 2 };
  return state;
}

export const permissiveTestPlans: GoalPlanAuthorizationPort = {
  inspect: () => { throw new Error('test_plan_inspect_not_configured'); },
  validatePlan: (_state, graph) => graph,
  authorize: () => undefined,
};
