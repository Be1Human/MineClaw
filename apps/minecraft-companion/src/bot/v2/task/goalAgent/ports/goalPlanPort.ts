import type { BoundGoalPlanOperation, GoalOperationRequest, GoalOperationResolution, GoalPlanNodeProposal } from '../../contracts/goalPlanOperation.js';
import type { PlanGraph } from '../../planner/plannerContracts.js';
import type { GoalAgentStateV1 } from '../goalAgentState.js';
import type { GoalAgentActionCandidate } from './executionPort.js';

export interface GoalPlanAuthorizationPort {
  inspect(state: Readonly<GoalAgentStateV1>, operation: GoalOperationRequest): BoundGoalPlanOperation;
  validatePlan(state: Readonly<GoalAgentStateV1>, graph: PlanGraph, proposals: readonly GoalPlanNodeProposal[]): PlanGraph;
  authorize(state: Readonly<GoalAgentStateV1>, candidate: GoalAgentActionCandidate, args: Record<string, unknown>): void;
}


/** Code-owned read-only operation resolver; metadata cannot supply an implementation. */
export interface CapabilityOperationSemantics {
  operationId: string;
  version: string;
  resolve(input: { args: Readonly<Record<string, unknown>>; state: Readonly<GoalAgentStateV1> }): GoalOperationResolution;
}
