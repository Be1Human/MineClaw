import type { Goal, GoalSuccessCriterion } from './goalTypes.js';

export const GOAL_CONTRACT_SCHEMA_V1 = 'mineclaw.goal/v1' as const;

export interface GoalConstraintV1 {
  type: 'natural_language' | 'safety' | 'resource' | 'deadline';
  value: string;
}

export interface GoalContractV1 {
  schema: typeof GOAL_CONTRACT_SCHEMA_V1;
  goalId: string;
  profileId: string;
  goalText: string;
  successCriteria: readonly GoalSuccessCriterion[];
  constraints?: readonly GoalConstraintV1[];
  contextRef?: string;
  createdAt: string;
}

export function goalContractV1(
  goal: Goal,
  options: {
    goalId: string;
    profileId: string;
    contextRef?: string;
    createdAt?: string;
  },
): GoalContractV1 {
  if (!options.goalId.trim()) throw new Error('goalId is required');
  if (!options.profileId.trim()) throw new Error('profileId is required');
  if (!goal.goalText.trim()) throw new Error('goalText is required');
  return Object.freeze({
    schema: GOAL_CONTRACT_SCHEMA_V1,
    goalId: options.goalId,
    profileId: options.profileId,
    goalText: goal.goalText.trim(),
    successCriteria: Object.freeze(structuredClone(goal.successCriteria ?? [])),
    ...(goal.constraints?.trim()
      ? { constraints: Object.freeze([{ type: 'natural_language' as const, value: goal.constraints.trim() }]) }
      : {}),
    ...(options.contextRef ? { contextRef: options.contextRef } : {}),
    createdAt: options.createdAt ?? new Date().toISOString(),
  });
}

export function legacyGoalFromContract(contract: GoalContractV1, context?: string): Goal {
  assertGoalContractV1(contract);
  const constraints = contract.constraints?.map(item => item.value).filter(Boolean).join('\n');
  return {
    goalText: contract.goalText,
    successCriteria: structuredClone([...contract.successCriteria]),
    ...(constraints ? { constraints } : {}),
    ...(context?.trim() ? { context: context.trim() } : {}),
  };
}

export function assertGoalContractV1(value: GoalContractV1): void {
  if (value.schema !== GOAL_CONTRACT_SCHEMA_V1) throw new Error(`unsupported goal schema: ${value.schema}`);
  if (!value.goalId?.trim() || !value.profileId?.trim() || !value.goalText?.trim()) {
    throw new Error('goal contract identity is incomplete');
  }
  if (!Array.isArray(value.successCriteria)) throw new Error('goal successCriteria must be an array');
  if (Number.isNaN(Date.parse(value.createdAt))) throw new Error('goal createdAt is invalid');
}
