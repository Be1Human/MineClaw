import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { jsonSnapshot } from '../../infra/jsonSnapshot.js';
import { openSqliteDatabase, type SqliteDatabase } from '../../infra/sqliteDatabase.js';
import type { OperationIdentity, OperationIntent, StopAcknowledgement } from '../contracts/bodyOperation.js';
import type { OperationEffect, OperationReceipt } from '../contracts/operationReceipt.js';

export type OperationLedgerStatus =
  | 'running'
  | 'cancel_requested'
  | 'stopped'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'ready_to_retry'
  | 'in_doubt';

export interface OperationLedgerRecord {
  readonly operationId: string;
  readonly intent: OperationIntent | null;
  readonly intentHash: string;
  readonly argsHash: string | null;
  readonly grantHash: string | null;
  readonly identity: OperationIdentity | null;
  readonly parentOperationId: string | null;
  readonly status: OperationLedgerStatus;
  readonly effects: readonly OperationEffect[];
  readonly stop: StopAcknowledgement | null;
  readonly receipt: OperationReceipt | null;
  readonly startedAt: number;
  readonly cancelRequestedAt: number | null;
  readonly cancelReason: string | null;
  readonly completedAt: number | null;
  readonly recoveryReason: string | null;
  readonly source: {
    readonly pluginId: string | null;
    readonly pluginVersion: string | null;
    readonly contributionId: string | null;
    readonly contributionVersion: string | null;
    readonly generationId: string | null;
    readonly buildId: string | null;
    readonly graphHash: string | null;
  };
}

export type OperationLedgerBegin =
  | { readonly status: 'new' }
  | { readonly status: 'completed'; readonly receipt: OperationReceipt }
  | { readonly status: 'in_doubt'; readonly record: OperationLedgerRecord };

export type OperationReadbackVerdict =
  | { readonly status: 'completed'; readonly effects: readonly OperationEffect[]; readonly evidenceRefs: readonly string[]; readonly reason: string; readonly at: number }
  | { readonly status: 'not_started'; readonly evidenceRefs: readonly string[]; readonly reason: string; readonly at: number }
  | { readonly status: 'unknown'; readonly evidenceRefs: readonly string[]; readonly reason: string; readonly at: number };

export interface OperationLedgerPort {
  begin(input: {
    readonly intent: OperationIntent;
    readonly identity: OperationIdentity;
    readonly grantHash: string;
    readonly parentOperationId?: string;
    readonly startedAt: number;
  }): OperationLedgerBegin;
  recordEffect(operationId: string, effect: OperationEffect, at: number): void;
  requestCancel(operationId: string, reason: string, at: number): void;
  acknowledgeStop(operationId: string, stop: StopAcknowledgement): void;
  markInDoubt(operationId: string, reason: string, at: number): void;
  complete(receipt: OperationReceipt): void;
  reconcile(operationId: string, verdict: OperationReadbackVerdict): OperationLedgerRecord;
  get(operationId: string): OperationLedgerRecord | null;
  listInDoubt(): readonly OperationLedgerRecord[];
}

interface OperationRow {
  operation_id: string;
  intent_json: string;
  intent_hash: string;
  args_hash: string | null;
  grant_hash: string | null;
  identity_json: string | null;
  parent_operation_id: string | null;
  status: OperationLedgerStatus;
  effects_json: string;
  stop_json: string | null;
  receipt_json: string | null;
  started_at: number;
  cancel_requested_at: number | null;
  cancel_reason: string | null;
  completed_at: number | null;
  recovery_reason: string | null;
  plugin_id: string | null;
  plugin_version: string | null;
  contribution_id: string | null;
  contribution_version: string | null;
  generation_id: string | null;
  build_id: string | null;
  graph_hash: string | null;
}

const TERMINAL = new Set<OperationLedgerStatus>(['succeeded', 'failed', 'cancelled']);

/**
 * The sole durable fact source for physical operations. It records a logical
 * operation before dispatch and never infers that a non-terminal crash window
 * is safe to replay. Recovery may only close such a row with observed proof.
 */
export class OperationLedger implements OperationLedgerPort {
  private readonly db: SqliteDatabase;

  constructor(filename: string) {
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
    this.db = openSqliteDatabase(filename);
    if (filename !== ':memory:') this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.migrate();
  }

  begin(input: {
    readonly intent: OperationIntent;
    readonly identity: OperationIdentity;
    readonly grantHash: string;
    readonly parentOperationId?: string;
    readonly startedAt: number;
  }): OperationLedgerBegin {
    const intent = jsonSnapshot(input.intent);
    const identity = jsonSnapshot(input.identity);
    const intentJson = canonicalJson(intent);
    const intentHash = digest(intentJson);
    const grantHash = requiredText(input.grantHash, 'operation_grant_hash_required');
    const parentOperationId = input.parentOperationId?.trim() || null;
    const source = intent.command.ref.contribution;
    const snapshot = intent.command.snapshot;
    return this.db.transaction(() => {
      const existing = this.row(intent.operationId);
      if (existing) {
        if (existing.intent_hash !== intentHash || existing.intent_json !== intentJson || existing.grant_hash !== grantHash) {
          throw new Error(`operation_identity_conflict:${intent.operationId}`);
        }
        if (existing.receipt_json && TERMINAL.has(existing.status)) {
          const receipt = parseJson<OperationReceipt>(existing.receipt_json, 'operation_receipt_corrupt');
          return { status: 'completed' as const, receipt: jsonSnapshot(receipt) };
        }
        if (existing.status === 'ready_to_retry') {
          this.db.prepare(`
            UPDATE operation_ledger SET identity_json=?,status='running',effects_json='[]',stop_json=NULL,receipt_json=NULL,
              started_at=?,cancel_requested_at=NULL,cancel_reason=NULL,completed_at=NULL,recovery_reason=NULL,updated_at=? WHERE operation_id=?
          `).run(canonicalJson(identity), input.startedAt, input.startedAt, intent.operationId);
          return { status: 'new' as const };
        }
        if (existing.status !== 'in_doubt') {
          this.db.prepare(`UPDATE operation_ledger SET status='in_doubt', recovery_reason=?, updated_at=? WHERE operation_id=?`)
            .run(`process_restarted_during:${existing.status}`, input.startedAt, intent.operationId);
        }
        return { status: 'in_doubt' as const, record: this.getRequired(intent.operationId) };
      }
      this.db.prepare(`
        INSERT INTO operation_ledger (
          operation_id,intent_json,intent_hash,args_hash,grant_hash,identity_json,parent_operation_id,status,effects_json,
          stop_json,receipt_json,started_at,cancel_requested_at,cancel_reason,completed_at,recovery_reason,
          plugin_id,plugin_version,contribution_id,contribution_version,generation_id,build_id,graph_hash,updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'running', '[]', NULL, NULL, ?, NULL, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        intent.operationId, intentJson, intentHash, operationArgsHash(intent.command.args), grantHash, canonicalJson(identity), parentOperationId,
        input.startedAt, source.pluginId, source.pluginVersion, source.contributionId, source.contributionVersion,
        snapshot.generationId, snapshot.buildId, snapshot.graphHash, input.startedAt,
      );
      return { status: 'new' as const };
    })();
  }

  recordEffect(operationId: string, effect: OperationEffect, at: number): void {
    const copy = jsonSnapshot(effect);
    if (!copy.predicate?.id || !copy.predicate.version || !Array.isArray(copy.evidenceRefs)) throw new Error('invalid_operation_effect');
    this.db.transaction(() => {
      const row = this.rowRequired(operationId);
      if (TERMINAL.has(row.status)) throw new Error(`operation_already_terminal:${operationId}`);
      const effects = parseJson<OperationEffect[]>(row.effects_json, 'operation_effects_corrupt');
      effects.push(copy);
      this.db.prepare(`UPDATE operation_ledger SET effects_json=?,updated_at=? WHERE operation_id=?`)
        .run(canonicalJson(effects), at, operationId);
    })();
  }

  requestCancel(operationId: string, reason: string, at: number): void {
    this.transitionNonTerminal(operationId, row => ({
      status: row.status === 'in_doubt' ? 'in_doubt' : 'cancel_requested',
      cancelRequestedAt: row.cancel_requested_at ?? at,
      cancelReason: row.cancel_reason ?? requiredText(reason, 'operation_cancel_reason_required'),
      recoveryReason: row.recovery_reason,
    }), at);
  }

  acknowledgeStop(operationId: string, stop: StopAcknowledgement): void {
    const copy = jsonSnapshot(stop);
    if (copy.operationId !== operationId || copy.state !== 'quiesced') throw new Error('operation_stop_identity_mismatch');
    this.transitionNonTerminal(operationId, row => ({
      status: row.status === 'in_doubt' ? 'in_doubt' : 'stopped',
      stop: canonicalJson(copy),
      recoveryReason: row.recovery_reason,
    }), copy.at);
  }

  markInDoubt(operationId: string, reason: string, at: number): void {
    this.transitionNonTerminal(operationId, () => ({
      status: 'in_doubt', recoveryReason: requiredText(reason, 'operation_recovery_reason_required'),
    }), at);
  }

  complete(receipt: OperationReceipt): void {
    const copy = jsonSnapshot(receipt);
    if (!TERMINAL.has(copy.status)) throw new Error('operation_terminal_receipt_required');
    this.db.transaction(() => {
      const row = this.rowRequired(copy.operationId);
      if (!row.identity_json) throw new Error(`operation_source_unproven:${copy.operationId}`);
      const identity = parseJson<OperationIdentity>(row.identity_json, 'operation_identity_corrupt');
      if (canonicalJson(identity) !== canonicalJson(operationIdentityOf(copy))) throw new Error('operation_receipt_identity_mismatch');
      if (!row.args_hash || !row.grant_hash || !copy.source
        || copy.source.commandId !== parseJson<OperationIntent>(row.intent_json, 'operation_intent_corrupt').command.ref.id
        || copy.source.argsHash !== row.args_hash || copy.source.grantHash !== row.grant_hash
        || copy.source.contribution.pluginId !== row.plugin_id || copy.source.contribution.pluginVersion !== row.plugin_version
        || copy.source.contribution.contributionId !== row.contribution_id || copy.source.contribution.contributionVersion !== row.contribution_version
        || copy.source.snapshot.generationId !== row.generation_id || copy.source.snapshot.buildId !== row.build_id
        || copy.source.snapshot.graphHash !== row.graph_hash) throw new Error('operation_receipt_source_mismatch');
      if (row.receipt_json) {
        if (row.receipt_json !== canonicalJson(copy)) throw new Error(`operation_terminal_conflict:${copy.operationId}`);
        return;
      }
      this.db.prepare(`
        UPDATE operation_ledger SET status=?,effects_json=?,stop_json=?,receipt_json=?,completed_at=?,recovery_reason=NULL,updated_at=?
        WHERE operation_id=?
      `).run(copy.status, canonicalJson(copy.effects), copy.stop ? canonicalJson(copy.stop) : null,
        canonicalJson(copy), copy.completedAt, copy.completedAt, copy.operationId);
    })();
  }

  reconcile(operationId: string, verdict: OperationReadbackVerdict): OperationLedgerRecord {
    const evidenceRefs = [...new Set(verdict.evidenceRefs.map(value => value.trim()).filter(Boolean))];
    if (!evidenceRefs.length) throw new Error('operation_reconciliation_evidence_required');
    const existing = this.getRequired(operationId);
    if (existing.receipt) return existing;
    if (!existing.identity || !existing.intent || !existing.grantHash) throw new Error(`needs_rebind:operation_source_unproven:${operationId}`);
    if (verdict.status === 'unknown') {
      this.markInDoubt(operationId, `readback_unknown:${verdict.reason}`, verdict.at);
      return this.getRequired(operationId);
    }
    if (verdict.status === 'not_started') {
      if (existing.effects.length || existing.stop) throw new Error(`operation_not_started_conflicts_with_effect_evidence:${operationId}`);
      this.db.prepare(`UPDATE operation_ledger SET status='ready_to_retry',recovery_reason=?,updated_at=? WHERE operation_id=?`)
        .run(`readback_confirmed_not_started:${verdict.reason}:${evidenceRefs.join(',')}`, verdict.at, operationId);
      return this.getRequired(operationId);
    }
    const effects = verdict.effects.map(effect => jsonSnapshot(effect));
    const stop: StopAcknowledgement = existing.stop ?? jsonSnapshot({ ...existing.identity, state: 'quiesced' as const, at: verdict.at });
    this.complete(jsonSnapshot({
      ...existing.identity, schema: 'mineclaw.operation-receipt/v2' as const,
      source:{commandId:existing.intent.command.ref.id,contribution:existing.intent.command.ref.contribution,
        snapshot:existing.intent.command.snapshot,argsHash:existing.argsHash!,grantHash:existing.grantHash},
      status: 'succeeded' as const, stop,
      noOp: false, effects, evidenceRefs, startedAt: existing.startedAt, completedAt: verdict.at,
      details: { recoveredByReadback: true, reason: verdict.reason },
    }));
    return this.getRequired(operationId);
  }

  get(operationId: string): OperationLedgerRecord | null {
    const row = this.row(operationId);
    return row ? fromRow(row) : null;
  }

  listInDoubt(): readonly OperationLedgerRecord[] {
    const rows = this.db.prepare(`SELECT * FROM operation_ledger WHERE status='in_doubt' ORDER BY started_at,operation_id`).all() as OperationRow[];
    return rows.map(fromRow);
  }

  close(): void { this.db.close(); }

  private transitionNonTerminal(
    operationId: string,
    transition: (row: OperationRow) => {
      status: OperationLedgerStatus;
      cancelRequestedAt?: number | null;
      cancelReason?: string | null;
      stop?: string | null;
      recoveryReason?: string | null;
    },
    at: number,
  ): void {
    this.db.transaction(() => {
      const row = this.rowRequired(operationId);
      if (TERMINAL.has(row.status)) return;
      const next = transition(row);
      this.db.prepare(`
        UPDATE operation_ledger SET status=?,cancel_requested_at=?,cancel_reason=?,stop_json=?,recovery_reason=?,updated_at=? WHERE operation_id=?
      `).run(next.status, next.cancelRequestedAt ?? row.cancel_requested_at, next.cancelReason ?? row.cancel_reason, next.stop ?? row.stop_json,
        next.recoveryReason ?? row.recovery_reason, at, operationId);
    })();
  }

  private row(operationId: string): OperationRow | undefined {
    return this.db.prepare(`SELECT * FROM operation_ledger WHERE operation_id=?`).get(operationId) as OperationRow | undefined;
  }

  private rowRequired(operationId: string): OperationRow {
    const row = this.row(operationId);
    if (!row) throw new Error(`operation_not_recorded:${operationId}`);
    return row;
  }

  private getRequired(operationId: string): OperationLedgerRecord { return fromRow(this.rowRequired(operationId)); }

  private migrate(): void {
    this.db.transaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS operation_ledger (
          operation_id TEXT PRIMARY KEY,
          intent_json TEXT NOT NULL,
          intent_hash TEXT NOT NULL,
          args_hash TEXT,
          grant_hash TEXT,
          identity_json TEXT,
          parent_operation_id TEXT,
          status TEXT NOT NULL CHECK(status IN ('running','cancel_requested','stopped','succeeded','failed','cancelled','ready_to_retry','in_doubt')),
          effects_json TEXT NOT NULL,
          stop_json TEXT,
          receipt_json TEXT,
          started_at INTEGER NOT NULL,
          cancel_requested_at INTEGER,
          cancel_reason TEXT,
          completed_at INTEGER,
          recovery_reason TEXT,
          plugin_id TEXT,
          plugin_version TEXT,
          contribution_id TEXT,
          contribution_version TEXT,
          generation_id TEXT,
          build_id TEXT,
          graph_hash TEXT,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_operation_ledger_owner ON operation_ledger(started_at,operation_id);
        CREATE INDEX IF NOT EXISTS idx_operation_ledger_recovery ON operation_ledger(status,started_at);
      `);
      if (this.tableExists('goal_agent_actions')) {
        const legacy = this.db.prepare(`SELECT * FROM goal_agent_actions ORDER BY started_at,idempotency_key`).all() as Array<{
          idempotency_key: string; session_id: string; epoch: number; status: string; proposal_json: string;
          result_json: string | null; started_at: string; completed_at: string | null;
        }>;
        const insert = this.db.prepare(`
        INSERT OR IGNORE INTO operation_ledger (
          operation_id,intent_json,intent_hash,args_hash,grant_hash,identity_json,parent_operation_id,status,effects_json,
          stop_json,receipt_json,started_at,cancel_requested_at,cancel_reason,completed_at,recovery_reason,
          plugin_id,plugin_version,contribution_id,contribution_version,generation_id,build_id,graph_hash,updated_at
        ) VALUES (?, ?, ?, NULL, NULL, NULL, NULL, 'in_doubt', '[]', NULL, NULL, ?, NULL, NULL, NULL,
          'needs_rebind:legacy_source_unproven', NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?)
        `);
        for (const row of legacy) {
          const legacyIntent = canonicalJson({
            schema: 'mineclaw.legacy-goal-action/v1', operationId: row.idempotency_key,
            owner: { kind: 'goal', sessionId: row.session_id, epoch: row.epoch },
            proposal: parseJson<unknown>(row.proposal_json, 'legacy_proposal_corrupt'),
            legacyStatus: row.status, legacyResult: row.result_json ? parseJson<unknown>(row.result_json, 'legacy_result_corrupt') : null,
          });
          const startedAt = timestamp(row.started_at);
          insert.run(row.idempotency_key, legacyIntent, digest(legacyIntent), startedAt, startedAt);
        }
        if (this.tableExists('goal_agent_actions_legacy_readonly')) throw new Error('legacy_operation_ledger_table_conflict');
        this.db.exec(`ALTER TABLE goal_agent_actions RENAME TO goal_agent_actions_legacy_readonly`);
      }
      this.db.prepare(`
        UPDATE operation_ledger SET status='in_doubt',
          recovery_reason='process_restarted_during:' || status,updated_at=MAX(updated_at,started_at)
        WHERE status IN ('running','cancel_requested','stopped')
      `).run();
    })();
  }

  private tableExists(name: string): boolean {
    return !!this.db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(name);
  }
}

function fromRow(row: OperationRow): OperationLedgerRecord {
  const intent = row.identity_json ? parseJson<OperationIntent>(row.intent_json, 'operation_intent_corrupt') : null;
  return jsonSnapshot({
    operationId: row.operation_id, intent, intentHash: row.intent_hash, argsHash: row.args_hash, grantHash: row.grant_hash,
    identity: row.identity_json ? parseJson<OperationIdentity>(row.identity_json, 'operation_identity_corrupt') : null,
    parentOperationId: row.parent_operation_id, status: row.status,
    effects: parseJson<OperationEffect[]>(row.effects_json, 'operation_effects_corrupt'),
    stop: row.stop_json ? parseJson<StopAcknowledgement>(row.stop_json, 'operation_stop_corrupt') : null,
    receipt: row.receipt_json ? parseJson<OperationReceipt>(row.receipt_json, 'operation_receipt_corrupt') : null,
    startedAt: row.started_at, cancelRequestedAt: row.cancel_requested_at, cancelReason:row.cancel_reason, completedAt: row.completed_at,
    recoveryReason: row.recovery_reason,
    source: {
      pluginId: row.plugin_id, pluginVersion: row.plugin_version,
      contributionId: row.contribution_id, contributionVersion: row.contribution_version,
      generationId: row.generation_id, buildId: row.build_id, graphHash: row.graph_hash,
    },
  });
}

function operationIdentityOf(receipt: OperationReceipt): OperationIdentity {
  return {
    operationId: receipt.operationId, owner: receipt.owner, leaseRef: receipt.leaseRef,
    operationEpoch: receipt.operationEpoch, deadlineAt: receipt.deadlineAt,
  };
}

function canonicalJson(value: unknown): string { return JSON.stringify(canonical(value)); }
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonical(nested)]),
  );
  return value;
}
function digest(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function requiredText(value: string, code: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(code);
  return normalized;
}
function parseJson<T>(value: string, code: string): T {
  try { return JSON.parse(value) as T; } catch { throw new Error(code); }
}
function timestamp(value: string | null): number {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

export function operationArgsHash(args: Readonly<Record<string, unknown>>): string {
  return digest(canonicalJson(jsonSnapshot(args)));
}
