import { createHash } from 'node:crypto';
import { jsonSnapshot } from '../../infra/jsonSnapshot.js';
import type { GoalConstraintV1 } from './goalContract.js';
import type { GoalSuccessCriterion } from './goalTypes.js';
import type { BoundGoalScope } from './goalDraft.js';
import type { ContributionRef, RegistrySnapshotRef } from '../../plugin-sdk/identity.js';
import type { AgentGoalOutcome, ParentGoalTargetKind } from '../planner/plannerContracts.js';

export const GOAL_CONTRACT_SCHEMA_V2 = 'mineclaw.goal/v2' as const;

export interface GoalContractV2 {
  readonly schema: typeof GOAL_CONTRACT_SCHEMA_V2;
  readonly goalId: string;
  readonly profileId: string;
  readonly goalText: string;
  readonly requestRef: string;
  readonly intent: {
    readonly outcome: AgentGoalOutcome;
    readonly target: {
      readonly kind: ParentGoalTargetKind;
      readonly surface: string;
      readonly registryId: string;
      readonly quantity: number;
    };
  };
  /** Complete immutable source identity used by every later resolution. */
  readonly source: {
    readonly snapshot: RegistrySnapshotRef;
    readonly contributions: readonly ContributionRef[];
  };
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
    && !['entity_dead', 'inventory', 'inventory_decrease', 'item_delivered', 'item_deposited', 'block_placed', 'reached'].includes(criterion.type)
    || criterion.type === 'predicate' && (!criterion.predicate || !criterion.predicateVersion || !criterion.args))) {
    throw new Error('invalid_goal_success_criteria');
  }
  if (!value.intent?.outcome || !value.intent.target?.kind || !value.intent.target.registryId?.trim()
    || !Number.isSafeInteger(value.intent.target.quantity) || value.intent.target.quantity < 1) throw new Error('invalid_goal_intent');
  const snapshot = value.source?.snapshot;
  if (!snapshot?.generationId || !snapshot.buildId || !snapshot.graphHash || !value.source.contributions.length) {
    throw new Error('invalid_goal_source');
  }
  const identities = new Set(value.source.contributions.map(ref => `${ref.pluginId}@${ref.pluginVersion}:${ref.contributionId}@${ref.contributionVersion}`));
  if (identities.size !== value.source.contributions.length || value.source.contributions.some(ref => !ref.pluginId || !ref.pluginVersion
    || !ref.contributionId || !ref.contributionVersion)) throw new Error('invalid_goal_contribution_source');
  if (!value.scope?.dimension || !value.scope.targetRefs.length || !value.scope.bindings.length) throw new Error('invalid_composed_goal_scope');
  if (value.scope.bindings.some(binding => !identities.has(`${binding.contribution.pluginId}@${binding.contribution.pluginVersion}:${binding.contribution.contributionId}@${binding.contribution.contributionVersion}`))) {
    throw new Error('goal_binding_source_not_fixed');
  }
  if (value.contentHash !== goalContractV2Hash(value)) throw new Error('composed_goal_content_changed');
}
