import type { ColdStartPlannerPort, PlannedStep } from '../planner/planGraphBuilder.js';
import type { GoalContract } from '../planner/plannerContracts.js';
import type { GoalAgentStateV1 } from './goalAgentState.js';
import { stableJson } from './goalAgentJson.js';

/**
 * Machine-derived planning evidence. It constrains the LLM plan without
 * replacing the Planner cognitive node or mutating the PlanGraph itself.
 */
export function requiredPlanMilestones(
  state: Readonly<GoalAgentStateV1>,
  planner?: ColdStartPlannerPort,
): PlannedStep[] {
  const root = state.rootGoal;
  const signature = state.goal.signature;
  const context = state.goal.context;
  if (!planner || !root || !signature || !context) return [];

  const goal: GoalContract = {
    id: root.goalId,
    goalText: root.goalText,
    successCriteria: [...root.successCriteria].map(stableJson),
    taskFamily: signature.compatibleTaskFamilies[0] ?? 'general',
    metadata: {
      targetId: signature.targetId,
      structuredSuccessCriteria: structuredClone([...root.successCriteria]),
    },
  };
  return (planner.plan(goal, context) ?? []).flatMap(step => {
    const criteria = step.structuredSuccessCriteria ?? [];
    return criteria.length > 0
      ? [{ ...step, structuredSuccessCriteria: structuredClone(criteria) }]
      : [];
  });
}

export function requiredMilestoneCoverageIssues(
  plannedCriteria: readonly unknown[],
  milestones: readonly PlannedStep[],
): string[] {
  const planned = new Set(plannedCriteria.map(stableJson));
  return milestones.flatMap(milestone => (milestone.structuredSuccessCriteria ?? []).flatMap(criterion => {
    const encoded = stableJson(criterion);
    return planned.has(encoded) ? [] : [`required_milestone_not_covered:${milestone.stage}:${encoded}`];
  }));
}
