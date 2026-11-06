import type { FailureEnvelope } from '../../task/contracts/failureEnvelope.js';

/** Command knowledge is independent of whether its device has quiesced. */
export type ExecutionSettlement =
  | { readonly status: 'succeeded'; readonly details?: Readonly<Record<string, unknown>> }
  | { readonly status: 'failed' | 'in_doubt'; readonly failure: FailureEnvelope; readonly details?: Readonly<Record<string, unknown>> };

export function effectUnknown(detail: string): FailureEnvelope {
  return { code: 'execution.effect_unknown', origin: 'atomic', stage: 'verifying', category: 'transient',
    retryable: false, ownerActionable: true, evidenceRefs: [], detail };
}

/** Fail closed at plugin/driver boundaries, including JavaScript implementations. */
export function isExecutionSettlement(value: unknown): value is ExecutionSettlement {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  if (result.status === 'succeeded') return true;
  if (result.status !== 'failed' && result.status !== 'in_doubt') return false;
  const f = result.failure as Record<string, unknown> | undefined;
  return !!f && typeof f.code === 'string' && typeof f.origin === 'string' && typeof f.stage === 'string'
    && typeof f.category === 'string' && typeof f.retryable === 'boolean' && typeof f.ownerActionable === 'boolean'
    && Array.isArray(f.evidenceRefs) && f.evidenceRefs.every(ref => typeof ref === 'string')
    && (result.status !== 'in_doubt' || f.retryable === false);
}
