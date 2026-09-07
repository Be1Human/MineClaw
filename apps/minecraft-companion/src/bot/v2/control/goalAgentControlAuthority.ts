import { randomUUID } from 'node:crypto';

import type { ControlEventInput, ControlMutation } from './contracts/controlEvent.js';
import type {
  AuthorizedAcquisitionContext,
  ControlGrant,
  ControlPolicyRecord,
  ControlPrincipalRef,
  DesiredControlTarget,
  GoalAgentControlAggregate,
  GoalAgentControlState,
  GoalResumeTokenRef,
  SourceControlLineageRef,
  TransferPhase,
} from './contracts/controlState.js';
import type {
  ControlRepositoryAppendResult,
  ControlStateRepositoryPort,
} from './persistence/controlStateRepository.js';

export type StorageFailureProtection =
  | { failClosedGateEstablished: true; hostIsolationEstablished: boolean }
  | { failClosedGateEstablished: false; hostIsolationEstablished: true }
  | {
      failClosedGateEstablished: false;
      hostIsolationEstablished: false;
      bodyDisconnectRequired: true;
    };

export type AuthorityStepResult<T> =
  | {
      kind: 'committed' | 'idempotent_replay';
      value: T;
      controlRevision: number;
      eventSequence: number;
    }
  | {
      kind: 'rejected';
      reason: 'stale' | 'conflict' | 'invalid_transition' | 'not_authorized' | 'unknown_target';
      currentControlRevision: number;
      eventSequence: number;
    }
  | { kind: 'storage_unavailable'; protection: StorageFailureProtection; reason: string };

export interface AuthorityMutationCommand {
  companionId: string;
  expectedControlRevision: number;
  commandId: string;
  rootCommandDigest: string;
  stepId: string;
  stepDigest: string;
  stage: string;
  workId: string | null;
  occurredAt?: number;
}

export interface AdmitTransferRequest {
  transferId: string;
  to: DesiredControlTarget;
  initiatedBy: ControlPrincipalRef;
  targetAcquisition: AuthorizedAcquisitionContext | null;
  globalBodyEpochCut?: boolean;
}

export class GoalAgentControlAuthority {
  constructor(
    private readonly repository: ControlStateRepositoryPort,
    private readonly storageFailureProtection: () => StorageFailureProtection = () => ({
      failClosedGateEstablished: false,
      hostIsolationEstablished: false,
      bodyDisconnectRequired: true,
    }),
  ) {}

  initialize(companionId: string, reconcileId = randomUUID(), now = Date.now()): GoalAgentControlAggregate {
    return this.repository.initialize(companionId, reconcileId, now);
  }

  inspect(companionId: string): GoalAgentControlAggregate | null {
    return this.repository.load(companionId);
  }

  admitTransfer(
    command: AuthorityMutationCommand,
    request: AdmitTransferRequest,
  ): AuthorityStepResult<GoalAgentControlState> {
    const aggregate = this.repository.load(command.companionId);
    if (!aggregate) {
      return {
        kind: 'rejected',
        reason: 'unknown_target',
        currentControlRevision: command.expectedControlRevision,
        eventSequence: 0,
      };
    }
    let sourceControl: Extract<GoalAgentControlState, { kind: 'transferring' }>['sourceControl'];
    try {
      sourceControl = sourceLineageOf(aggregate);
    } catch {
      return {
        kind: 'rejected',
        reason: 'invalid_transition',
        currentControlRevision: aggregate.controlRevision,
        eventSequence: aggregate.lastEventSequence,
      };
    }
    const targetBodyAdmissionEpoch = request.globalBodyEpochCut
      ? aggregate.state.bodyAdmissionEpoch + 1
      : aggregate.state.bodyAdmissionEpoch;
    if (request.targetAcquisition
      && request.targetAcquisition.targetBodyAdmissionEpoch !== targetBodyAdmissionEpoch) {
      return {
        kind: 'rejected',
        reason: 'not_authorized',
        currentControlRevision: aggregate.controlRevision,
        eventSequence: aggregate.lastEventSequence,
      };
    }
    const state: Extract<GoalAgentControlState, { kind: 'transferring' }> = {
      kind: 'transferring',
      controlRevision: aggregate.controlRevision,
      transferId: request.transferId,
      commandId: command.commandId,
      sourceControl,
      to: structuredClone(request.to),
      drainTarget: drainTargetOf(command.companionId, sourceControl),
      initiatedBy: structuredClone(request.initiatedBy),
      targetAcquisition: request.targetAcquisition ? structuredClone(request.targetAcquisition) : null,
      bodyAdmissionEpoch: aggregate.state.bodyAdmissionEpoch,
      targetBodyAdmissionEpoch,
      bodyAdmissionGate: 'fenced',
      phase: 'fence',
      suspendedGoal: aggregate.state.kind === 'delegated'
        ? structuredClone(aggregate.state.suspendedGoal)
        : null,
      updatedAt: command.occurredAt ?? Date.now(),
    };
    return this.commit(command, 'control.transfer_admitted', { kind: 'transfer_admitted', state }, aggregate => aggregate.state);
  }

  advanceTransfer(
    command: AuthorityMutationCommand,
    transferId: string,
    phase: TransferPhase,
  ): AuthorityStepResult<GoalAgentControlState> {
    return this.commit(
      command,
      'control.transfer_phase_advanced',
      { kind: 'transfer_phase_advanced', transferId, phase, updatedAt: command.occurredAt ?? Date.now() },
      aggregate => aggregate.state,
    );
  }

  attachGoalResumeTokenRef(
    command: AuthorityMutationCommand,
    transferId: string,
    tokenRef: GoalResumeTokenRef,
  ): AuthorityStepResult<GoalResumeTokenRef> {
    return this.commit(
      command,
      'control.goal_resume_token_attached',
      {
        kind: 'goal_resume_token_attached',
        transferId,
        tokenRef,
        updatedAt: command.occurredAt ?? Date.now(),
      },
      aggregate => {
        if (aggregate.state.kind !== 'transferring' || !aggregate.state.suspendedGoal) {
          throw new Error('resume_token_not_attached');
        }
        return aggregate.state.suspendedGoal;
      },
    );
  }

  commitGoalControl(
    command: AuthorityMutationCommand,
    state: Extract<GoalAgentControlState, { kind: 'goal_controlled' }>,
    grant: Extract<ControlGrant, { kind: 'goal' }>,
    acquisition: AuthorizedAcquisitionContext,
  ): AuthorityStepResult<GoalAgentControlState> {
    return this.commit(
      command,
      'control.goal_committed',
      { kind: 'goal_control_committed', state, grant, acquisition },
      aggregate => aggregate.state,
    );
  }

  commitDelegation(
    command: AuthorityMutationCommand,
    state: Extract<GoalAgentControlState, { kind: 'delegated' }>,
    grant: Extract<ControlGrant, { kind: 'strategy' }>,
    acquisition: AuthorizedAcquisitionContext,
  ): AuthorityStepResult<GoalAgentControlState> {
    return this.commit(
      command,
      'control.strategy_committed',
      { kind: 'strategy_control_committed', state, grant, acquisition },
      aggregate => aggregate.state,
    );
  }

  settleIdle(
    command: AuthorityMutationCommand,
    state: Extract<GoalAgentControlState, { kind: 'idle' }>,
  ): AuthorityStepResult<GoalAgentControlState> {
    return this.commit(
      command,
      'control.transfer_settled_idle',
      { kind: 'transfer_settled_idle', state },
      aggregate => aggregate.state,
    );
  }

  quarantine(
    command: AuthorityMutationCommand,
    state: Extract<GoalAgentControlState, { kind: 'quarantined' }>,
  ): AuthorityStepResult<GoalAgentControlState> {
    return this.commit(
      command,
      'control.quarantined',
      { kind: 'quarantine_entered', state },
      aggregate => aggregate.state,
    );
  }

  applyPolicyMutation(
    command: AuthorityMutationCommand,
    policy: ControlPolicyRecord,
  ): AuthorityStepResult<ControlPolicyRecord> {
    return this.commit(
      command,
      'control.policy_changed',
      { kind: 'policy_changed', policy },
      aggregate => aggregate.policies.find(candidate =>
        candidate.policy.pluginId === policy.policy.pluginId
        && candidate.policy.pluginVersion === policy.policy.pluginVersion
        && candidate.policy.contributionId === policy.policy.contributionId
        && candidate.policy.contributionVersion === policy.policy.contributionVersion)!,
    );
  }

  recordAudit(
    command: AuthorityMutationCommand,
    eventType: string,
    payload: Record<string, unknown>,
  ): AuthorityStepResult<GoalAgentControlAggregate> {
    return this.commit(command, eventType, null, aggregate => aggregate, payload);
  }

  private commit<T>(
    command: AuthorityMutationCommand,
    eventType: string,
    mutation: ControlMutation | null,
    project: (aggregate: GoalAgentControlAggregate) => T,
    payload: Record<string, unknown> = {},
  ): AuthorityStepResult<T> {
    const event: ControlEventInput = {
      eventId: randomUUID(),
      identity: {
        commandId: command.commandId,
        stage: command.stage,
        workId: command.workId,
        stepId: command.stepId,
        rootCommandDigest: command.rootCommandDigest,
        stepDigest: command.stepDigest,
      },
      eventType,
      mutation,
      payload,
      occurredAt: command.occurredAt ?? Date.now(),
    };
    let result: ControlRepositoryAppendResult;
    try {
      result = this.repository.append({
        companionId: command.companionId,
        expectedControlRevision: command.expectedControlRevision,
        event,
      });
    } catch (error) {
      return {
        kind: 'storage_unavailable',
        protection: this.storageFailureProtection(),
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    if (result.kind === 'rejected') {
      return {
        kind: 'rejected',
        reason: result.reason,
        currentControlRevision: result.aggregate.controlRevision,
        eventSequence: result.event.eventSequence,
      };
    }
    return {
      kind: result.kind,
      value: project(result.aggregate),
      controlRevision: result.aggregate.controlRevision,
      eventSequence: result.event.eventSequence,
    };
  }
}

function sourceLineageOf(
  aggregate: GoalAgentControlAggregate,
): Extract<GoalAgentControlState, { kind: 'transferring' }>['sourceControl'] {
  const state = aggregate.state;
  if (state.kind === 'idle') return null;
  if (state.kind !== 'goal_controlled' && state.kind !== 'delegated') {
    throw new Error('current_control_not_stable');
  }
  const grant = aggregate.grants.find(candidate =>
    candidate.grantId === state.grantId && candidate.grantEpoch === state.grantEpoch);
  if (!grant) throw new Error('current_control_grant_missing');
  return {
    subject: structuredClone(state.subject),
    grantId: state.grantId,
    grantEpoch: state.grantEpoch,
    authorizedBy: structuredClone(state.authorizedBy),
    acquisition: structuredClone(state.acquisition),
    physicalOwnerNamespace: structuredClone(grant.physicalOwnerNamespace),
    bodyAdmissionEpoch: state.bodyAdmissionEpoch,
  };
}

function drainTargetOf(
  companionId: string,
  source: SourceControlLineageRef | null,
): Extract<GoalAgentControlState, { kind: 'transferring' }>['drainTarget'] {
  if (!source) return { kind: 'all_agent_body_operations', companionId };
  return source.subject.kind === 'goal'
    ? { kind: 'goal', goalSessionId: source.subject.goalSessionId }
    : { kind: 'strategy', strategySessionId: source.subject.strategySessionId };
}
