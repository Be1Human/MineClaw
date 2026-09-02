import type { BoundGoalScope } from './goalDraft.js';

/** An owner is an incarnation, not merely a task or policy name. */
export type ExecutionOwner =
  | { readonly kind: 'goal'; readonly taskId: string; readonly sessionId: string; readonly epoch: number; readonly planRevision: number }
  | { readonly kind: 'task'; readonly taskId: string; readonly generation: number }
  | { readonly kind: 'safety'; readonly policyId: string; readonly generation: number };

export interface OperationCommand {
  readonly ref: { readonly id: string; readonly version: string };
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
  readonly generation: number;
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
