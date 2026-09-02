import type { PredicateRef } from './goalDraft.js';
import type { FailureEnvelope } from './failureEnvelope.js';
import type { OperationIdentity, StopAcknowledgement } from './bodyOperation.js';

export interface OperationEffect {
  readonly predicate: PredicateRef;
  readonly evidenceRefs: readonly string[];
}

export interface OperationReceipt extends OperationIdentity {
  readonly schema: 'mineclaw.operation-receipt/v2';
  readonly status: 'succeeded' | 'failed' | 'cancelled' | 'in_doubt';
  /** null means unconfirmed, not stopped. quiesced() awaits actual drainage. */
  readonly stop: StopAcknowledgement | null;
  readonly noOp: boolean;
  readonly effects: readonly OperationEffect[];
  readonly evidenceRefs: readonly string[];
  readonly failure?: FailureEnvelope;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly startedAt: number;
  readonly completedAt: number;
}
