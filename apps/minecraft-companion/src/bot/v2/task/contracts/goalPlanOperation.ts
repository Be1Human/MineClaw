import type { PredicateRef } from './goalDraft.js';

export interface GoalOperationRequest {
  id: string;
  version: number;
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
  requires: PredicateRef[];
  satisfies: PredicateRef[];
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
  requires?: PredicateRef[];
  satisfies?: PredicateRef[];
}
