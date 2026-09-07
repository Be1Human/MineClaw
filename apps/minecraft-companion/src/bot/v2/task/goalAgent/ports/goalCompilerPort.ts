import type { GoalAgentStateV1 } from '../goalAgentState.js';
import type { GoalContractV2 } from '../../contracts/goalContractV2.js';
import type { GoalScopeBinding } from '../../contracts/goalDraft.js';
import type { CommittedAgentGoal, GoalSignature } from '../../planner/plannerContracts.js';
import type { GoalTargetDefinition } from '../../../knowledge/goalTargetKnowledge.js';

export type GoalCompilerInput =
  | { readonly kind: 'draft'; readonly draft: unknown }
  | {
      readonly kind: 'template';
      readonly goal: Omit<CommittedAgentGoal, 'successCriteria'>;
      readonly target: GoalTargetDefinition;
      readonly arguments: Readonly<Record<string, unknown>>;
    };

/** Sole formal-Goal compiler boundary for both declarative drafts and registered templates. */
export interface GoalCompilationPort {
  bindings(state: Readonly<GoalAgentStateV1>): Promise<readonly GoalScopeBinding[]> | readonly GoalScopeBinding[];
  compile(input: {
    input: GoalCompilerInput;
    state: Readonly<GoalAgentStateV1>;
    profileId: string;
    goalId: string;
    acceptedAt: string;
  }): Promise<{ rootGoal: GoalContractV2; goal: CommittedAgentGoal; signature: GoalSignature }>
    | { rootGoal: GoalContractV2; goal: CommittedAgentGoal; signature: GoalSignature };
}
