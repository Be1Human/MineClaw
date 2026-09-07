import type { ContributionRef, RegistrySnapshotRef } from '../../../plugin-sdk/identity.js';
import type { GoalAgentStateV1 } from '../goalAgentState.js';

/** Domain code, not a model claim, decides whether a missing condition can be waited for. */
export type GoalProgressGuidance =
  | { kind: 'needs_owner'; reason: string; question: string; evidenceRefs: string[] }
  | { kind: 'unsupported'; reason: string; evidenceRefs: string[] }
  | { kind: 'wait'; key: string; reason: string; observedAt: number; evidenceRefs: string[] };

/** One immutable, generation-pinned progress reading. */
export interface GoalProgressReading {
  readonly snapshot: RegistrySnapshotRef;
  readonly contribution: ContributionRef;
  readonly observedAt: number;
  readonly semanticState: unknown;
  readonly evidenceRefs: readonly string[];
  readonly guidance: GoalProgressGuidance | null;
}

/**
 * Sole progress evidence boundary. It resolves a Progress Contribution from
 * state.snapshotRef; querying the latest generation or inferring legacy state
 * is outside this contract.
 */
export interface GoalProgressContributionPort {
  read(state: Readonly<GoalAgentStateV1>, signal: AbortSignal): Promise<GoalProgressReading> | GoalProgressReading;
}
