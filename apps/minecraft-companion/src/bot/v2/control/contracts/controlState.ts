import type {
  ContributionRef,
  RegistrySnapshotRef,
} from '../../plugin-sdk/identity.js';

export type PolicyScope =
  | { kind: 'current_incident'; incidentId: string }
  | { kind: 'until_goal_terminal'; goalRequestRef: string }
  | { kind: 'until_owner_command' }
  | { kind: 'permanent' };

export interface ControlScope {
  companionId: string;
  policyScope: PolicyScope | null;
  incidentId: string | null;
  resourceIds: readonly string[];
}

export interface PolicyGrant {
  policyGrantId: string;
  policy: ContributionRef;
  strategy: ContributionRef;
  snapshot: RegistrySnapshotRef;
  allowedTriggers: readonly string[];
  scope: PolicyScope;
  priorityCeiling: number;
  allowedResources: readonly string[];
  allowedOperations: readonly ContributionRef[];
  issuedBy: 'owner' | 'goal_agent_authority';
  ownerRevision: number;
  grantEpoch: number;
  issuedAt: number;
  expiresAt: number | null;
}

export type ControlSubjectRef =
  | { kind: 'goal'; goalId: string; goalSessionId: string }
  | { kind: 'strategy'; strategyId: string; strategySessionId: string };

export type ControlPrincipalRef =
  | { kind: 'owner'; admissionId: string; ownerRevision: number }
  | {
      kind: 'goal_agent';
      authoritySessionId: string;
      decisionId: string;
      decisionRevision: number;
    }
  | { kind: 'goal'; sponsoringGrantId: string; sponsoringGrantEpoch: number }
  | {
      kind: 'policy';
      policyGrantId: string;
      policyGrantEpoch: number;
      proposalId: string;
      proposalRevision: number;
      incidentId: string | null;
    }
  | { kind: 'system_reconcile'; reconcileId: string };

export interface AuthorizedAcquisitionContextRef {
  acquisitionContextId: string;
  contextRevision: number;
  contextDigest: string;
}

export type PhysicalOwnerIncarnationRef =
  | {
      kind: 'goal';
      taskId: string;
      sessionId: string;
      epoch: number;
      planRevision: number;
    }
  | { kind: 'task'; taskId: string; ownerEpoch: number };

export type DesiredControlTarget =
  | { kind: 'idle' }
  | { kind: 'owner_directive_pending'; admissionId: string }
  | { kind: 'goal_request'; goalRequestRef: string }
  | { kind: 'existing_goal_session'; goalId: string; goalSessionId: string }
  | {
      kind: 'strategy_activation';
      strategy: ContributionRef;
      reservedStrategySessionId: string;
    };

export interface AuthorizedAcquisitionContext extends AuthorizedAcquisitionContextRef {
  target: DesiredControlTarget;
  snapshot: RegistrySnapshotRef;
  authorizedBy: ControlPrincipalRef;
  scope: ControlScope;
  allowedOperations: readonly ContributionRef[];
  allowedResources: readonly string[];
  priorityCeiling: number;
  deadlineAt: number | null;
  normalizedConfigDigest: string;
  expectedPhysicalOwnerKind: PhysicalOwnerIncarnationRef['kind'];
  targetBodyAdmissionEpoch: number;
  sourceEventSequence: number;
  createdAt: number;
}

export interface PhysicalOwnerNamespaceRef {
  namespaceId: string;
  subject: ControlSubjectRef;
  acquisition: AuthorizedAcquisitionContextRef;
  ownerKind: PhysicalOwnerIncarnationRef['kind'];
  namespaceEpoch: number;
  bodyAdmissionEpoch: number;
}

export interface PhysicalOwnerBindingRef {
  bindingId: string;
  bindingKeyDigest: string;
  namespace: PhysicalOwnerNamespaceRef;
  controlGrantId: string;
  controlGrantEpoch: number;
  owner: PhysicalOwnerIncarnationRef;
}

export interface ControlGrantBase {
  grantId: string;
  grantEpoch: number;
  subject: ControlSubjectRef;
  snapshot: RegistrySnapshotRef;
  scope: ControlScope;
  allowedOperations: readonly ContributionRef[];
  allowedResources: readonly string[];
  priorityCeiling: number;
  issuedAt: number;
  deadlineAt: number | null;
  authorizedBy: ControlPrincipalRef;
  acquisition: AuthorizedAcquisitionContextRef;
  physicalOwnerNamespace: PhysicalOwnerNamespaceRef;
  bodyAdmissionEpoch: number;
}

export interface GoalControlGrant extends ControlGrantBase {
  kind: 'goal';
  subject: Extract<ControlSubjectRef, { kind: 'goal' }>;
}

export interface StrategyControlGrant extends ControlGrantBase {
  kind: 'strategy';
  subject: Extract<ControlSubjectRef, { kind: 'strategy' }>;
  policyGrantId: string | null;
}

export type ControlGrant = GoalControlGrant | StrategyControlGrant;

export interface GoalResumeTokenRef {
  tokenId: string;
  commandId: string;
  goalSessionId: string;
  tokenDigest: string;
  resumeAuthorizedBy: ControlPrincipalRef;
  resumeAcquisition: AuthorizedAcquisitionContextRef;
}

export type ControlStopTarget =
  | { kind: 'operation'; operationId: string }
  | { kind: 'goal'; goalSessionId: string }
  | { kind: 'strategy'; strategySessionId: string }
  | { kind: 'physical_owner'; binding: PhysicalOwnerBindingRef }
  | { kind: 'all_agent_body_operations'; companionId: string };

export type StandaloneControlStopTarget = Extract<
  ControlStopTarget,
  { kind: 'operation' | 'physical_owner' }
>;

export type TransferPhase =
  | 'fence'
  | 'goal_suspension'
  | 'revoke'
  | 'drain'
  | 'drain_quiesced'
  | 'prepare'
  | 'activate_gated'
  | 'commit'
  | 'reconcile';

export interface ControlWorkRefBase {
  workId: string;
  commandId: string;
}

export type ControlWorkRef =
  | (ControlWorkRefBase & {
      kind: 'transfer';
      transferId: string;
      desiredTarget: DesiredControlTarget;
      drainTarget: ControlStopTarget;
      sourceBodyAdmissionEpoch: number;
      targetBodyAdmissionEpoch: number;
    })
  | (ControlWorkRefBase & {
      kind: 'stop';
      stopId: string;
      target: StandaloneControlStopTarget;
    })
  | (ControlWorkRefBase & {
      kind: 'policy';
      policyWorkId: string;
      policy: ContributionRef;
    });

export interface SourceControlLineageRef {
  subject: ControlSubjectRef;
  grantId: string;
  grantEpoch: number;
  authorizedBy: ControlPrincipalRef;
  acquisition: AuthorizedAcquisitionContextRef;
  physicalOwnerNamespace: PhysicalOwnerNamespaceRef;
  bodyAdmissionEpoch: number;
}

export type PreviousStableControlRef = SourceControlLineageRef;

export type GoalAgentControlState =
  | {
      kind: 'idle';
      controlRevision: number;
      bodyAdmissionEpoch: number;
      bodyAdmissionGate: 'open';
      updatedAt: number;
    }
  | {
      kind: 'goal_controlled';
      controlRevision: number;
      subject: Extract<ControlSubjectRef, { kind: 'goal' }>;
      grantId: string;
      grantEpoch: number;
      grantGoalEpoch: number;
      authorizedBy: ControlPrincipalRef;
      acquisition: AuthorizedAcquisitionContextRef;
      bodyAdmissionEpoch: number;
      bodyAdmissionGate: 'open';
      updatedAt: number;
    }
  | {
      kind: 'transferring';
      controlRevision: number;
      transferId: string;
      commandId: string;
      sourceControl: SourceControlLineageRef | null;
      to: DesiredControlTarget;
      drainTarget: ControlStopTarget;
      initiatedBy: ControlPrincipalRef;
      targetAcquisition: AuthorizedAcquisitionContextRef | null;
      bodyAdmissionEpoch: number;
      targetBodyAdmissionEpoch: number;
      bodyAdmissionGate: 'fenced';
      phase: TransferPhase;
      suspendedGoal: GoalResumeTokenRef | null;
      updatedAt: number;
    }
  | {
      kind: 'delegated';
      controlRevision: number;
      subject: Extract<ControlSubjectRef, { kind: 'strategy' }>;
      grantId: string;
      grantEpoch: number;
      policyGrantId: string | null;
      authorizedBy: ControlPrincipalRef;
      acquisition: AuthorizedAcquisitionContextRef;
      bodyAdmissionEpoch: number;
      bodyAdmissionGate: 'open';
      suspendedGoal: GoalResumeTokenRef | null;
      updatedAt: number;
    }
  | {
      kind: 'quarantined';
      controlRevision: number;
      bodyAdmissionEpoch: number;
      targetBodyAdmissionEpoch: number;
      bodyAdmissionGate: 'fenced';
      causeWork: Exclude<ControlWorkRef, { kind: 'policy' }>;
      previousStable: PreviousStableControlRef | null;
      desiredTarget: DesiredControlTarget | null;
      targetAcquisition: AuthorizedAcquisitionContextRef | null;
      sourceControl: SourceControlLineageRef | null;
      initiatedBy: ControlPrincipalRef;
      suspendedGoal: GoalResumeTokenRef | null;
      inDoubtReservationIds: readonly string[];
      inDoubtOperationIds: readonly string[];
      reason: string;
      updatedAt: number;
    };

export type ControlPolicyStatus = 'disabled' | 'armed' | 'suspended' | 'revoked' | 'faulted';

export interface ControlPolicyRecord {
  policy: ContributionRef;
  strategy: ContributionRef;
  status: ControlPolicyStatus;
  grant: PolicyGrant | null;
  ownerRevision: number;
  reason: string | null;
  updatedAt: number;
}

export interface GoalAgentControlAggregate {
  schema: 'mineclaw.goal-agent-control/v1';
  companionId: string;
  controlRevision: number;
  lastEventSequence: number;
  state: GoalAgentControlState;
  policies: readonly ControlPolicyRecord[];
  grants: readonly ControlGrant[];
  acquisitions: readonly AuthorizedAcquisitionContext[];
}

export function createInitialControlAggregate(
  companionId: string,
  initiatedBy: Extract<ControlPrincipalRef, { kind: 'system_reconcile' }>,
  now = Date.now(),
): GoalAgentControlAggregate {
  const state: GoalAgentControlState = {
    kind: 'transferring',
    controlRevision: 0,
    transferId: `initial-reconcile:${companionId}`,
    commandId: `initial-reconcile:${companionId}`,
    sourceControl: null,
    to: { kind: 'idle' },
    drainTarget: { kind: 'all_agent_body_operations', companionId },
    initiatedBy,
    targetAcquisition: null,
    bodyAdmissionEpoch: 0,
    targetBodyAdmissionEpoch: 1,
    bodyAdmissionGate: 'fenced',
    phase: 'reconcile',
    suspendedGoal: null,
    updatedAt: now,
  };
  return {
    schema: 'mineclaw.goal-agent-control/v1',
    companionId,
    controlRevision: 0,
    lastEventSequence: 0,
    state,
    policies: [],
    grants: [],
    acquisitions: [],
  };
}

export function assertGoalAgentControlAggregate(value: GoalAgentControlAggregate): void {
  if (value.schema !== 'mineclaw.goal-agent-control/v1') throw new Error('unsupported_control_schema');
  if (!value.companionId.trim()) throw new Error('control_companion_id_required');
  if (!Number.isSafeInteger(value.controlRevision) || value.controlRevision < 0) {
    throw new Error('invalid_control_revision');
  }
  if (!Number.isSafeInteger(value.lastEventSequence) || value.lastEventSequence < 0) {
    throw new Error('invalid_control_event_sequence');
  }
  if (value.state.controlRevision !== value.controlRevision) {
    throw new Error('control_state_revision_mismatch');
  }
  const stable = value.state.kind === 'idle'
    || value.state.kind === 'goal_controlled'
    || value.state.kind === 'delegated';
  if (stable && value.state.bodyAdmissionGate !== 'open') throw new Error('stable_control_gate_must_be_open');
  if (!stable && value.state.bodyAdmissionGate !== 'fenced') throw new Error('unsafe_control_gate_must_be_fenced');
  if (value.state.kind === 'transferring'
    && value.state.targetBodyAdmissionEpoch < value.state.bodyAdmissionEpoch) {
    throw new Error('target_body_epoch_cannot_regress');
  }
  if (value.state.kind === 'quarantined'
    && value.state.targetBodyAdmissionEpoch < value.state.bodyAdmissionEpoch) {
    throw new Error('quarantine_target_body_epoch_cannot_regress');
  }
  const grantKeys = new Set<string>();
  for (const grant of value.grants) {
    const key = `${grant.grantId}:${grant.grantEpoch}`;
    if (grantKeys.has(key)) throw new Error('duplicate_control_grant');
    grantKeys.add(key);
  }
  const policyKeys = new Set<string>();
  for (const policy of value.policies) {
    const key = contributionKey(policy.policy);
    if (policyKeys.has(key)) throw new Error('duplicate_control_policy');
    policyKeys.add(key);
  }
}

export function contributionKey(ref: ContributionRef): string {
  return `${ref.pluginId}@${ref.pluginVersion}:${ref.contributionId}@${ref.contributionVersion}`;
}

export function cloneControlAggregate(value: GoalAgentControlAggregate): GoalAgentControlAggregate {
  return structuredClone(value);
}
