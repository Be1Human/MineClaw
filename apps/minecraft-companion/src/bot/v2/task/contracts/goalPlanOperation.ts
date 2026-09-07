import type { ContributionRef } from '../../plugin-sdk/identity.js';
import type { GoalSuccessCriterion } from './goalTypes.js';

/** Baseline-free, serializable criterion identity used in causal edges. */
export type GoalCriterionRef = Omit<GoalSuccessCriterion, 'since'>;

export interface GoalOperationRequest {
  contribution: ContributionRef;
  args: Record<string, unknown>;
}

export interface GoalOperationAccess {
  targetRef: string;
  mode: 'observe' | 'use' | 'modify';
  /** Exact effect location, not a navigation waypoint. */
  position?: { x: number; y: number; z: number };
}

/** Serializable resolution data, independent of the service that produced it. */
export interface GoalOperationResolution {
  requires: GoalCriterionRef[];
  satisfies: GoalCriterionRef[];
  accesses: GoalOperationAccess[];
  estimatedActions: number;
}

export interface BoundGoalPlanOperation extends GoalOperationResolution {
  operation: GoalOperationRequest;
  semanticsVersion: string;
  contentHash: string;
}

export interface GoalPlanNodeProposal {
  id: string;
  operation?: GoalOperationRequest;
  requires?: GoalCriterionRef[];
  satisfies?: GoalCriterionRef[];
}
