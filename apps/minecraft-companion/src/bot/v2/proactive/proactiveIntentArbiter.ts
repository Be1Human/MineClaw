import type { ProactiveIntentCandidate, RegisteredProactiveTickCapability } from './contracts.js';
import type { ProactiveGoalLease, ProactiveGoalLeaseCandidate } from './proactiveGoalLeaseRegistry.js';

export interface ProactiveCandidateEnvelope extends ProactiveGoalLeaseCandidate {
  readonly capability: RegisteredProactiveTickCapability;
  readonly candidate: ProactiveIntentCandidate;
}

export interface ProactiveSuppression {
  readonly capabilityId: string;
  readonly reason: string;
}

export type ProactiveArbitration =
  | { readonly kind: 'none'; readonly suppressions: readonly ProactiveSuppression[] }
  | { readonly kind: 'accept'; readonly winner: ProactiveCandidateEnvelope; readonly suppressions: readonly ProactiveSuppression[] }
  | { readonly kind: 'retain'; readonly winner: ProactiveCandidateEnvelope; readonly lease: ProactiveGoalLease; readonly suppressions: readonly ProactiveSuppression[] }
  | { readonly kind: 'replace'; readonly winner: ProactiveCandidateEnvelope; readonly lease: ProactiveGoalLease; readonly suppressions: readonly ProactiveSuppression[] };

export class ProactiveIntentArbiter {
  arbitrate(input: {
    readonly candidates: readonly ProactiveCandidateEnvelope[];
    readonly foregroundBusy: boolean;
    readonly activeLease: ProactiveGoalLease | null;
    readonly releaseInProgress?: ProactiveGoalLease | null;
  }): ProactiveArbitration {
    const ranked = [...input.candidates].sort((left, right) => (
      right.priority - left.priority || left.capabilityId.localeCompare(right.capabilityId)
    ));
    if (input.foregroundBusy) {
      return { kind: 'none', suppressions: freezeSuppressions(ranked.map(candidate => ({ capabilityId: candidate.capabilityId, reason: 'foreground_busy' }))) };
    }
    if (input.releaseInProgress) {
      return { kind: 'none', suppressions: freezeSuppressions(ranked.map(candidate => ({ capabilityId: candidate.capabilityId, reason: 'release_in_progress' }))) };
    }
    const winner = ranked[0];
    if (!winner) return { kind: 'none', suppressions: Object.freeze([]) };
    const suppressions = freezeSuppressions(ranked.slice(1).map(candidate => ({
      capabilityId: candidate.capabilityId,
      reason: `lower_priority_than:${winner.capabilityId}`,
    })));
    if (!input.activeLease) return { kind: 'accept', winner, suppressions };
    if (input.activeLease.capabilityId === winner.capabilityId
      && input.activeLease.idempotencyKey === winner.idempotencyKey) {
      return { kind: 'retain', winner, lease: input.activeLease, suppressions };
    }
    if (winner.priority > input.activeLease.priority) {
      return { kind: 'replace', winner, lease: input.activeLease, suppressions };
    }
    return {
      kind: 'none',
      suppressions: freezeSuppressions([
        ...suppressions,
        { capabilityId: winner.capabilityId, reason: `active_lease:${input.activeLease.capabilityId}` },
      ]),
    };
  }
}

function freezeSuppressions(values: readonly ProactiveSuppression[]): readonly ProactiveSuppression[] {
  return Object.freeze(values.map(value => Object.freeze({ ...value })));
}
