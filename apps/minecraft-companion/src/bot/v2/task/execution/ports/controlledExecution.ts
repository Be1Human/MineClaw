import type { OperationCommand, OperationIdentity, OperationIntent } from '../../contracts/bodyOperation.js';
import type { OperationEffect } from '../../contracts/operationReceipt.js';
import type { FailureEnvelope } from '../../contracts/failureEnvelope.js';

export interface OperationOutcome {
  readonly ok: boolean;
  readonly failure?: FailureEnvelope;
  readonly details?: Readonly<Record<string, unknown>>;
}

/** Required by every executor; only the owning runtime creates one. */
export interface ControlledExecutionContext extends OperationIdentity {
  readonly stepId: string;
  readonly command: OperationCommand;
  readonly scope: OperationIntent['scope'];
  readonly signal: AbortSignal;
  assertCurrent(stage?: string): void;
  /** Children share the lease; they cannot widen resources or authority. */
  execute(command: OperationCommand): Promise<OperationOutcome>;
  /** Start and track one device effect; forbidden after cancellation. */
  effect<T>(run: () => T | PromiseLike<T>): Promise<T>;
  /** Abortable waiting does not certify that a device has stopped. */
  wait(ms: number): Promise<void>;
  /** Record world observations, including partial effects during cancellation. */
  recordEffect(effect: OperationEffect): void;
}

/** Binding is side-effect free. run and stop capture one device instance. */
export interface BoundOperationExecutor {
  run(context: ControlledExecutionContext): Promise<OperationOutcome>;
  /** Resolves only after device cleanup; an error never confirms release. */
  stop(reason: string): Promise<void>;
}

export interface BodyOperationDriver {
  /** Code-owned declaration, not an unvalidated caller resource list. */
  resources(command: OperationCommand): readonly string[];
  bind(identity: OperationIdentity, command: OperationCommand): BoundOperationExecutor;
}
