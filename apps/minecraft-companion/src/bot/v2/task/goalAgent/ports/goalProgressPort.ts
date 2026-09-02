import type { GoalAgentStateV1 } from '../goalAgentState.js';

/** Domain code, not a model claim, decides whether a missing condition can be waited for. */
export type GoalProgressGuidance =
  | { kind: 'needs_owner'; reason: string; question: string; evidenceRefs: string[] }
  | { kind: 'unsupported'; reason: string; evidenceRefs: string[] }
  | { kind: 'wait'; key: string; reason: string; observedAt: number; evidenceRefs: string[] };

export interface GoalProgressPolicyPort {
  assess(state: Readonly<GoalAgentStateV1>): GoalProgressGuidance | null;
  /** Only semantically relevant facts; never clocks, IDs of receipts or plan revisions. */
  project(state: Readonly<GoalAgentStateV1>): unknown;
}

export interface CapabilityProgressProvider {
  id: string;
  assess(state: Readonly<GoalAgentStateV1>): GoalProgressGuidance | null;
  project(state: Readonly<GoalAgentStateV1>): unknown;
}
