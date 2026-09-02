import type { BoundGoalScope } from './goalDraft.js';
import type { ContributionRef, RegistrySnapshotRef } from '../../plugin-sdk/identity.js';

/** An owner is an incarnation, not merely a task or policy name. */
export type ExecutionOwner =
  | { readonly kind: 'goal'; readonly taskId: string; readonly sessionId: string; readonly epoch: number; readonly planRevision: number }
  | { readonly kind: 'task'; readonly taskId: string; readonly ownerEpoch: number }
  | { readonly kind: 'safety'; readonly policyId: string; readonly ownerEpoch: number };

/**
 * Body command. `ref.contribution` is the exact contribution identity copied
 * from the authorized candidate/grant — the execution layer never invents a
 * default version and must fail closed when it is missing. `snapshot` pins the
 * Registry Generation that authored/validated this command; resolvers never
 * fall back to a live registry.
 */
export interface OperationCommand {
  readonly ref: { readonly id: string; readonly contribution: ContributionRef };
  readonly snapshot: RegistrySnapshotRef;
  readonly args: Readonly<Record<string, unknown>>;
}

/** Pure data. This object is NOT permission to use the body. */
export interface OperationIntent {
  readonly operationId: string;
  readonly owner: ExecutionOwner;
  readonly command: OperationCommand;
  readonly scope: BoundGoalScope;
  readonly deadlineAt: number;
  readonly budget: { readonly maxActions: number };
  readonly priority: number;
  readonly preemption: 'none' | 'request';
}

export interface OperationIdentity {
  readonly operationId: string;
  readonly owner: ExecutionOwner;
  /** Runtime-generated, never supplied by callers. */
  readonly leaseRef: string;
  /** Owner incarnation of this operation; distinct from Registry Generation. */
  readonly operationEpoch: number;
  readonly deadlineAt: number;
}

/** Emitted only after the original work AND its cleanup have drained. */
export interface StopAcknowledgement extends OperationIdentity {
  readonly state: 'quiesced';
  readonly at: number;
}

export type BodyOperationState = 'running' | 'cancelling' | 'quarantined' | 'settled';

export interface OperationSnapshot extends OperationIdentity {
  readonly state: BodyOperationState;
  readonly resources: readonly string[];
  readonly actionsStarted: number;
  readonly pendingWork: number;
  readonly cancelReason: string | null;
  readonly stopErrors: readonly string[];
  readonly stop: StopAcknowledgement | null;
}
