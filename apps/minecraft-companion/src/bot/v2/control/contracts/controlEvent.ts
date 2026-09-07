import type {
  AuthorizedAcquisitionContext,
  ControlGrant,
  ControlPolicyRecord,
  GoalAgentControlAggregate,
  GoalAgentControlState,
  GoalResumeTokenRef,
  TransferPhase,
} from './controlState.js';
import {
  assertGoalAgentControlAggregate,
  cloneControlAggregate,
  contributionKey,
} from './controlState.js';

export interface ControlCommandIdentity {
  commandId: string;
  stage: string;
  workId: string | null;
  stepId: string;
  rootCommandDigest: string;
  stepDigest: string;
}

export type ControlMutation =
  | { kind: 'transfer_admitted'; state: Extract<GoalAgentControlState, { kind: 'transferring' }> }
  | { kind: 'transfer_phase_advanced'; transferId: string; phase: TransferPhase; updatedAt: number }
  | { kind: 'goal_resume_token_attached'; transferId: string; tokenRef: GoalResumeTokenRef; updatedAt: number }
  | {
      kind: 'goal_control_committed';
      state: Extract<GoalAgentControlState, { kind: 'goal_controlled' }>;
      grant: Extract<ControlGrant, { kind: 'goal' }>;
      acquisition: AuthorizedAcquisitionContext;
    }
  | {
      kind: 'strategy_control_committed';
      state: Extract<GoalAgentControlState, { kind: 'delegated' }>;
      grant: Extract<ControlGrant, { kind: 'strategy' }>;
      acquisition: AuthorizedAcquisitionContext;
    }
  | { kind: 'transfer_settled_idle'; state: Extract<GoalAgentControlState, { kind: 'idle' }> }
  | { kind: 'quarantine_entered'; state: Extract<GoalAgentControlState, { kind: 'quarantined' }> }
  | { kind: 'policy_changed'; policy: ControlPolicyRecord };

export interface ControlEventInput {
  eventId: string;
  identity: ControlCommandIdentity;
  eventType: string;
  mutation: ControlMutation | null;
  payload: Record<string, unknown>;
  occurredAt: number;
}

export interface PersistedControlEvent extends ControlEventInput {
  companionId: string;
  eventSequence: number;
  controlRevision: number | null;
}

export function reduceControlEvent(
  current: GoalAgentControlAggregate,
  event: PersistedControlEvent,
): GoalAgentControlAggregate {
  if (event.companionId !== current.companionId) throw new Error('control_event_wrong_companion');
  if (event.eventSequence !== current.lastEventSequence + 1) {
    throw new Error('control_event_sequence_not_contiguous');
  }
  if (!event.mutation) {
    const audited = { ...cloneControlAggregate(current), lastEventSequence: event.eventSequence };
    assertGoalAgentControlAggregate(audited);
    return audited;
  }
  if (event.controlRevision !== current.controlRevision + 1) {
    throw new Error('control_mutation_revision_not_contiguous');
  }

  const next = cloneControlAggregate(current);
  next.controlRevision = event.controlRevision;
  next.lastEventSequence = event.eventSequence;
  switch (event.mutation.kind) {
    case 'transfer_admitted':
      assertTransferAdmission(current.state, event.mutation.state);
      next.state = withRevision(event.mutation.state, event.controlRevision);
      break;
    case 'transfer_phase_advanced': {
      if (current.state.kind !== 'transferring'
        || current.state.transferId !== event.mutation.transferId) {
        throw new Error('transfer_phase_requires_current_transfer');
      }
      if (!isForwardTransferPhase(current.state.phase, event.mutation.phase)) {
        throw new Error('invalid_transfer_phase_transition');
      }
      next.state = {
        ...current.state,
        phase: event.mutation.phase,
        controlRevision: event.controlRevision,
        updatedAt: event.mutation.updatedAt,
      };
      break;
    }
    case 'goal_resume_token_attached': {
      if (current.state.kind !== 'transferring'
        || current.state.transferId !== event.mutation.transferId) {
        throw new Error('resume_token_requires_current_transfer');
      }
      if (current.state.suspendedGoal
        && current.state.suspendedGoal.tokenDigest !== event.mutation.tokenRef.tokenDigest) {
        throw new Error('resume_token_conflict');
      }
      next.state = {
        ...current.state,
        suspendedGoal: structuredClone(event.mutation.tokenRef),
        controlRevision: event.controlRevision,
        updatedAt: event.mutation.updatedAt,
      };
      break;
    }
    case 'goal_control_committed':
      assertCommitFromDrainedTransfer(current.state, event.mutation.state.bodyAdmissionEpoch);
      assertGoalTargetMatches(current.state, event.mutation.state);
      assertGrantMatchesState(event.mutation.grant, event.mutation.state);
      assertAcquisitionMatchesGrant(event.mutation.acquisition, event.mutation.grant);
      next.state = withRevision(event.mutation.state, event.controlRevision);
      next.grants = upsertGrant(next.grants, event.mutation.grant);
      next.acquisitions = upsertAcquisition(next.acquisitions, event.mutation.acquisition);
      break;
    case 'strategy_control_committed':
      assertCommitFromDrainedTransfer(current.state, event.mutation.state.bodyAdmissionEpoch);
      assertStrategyTargetMatches(current.state, event.mutation.state, event.mutation.acquisition);
      assertGrantMatchesState(event.mutation.grant, event.mutation.state);
      assertAcquisitionMatchesGrant(event.mutation.acquisition, event.mutation.grant);
      next.state = withRevision(event.mutation.state, event.controlRevision);
      next.grants = upsertGrant(next.grants, event.mutation.grant);
      next.acquisitions = upsertAcquisition(next.acquisitions, event.mutation.acquisition);
      break;
    case 'transfer_settled_idle':
      assertCommitFromDrainedTransfer(current.state, event.mutation.state.bodyAdmissionEpoch);
      if (current.state.kind !== 'transferring' || current.state.to.kind !== 'idle') {
        throw new Error('idle_settlement_requires_idle_target');
      }
      next.state = withRevision(event.mutation.state, event.controlRevision);
      break;
    case 'quarantine_entered':
      if (current.state.kind === 'quarantined') throw new Error('quarantine_requires_non_quarantined_state');
      next.state = withRevision(event.mutation.state, event.controlRevision);
      break;
    case 'policy_changed': {
      const policy = structuredClone(event.mutation.policy);
      const key = contributionKey(policy.policy);
      const previous = next.policies.find(item => contributionKey(item.policy) === key);
      if (previous && policy.ownerRevision < previous.ownerRevision) {
        throw new Error('policy_owner_revision_cannot_regress');
      }
      if (previous && policy.ownerRevision === previous.ownerRevision
        && JSON.stringify(previous) !== JSON.stringify(policy)) {
        throw new Error('policy_same_revision_conflict');
      }
      next.policies = [...next.policies.filter(item => contributionKey(item.policy) !== key), policy];
      next.state = withRevision(next.state, event.controlRevision);
      break;
    }
  }
  assertGoalAgentControlAggregate(next);
  return next;
}

function withRevision<T extends GoalAgentControlState>(state: T, revision: number): T {
  return { ...structuredClone(state), controlRevision: revision };
}

function assertTransferAdmission(
  current: GoalAgentControlState,
  next: Extract<GoalAgentControlState, { kind: 'transferring' }>,
): void {
  if (current.kind === 'transferring') throw new Error('nested_transfer_forbidden');
  if (current.kind === 'quarantined') throw new Error('quarantine_requires_reconcile_transition');
  if (next.bodyAdmissionGate !== 'fenced') throw new Error('transfer_must_fence_body_admission');
  if (next.bodyAdmissionEpoch !== current.bodyAdmissionEpoch) throw new Error('transfer_source_body_epoch_mismatch');
  if (next.targetBodyAdmissionEpoch !== current.bodyAdmissionEpoch
    && next.targetBodyAdmissionEpoch !== current.bodyAdmissionEpoch + 1) {
    throw new Error('transfer_target_body_epoch_invalid');
  }
}

const TRANSFER_PHASE_ORDER: readonly TransferPhase[] = [
  'fence',
  'goal_suspension',
  'revoke',
  'drain',
  'drain_quiesced',
  'prepare',
  'activate_gated',
  'commit',
  'reconcile',
];

function isForwardTransferPhase(current: TransferPhase, next: TransferPhase): boolean {
  if (current === next) return true;
  if (current === 'reconcile') return next === 'drain' || next === 'drain_quiesced';
  if (next === 'reconcile') return false;
  return TRANSFER_PHASE_ORDER.indexOf(next) > TRANSFER_PHASE_ORDER.indexOf(current);
}

function assertCommitFromDrainedTransfer(state: GoalAgentControlState, targetEpoch: number): void {
  if (state.kind !== 'transferring' || state.phase !== 'drain_quiesced') {
    throw new Error('control_commit_requires_drained_transfer');
  }
  if (state.targetBodyAdmissionEpoch !== targetEpoch) throw new Error('control_commit_body_epoch_mismatch');
}

function assertGoalTargetMatches(
  transfer: GoalAgentControlState,
  state: Extract<GoalAgentControlState, { kind: 'goal_controlled' }>,
): void {
  if (transfer.kind !== 'transferring') throw new Error('goal_commit_requires_transfer');
  if (transfer.to.kind === 'existing_goal_session'
    && (transfer.to.goalId !== state.subject.goalId
      || transfer.to.goalSessionId !== state.subject.goalSessionId)) {
    throw new Error('goal_commit_target_mismatch');
  }
  if (transfer.to.kind !== 'existing_goal_session' && transfer.to.kind !== 'goal_request') {
    throw new Error('goal_commit_requires_goal_target');
  }
}

function assertStrategyTargetMatches(
  transfer: GoalAgentControlState,
  state: Extract<GoalAgentControlState, { kind: 'delegated' }>,
  acquisition: AuthorizedAcquisitionContext,
): void {
  if (transfer.kind !== 'transferring' || transfer.to.kind !== 'strategy_activation') {
    throw new Error('strategy_commit_requires_strategy_target');
  }
  if (transfer.to.reservedStrategySessionId !== state.subject.strategySessionId
    || transfer.to.strategy.contributionId !== state.subject.strategyId) {
    throw new Error('strategy_commit_target_mismatch');
  }
  if (JSON.stringify(acquisition.target) !== JSON.stringify(transfer.to)) {
    throw new Error('strategy_acquisition_target_mismatch');
  }
}

function assertGrantMatchesState(grant: ControlGrant, state: GoalAgentControlState): void {
  if (grant.kind === 'goal') {
    if (state.kind !== 'goal_controlled') throw new Error('control_grant_kind_mismatch');
    if (state.grantId !== grant.grantId || state.grantEpoch !== grant.grantEpoch
      || state.subject.goalSessionId !== grant.subject.goalSessionId) {
      throw new Error('goal_control_grant_state_mismatch');
    }
    return;
  }
  if (state.kind !== 'delegated') throw new Error('control_grant_kind_mismatch');
  if (state.grantId !== grant.grantId || state.grantEpoch !== grant.grantEpoch
    || state.subject.strategySessionId !== grant.subject.strategySessionId) {
    throw new Error('strategy_control_grant_state_mismatch');
  }
}

function assertAcquisitionMatchesGrant(
  acquisition: AuthorizedAcquisitionContext,
  grant: ControlGrant,
): void {
  if (acquisition.acquisitionContextId !== grant.acquisition.acquisitionContextId
    || acquisition.contextRevision !== grant.acquisition.contextRevision
    || acquisition.contextDigest !== grant.acquisition.contextDigest) {
    throw new Error('control_grant_acquisition_mismatch');
  }
  if (acquisition.targetBodyAdmissionEpoch !== grant.bodyAdmissionEpoch) {
    throw new Error('control_grant_acquisition_body_epoch_mismatch');
  }
}

function upsertGrant(current: readonly ControlGrant[], grant: ControlGrant): readonly ControlGrant[] {
  const key = `${grant.grantId}:${grant.grantEpoch}`;
  return [...current.filter(item => `${item.grantId}:${item.grantEpoch}` !== key), structuredClone(grant)];
}

function upsertAcquisition(
  current: readonly AuthorizedAcquisitionContext[],
  acquisition: AuthorizedAcquisitionContext,
): readonly AuthorizedAcquisitionContext[] {
  const key = `${acquisition.acquisitionContextId}:${acquisition.contextRevision}`;
  return [
    ...current.filter(item => `${item.acquisitionContextId}:${item.contextRevision}` !== key),
    structuredClone(acquisition),
  ];
}
