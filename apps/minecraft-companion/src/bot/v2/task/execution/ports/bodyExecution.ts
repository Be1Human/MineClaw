import type { ExecutionOwner, OperationCommand, OperationIntent, OperationSnapshot, StopAcknowledgement } from '../../contracts/bodyOperation.js';
import type { OperationReceipt } from '../../contracts/operationReceipt.js';

declare const grantBrand: unique symbol;
/** A code-issued in-process capability, not a serializable model argument. */
export interface ExecutionGrant { readonly [grantBrand]: true }

export interface AuthorizedOperation {
  readonly intent: OperationIntent;
  readonly grant: ExecutionGrant;
}

export interface ExecutionAuthorityPort {
  /** Rechecked at admission and before/after every effect and child step. */
  allows(operation: AuthorizedOperation, command: OperationCommand): boolean;
}

export interface OperationHandle {
  readonly operationId: string;
  readonly result: Promise<OperationReceipt>;
  cancel(reason: string): void;
  quiesced(): Promise<StopAcknowledgement>;
}

export interface OwnerStopResult {
  readonly owner: ExecutionOwner;
  readonly status: 'quiesced' | 'in_doubt';
  readonly operations: readonly OperationSnapshot[];
}

export interface BodyExecutionPort {
  /** Rejection throws without acquiring resources or starting work. */
  submit(operation: AuthorizedOperation): OperationHandle;
  inspect(operationId: string): OperationSnapshot | null;
  cancelOwner(owner: ExecutionOwner, reason: string): Promise<OwnerStopResult>;
}

export interface ExecutionClock {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}
