import { createHash } from 'node:crypto';
import { jsonSnapshot } from '../../infra/jsonSnapshot.js';
import type { GoalConstraintV1 } from './goalContract.js';
import type { GoalSuccessCriterion } from './goalTypes.js';
import type { BoundGoalScope } from './goalDraft.js';

export const GOAL_CONTRACT_SCHEMA_V2 = 'mineclaw.goal/v2' as const;

export interface GoalContractV2 {
  readonly schema: typeof GOAL_CONTRACT_SCHEMA_V2;
  readonly goalId: string;
  readonly profileId: string;
  readonly goalText: string;
  readonly requestRef: string;
  readonly successCriteria: readonly GoalSuccessCriterion[];
  readonly scope: BoundGoalScope;
  readonly constraints?: readonly GoalConstraintV1[];
  readonly contextRef?: string;
  readonly createdAt: string;
  readonly contentHash: string;
}

/** The hash covers the complete semantic contract, including target bindings and versions. */
export function goalContractV2Hash(value: Omit<GoalContractV2, 'contentHash'> | GoalContractV2): string {
  const { contentHash: _ignored, ...content } = value as GoalContractV2;
  return createHash('sha256').update(JSON.stringify(jsonSnapshot(content))).digest('hex');
}

export function freezeGoalContractV2(value: Omit<GoalContractV2, 'contentHash'>): GoalContractV2 {
  const result = jsonSnapshot({ ...value, contentHash: goalContractV2Hash(value) });
  assertGoalContractV2(result);
  return result;
}

export function assertGoalContractV2(value: GoalContractV2): void {
  if (value.schema !== GOAL_CONTRACT_SCHEMA_V2 || !value.goalId?.trim() || !value.profileId?.trim()
    || !value.goalText?.trim() || !value.requestRef?.trim() || !Number.isFinite(Date.parse(value.createdAt))) {
    throw new Error('invalid_composed_goal_identity');
  }
  if (!value.successCriteria.length || value.successCriteria.some(criterion => criterion.type !== 'predicate'
    || !criterion.predicate || !criterion.predicateVersion || !criterion.args)) throw new Error('invalid_composed_goal_predicates');
  if (!value.scope?.dimension || !value.scope.targetRefs.length || !value.scope.bindings.length) throw new Error('invalid_composed_goal_scope');
  if (value.contentHash !== goalContractV2Hash(value)) throw new Error('composed_goal_content_changed');
}
