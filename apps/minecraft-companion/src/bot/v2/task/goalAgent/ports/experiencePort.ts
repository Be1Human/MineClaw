import type { ContextSignature, GoalSignature } from '../../planner/plannerContracts.js';
import type { PlannerExperienceFreezeResult } from '../../planner/experience/plannerExperienceProvider.js';

export interface GoalAgentExperienceFreezeRequest {
  planRunId: string;
  goalText: string;
  goalSignature: GoalSignature;
  context: ContextSignature;
}

export interface GoalAgentExperienceProposal {
  idempotencyKey: string;
  sessionId: string;
  goalSignature: string;
  outcome: 'completed' | 'failed';
  summary: string;
  evidenceRefs: string[];
  timelineDigest: string;
}

export interface GoalAgentExperiencePort {
  freeze(request: GoalAgentExperienceFreezeRequest): Promise<PlannerExperienceFreezeResult> | PlannerExperienceFreezeResult;
  commitProposal?(proposal: GoalAgentExperienceProposal): Promise<{ proposalId: string }> | { proposalId: string };
}
