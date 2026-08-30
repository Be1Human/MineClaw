export interface ProactiveGoalLeaseCandidate {
  readonly capabilityId: string;
  readonly idempotencyKey: string;
  readonly priority: number;
}

export interface ProactiveGoalLease extends ProactiveGoalLeaseCandidate {
  readonly activationId: string;
  readonly acquiredAt: number;
  readonly requestId?: string;
}

export type ProactiveGoalLeaseDecision =
  | { readonly kind: 'grantable' }
  | { readonly kind: 'retained'; readonly lease: ProactiveGoalLease }
  | { readonly kind: 'replace_required'; readonly lease: ProactiveGoalLease }
  | { readonly kind: 'rejected'; readonly reason: 'active_higher_or_equal_priority'; readonly lease: ProactiveGoalLease }
  | { readonly kind: 'blocked'; readonly reason: 'release_in_progress'; readonly lease: ProactiveGoalLease };

export class ProactiveGoalLeaseRegistry {
  private active: ProactiveGoalLease | null = null;
  private releasing: ProactiveGoalLease | null = null;

  evaluate(candidate: ProactiveGoalLeaseCandidate): ProactiveGoalLeaseDecision {
    if (this.releasing) return { kind: 'blocked', reason: 'release_in_progress', lease: this.releasing };
    if (!this.active) return { kind: 'grantable' };
    if (this.active.capabilityId === candidate.capabilityId
      && this.active.idempotencyKey === candidate.idempotencyKey) {
      return { kind: 'retained', lease: this.active };
    }
    if (candidate.priority > this.active.priority) return { kind: 'replace_required', lease: this.active };
    return { kind: 'rejected', reason: 'active_higher_or_equal_priority', lease: this.active };
  }

  grant(candidate: ProactiveGoalLeaseCandidate, activationId: string, acquiredAt: number): ProactiveGoalLease {
    if (this.active || this.releasing) throw new Error('cannot grant proactive lease while another lease is active or releasing');
    if (!activationId.trim()) throw new Error('proactive activationId is required');
    this.active = Object.freeze({ ...candidate, activationId, acquiredAt });
    return this.active;
  }

  bindRequest(activationId: string, requestId: string): ProactiveGoalLease {
    if (!this.active || this.active.activationId !== activationId) throw new Error('proactive lease activation mismatch');
    if (!requestId.trim()) throw new Error('proactive requestId is required');
    this.active = Object.freeze({ ...this.active, requestId });
    return this.active;
  }

  requestRelease(capabilityId: string, activationId: string): ProactiveGoalLease | null {
    if (!this.active) return null;
    if (this.active.capabilityId !== capabilityId || this.active.activationId !== activationId) return null;
    this.releasing = this.active;
    this.active = null;
    return this.releasing;
  }

  confirmReleased(activationId: string): ProactiveGoalLease | null {
    if (!this.releasing || this.releasing.activationId !== activationId) return null;
    const released = this.releasing;
    this.releasing = null;
    return released;
  }

  requestPlayerPreemption(): ProactiveGoalLease | null {
    if (this.releasing) return this.releasing;
    if (!this.active) return null;
    this.releasing = this.active;
    this.active = null;
    return this.releasing;
  }

  snapshot(): Readonly<{ active: ProactiveGoalLease | null; releasing: ProactiveGoalLease | null }> {
    return Object.freeze({ active: this.active, releasing: this.releasing });
  }

  clear(): void {
    this.active = null;
    this.releasing = null;
  }
}
