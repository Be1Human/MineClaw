import { randomUUID } from 'node:crypto';
import type {
  GoalInitiativeProvenanceV2,
  GoalMessageReceiptV2,
} from '../decision/goalAgentPort/contracts.js';
import type { ProactiveTickEvaluation } from './contracts.js';
import type { ProactiveCapabilityStateStore } from './proactiveCapabilityStateStore.js';
import type { ProactiveGoalLease, ProactiveGoalLeaseRegistry } from './proactiveGoalLeaseRegistry.js';
import type { ProactiveArbitration, ProactiveCandidateEnvelope } from './proactiveIntentArbiter.js';

export interface MainBrainProactiveGoalPort {
  request(input: {
    requestText: string;
    requestKind: 'task';
    constraints?: string[];
    initiative: GoalInitiativeProvenanceV2;
  }): GoalMessageReceiptV2;
  cancelRequest(requestId: string, reason: string): boolean;
}

export interface MainBrainProactiveInboxOptions {
  readonly goalAgentPort: MainBrainProactiveGoalPort;
  readonly leases: ProactiveGoalLeaseRegistry;
  readonly stateStore: ProactiveCapabilityStateStore;
  readonly now?: () => number;
  readonly activationId?: () => string;
  readonly publish?: (type: string, payload: Readonly<Record<string, unknown>>) => void;
}

/**
 * The only bridge from deterministic proactive observations to a game request.
 * Plugins stop at candidates; this inbox owns provenance, lease and GoalAgentPort admission.
 */
export class MainBrainProactiveInbox {
  private readonly now: () => number;
  private readonly activationId: () => string;

  constructor(private readonly options: MainBrainProactiveInboxOptions) {
    this.now = options.now ?? Date.now;
    this.activationId = options.activationId ?? (() => `proactive-${randomUUID()}`);
  }

  handle(decision: ProactiveArbitration, evaluations: ReadonlyMap<string, ProactiveTickEvaluation>): void {
    this.applyReleaseSignals(evaluations);
    if (decision.kind === 'none' || decision.kind === 'retain') return;
    if (decision.kind === 'replace') this.release(decision.lease, `replaced_by:${decision.winner.capabilityId}`);
    this.accept(decision.winner);
  }

  /** Called synchronously before a player turn is admitted by GoalAgentPort. */
  preemptForPlayer(): boolean {
    const lease = this.options.leases.requestPlayerPreemption();
    if (!lease) return false;
    this.finishRelease(lease, 'player_preempted');
    return true;
  }

  private applyReleaseSignals(evaluations: ReadonlyMap<string, ProactiveTickEvaluation>): void {
    const active = this.options.leases.snapshot().active;
    if (!active) return;
    const evaluation = evaluations.get(active.capabilityId);
    if (evaluation?.kind !== 'release') return;
    if (evaluation.activationId && evaluation.activationId !== active.activationId) return;
    this.release(active, evaluation.reason);
  }

  private accept(winner: ProactiveCandidateEnvelope): void {
    const activationId = this.activationId();
    const lease = this.options.leases.grant(winner, activationId, this.now());
    this.options.stateStore.recordLease(winner.capabilityId, lease);
    const initiative: GoalInitiativeProvenanceV2 = {
      capabilityId: winner.capabilityId,
      activationId,
      evidenceRefs: [...winner.candidate.evidenceRefs],
      idempotencyKey: winner.candidate.idempotencyKey,
      preemptible: true,
    };
    const receipt = this.options.goalAgentPort.request({
      requestText: winner.candidate.requestText,
      requestKind: 'task',
      constraints: [...(winner.candidate.constraints ?? [])],
      initiative,
    });
    this.options.publish?.('proactive.request', {
      capabilityId: winner.capabilityId,
      activationId,
      requestId: receipt.sourceMessageId,
      outcome: receipt.outcome,
    });
    if (receipt.outcome === 'consumed') {
      this.options.leases.bindRequest(activationId, receipt.sourceMessageId);
      this.options.stateStore.recordRunning(winner.capabilityId, receipt.sourceMessageId);
      return;
    }
    const releasing = this.options.leases.requestRelease(winner.capabilityId, activationId);
    if (releasing) this.options.leases.confirmReleased(activationId);
    this.options.stateStore.recordReleased(winner.capabilityId, `request_${receipt.outcome}`);
    this.options.stateStore.recordResult(winner.capabilityId, {
      ok: false,
      outcome: receipt.outcome,
      ...(receipt.reason ? { reason: receipt.reason } : {}),
    });
  }

  private release(lease: ProactiveGoalLease, reason: string): void {
    const releasing = this.options.leases.requestRelease(lease.capabilityId, lease.activationId);
    if (releasing) this.finishRelease(releasing, reason);
  }

  private finishRelease(lease: ProactiveGoalLease, reason: string): void {
    const cancelAccepted = lease.requestId
      ? this.options.goalAgentPort.cancelRequest(lease.requestId, `proactive:${reason}`)
      : true;
    this.options.leases.confirmReleased(lease.activationId);
    this.options.stateStore.recordReleased(lease.capabilityId, reason);
    this.options.stateStore.recordResult(lease.capabilityId, { ok: cancelAccepted, reason });
    this.options.publish?.('proactive.released', {
      capabilityId: lease.capabilityId,
      activationId: lease.activationId,
      requestId: lease.requestId ?? '',
      reason,
      cancelAccepted,
    });
  }
}
