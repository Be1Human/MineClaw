import type { GoalAgentStepRole } from '../task/goalAgent/goalAgentState.js';

export interface GoalAgentSkillSearchInput {
  readonly query: string;
  readonly objective: GoalAgentStepRole;
  readonly goalSignature?: string;
  readonly activeStep?: string;
  readonly failureCode?: string;
  readonly limit: number;
}

export interface GoalAgentSkillGetInput {
  readonly ref: string;
  readonly expectedVersion?: string;
  readonly maxTokens?: number;
}

export interface GoalAgentSkillIndexEvidence {
  readonly ref: string;
  readonly name: string;
  readonly description: string;
  readonly triggers: readonly string[];
  readonly uses: readonly string[];
  readonly version: string;
  readonly score: number;
  readonly evidenceRef: string;
  readonly toolCompatibility?: {
    readonly state: 'compatible' | 'unsupported_tools';
    readonly missingTools: readonly string[];
  };
}

export interface GoalAgentSkillDocumentEvidence extends GoalAgentSkillIndexEvidence {
  readonly body: string;
  readonly contentHash: string;
  readonly estimatedTokens: number;
}

export type GoalAgentSkillLookupFailureReason = 'not_found' | 'stale' | 'corrupt' | 'budget_exceeded' | 'unsupported_tools';

export type GoalAgentSkillLookupResult =
  | { readonly ok: true; readonly skill: GoalAgentSkillDocumentEvidence }
  | {
      readonly ok: false;
      readonly reason: GoalAgentSkillLookupFailureReason;
      readonly ref: string;
      readonly expectedVersion?: string;
      readonly actualVersion?: string;
      readonly estimatedTokens?: number;
      readonly maxTokens?: number;
      readonly missingTools?: readonly string[];
    };

/** Read-only Skill projection. Implementations must be fixed to a Registry Generation. */
export interface GoalAgentSkillKnowledgePort {
  catalog?(input?: { readonly limit?: number }): Promise<GoalAgentSkillIndexEvidence[]> | GoalAgentSkillIndexEvidence[];
  search(input: GoalAgentSkillSearchInput): Promise<GoalAgentSkillIndexEvidence[]> | GoalAgentSkillIndexEvidence[];
  get(input: GoalAgentSkillGetInput): Promise<GoalAgentSkillLookupResult> | GoalAgentSkillLookupResult;
}
