import type { OperationLedgerPort, OperationLedgerRecord, OperationReadbackVerdict } from './operationLedger.js';

export interface OperationReadbackPort {
  /** Must resolve facts and predicates from record.intent.command.snapshot only. */
  readback(record: OperationLedgerRecord, signal: AbortSignal): Promise<OperationReadbackVerdict>;
}

export interface OperationRecoveryResult {
  readonly operationId: string;
  readonly status: 'recovered' | 'ready_to_retry' | 'in_doubt' | 'needs_rebind';
  readonly reason: string;
}

/** Coordinates observation-only crash recovery. It never submits body work. */
export class OperationRecoveryCoordinator {
  constructor(private readonly ledger: OperationLedgerPort, private readonly readback: OperationReadbackPort) {}

  async recover(signal: AbortSignal): Promise<readonly OperationRecoveryResult[]> {
    const results: OperationRecoveryResult[] = [];
    for (const record of this.ledger.listInDoubt()) {
      if (signal.aborted) break;
      if (!fixedSource(record)) {
        results.push({ operationId: record.operationId, status: 'needs_rebind', reason: record.recoveryReason ?? 'source_unproven' });
        continue;
      }
      try {
        const verdict = await this.readback.readback(record, signal);
        if (signal.aborted) break;
        const reconciled = this.ledger.reconcile(record.operationId, verdict);
        results.push({
          operationId: record.operationId,
          status: reconciled.status === 'succeeded' ? 'recovered'
            : reconciled.status === 'ready_to_retry' ? 'ready_to_retry' : 'in_doubt',
          reason: reconciled.recoveryReason ?? verdict.reason,
        });
      } catch (error) {
        if (signal.aborted) break;
        const reason = error instanceof Error ? error.message : String(error);
        try { this.ledger.markInDoubt(record.operationId, `readback_failed:${reason}`, Date.now()); } catch { /* original row remains in_doubt */ }
        results.push({ operationId: record.operationId, status: 'in_doubt', reason });
      }
    }
    return results;
  }
}

function fixedSource(record: OperationLedgerRecord): boolean {
  if (!record.intent || !record.identity || !record.grantHash) return false;
  const contribution = record.intent.command.ref.contribution;
  const snapshot = record.intent.command.snapshot;
  return record.source.pluginId === contribution.pluginId
    && record.source.pluginVersion === contribution.pluginVersion
    && record.source.contributionId === contribution.contributionId
    && record.source.contributionVersion === contribution.contributionVersion
    && record.source.generationId === snapshot.generationId
    && record.source.buildId === snapshot.buildId
    && record.source.graphHash === snapshot.graphHash;
}
