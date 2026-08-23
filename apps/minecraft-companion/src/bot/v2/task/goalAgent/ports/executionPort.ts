import type { ActionProposal } from '../../../atomic/contracts/atomicContractRegistry.js';
import type { GoalAgentActionResult, GoalAgentStateV1 } from '../goalAgentState.js';

export interface GoalAgentActionCandidate {
  id: string;
  kind: 'strategy' | 'behavior' | 'task' | 'atomic';
  source: ActionProposal['source'];
  action: string;
  description: string;
  fixedArgs: Record<string, unknown>;
  argumentSchema?: Record<string, unknown>;
  evidenceRefs: string[];
}

export interface GoalAgentExecutionPort {
  listCandidates(input: {
    state: Readonly<GoalAgentStateV1>;
    /** Omit for a simple task executed directly against the root goal. */
    planNodeId?: string;
    signal: AbortSignal;
  }): Promise<GoalAgentActionCandidate[]> | GoalAgentActionCandidate[];
  isOwnerNeedActionable?(input: {
    question: string;
    missingInformation: string;
    state: Readonly<GoalAgentStateV1>;
  }): Promise<boolean> | boolean;
  execute(input: {
    sessionId: string;
    epoch: number;
    idempotencyKey: string;
    proposal: ActionProposal;
    state: Readonly<GoalAgentStateV1>;
    signal: AbortSignal;
  }): Promise<GoalAgentActionResult>;
}
