import type { GoalAgentStateV1 } from '../goalAgentState.js';
import type { GoalContractV2 } from '../../contracts/goalContractV2.js';
import type { GoalScopeBinding } from '../../contracts/goalDraft.js';
import type { CommittedAgentGoal, GoalSignature } from '../../planner/plannerContracts.js';

export interface GoalDraftCompilationPort {
  bindings(state: Readonly<GoalAgentStateV1>): readonly GoalScopeBinding[];
  compile(input: {
    draft: unknown;
    state: Readonly<GoalAgentStateV1>;
    profileId: string;
    goalId: string;
    acceptedAt: string;
  }): { rootGoal: GoalContractV2; goal: CommittedAgentGoal; signature: GoalSignature };
}
