import type { PredicateRef } from './goalDraft.js';
import type { FailureEnvelope } from './failureEnvelope.js';
import type { OperationIdentity, StopAcknowledgement } from './bodyOperation.js';
import type { ContributionRef, RegistrySnapshotRef } from '../../plugin-sdk/identity.js';

export interface OperationReceiptSource {
  readonly commandId: string;
  readonly contribution: ContributionRef;
  readonly snapshot: RegistrySnapshotRef;
  readonly argsHash: string;
  readonly grantHash: string;
}

export interface OperationEffect {
  readonly predicate: PredicateRef;
  readonly evidenceRefs: readonly string[];
}

export interface OperationReceipt extends OperationIdentity {
  readonly schema: 'mineclaw.operation-receipt/v2';
  readonly source: OperationReceiptSource;
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
