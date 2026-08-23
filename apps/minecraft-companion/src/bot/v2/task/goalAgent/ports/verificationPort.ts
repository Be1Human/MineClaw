import type { GoalAgentStateV1 } from '../goalAgentState.js';

export interface GoalAgentVerificationResult {
  ok: boolean;
  detail: string;
  evidenceRefs: string[];
}

export interface GoalAgentVerificationPort {
  verifyTask(input: {
    state: Readonly<GoalAgentStateV1>;
    planNodeId: string;
  }): Promise<GoalAgentVerificationResult> | GoalAgentVerificationResult;
  verifyRoot(input: {
    state: Readonly<GoalAgentStateV1>;
  }): Promise<GoalAgentVerificationResult> | GoalAgentVerificationResult;
}
