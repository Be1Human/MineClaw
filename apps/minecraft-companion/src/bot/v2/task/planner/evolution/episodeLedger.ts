/**
 * FEAT-CROSS-12 · 规划经验不可变证据账本。
 *
 * 账本只消费 execution facts；不会从日志文本推导终态，也不会向执行侧发命令。
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { openSqliteDatabase, type SqliteDatabase } from '../../../infra/sqliteDatabase.js';
import {
  terminalPayloadV1,
  type ExecutionFactEnvelopeV1,
  type LeafOutcomeV1,
} from './contracts/executionFactsV1.js';

export type EpisodeState = 'open' | 'awaiting_facts' | 'finalized';

export interface PlannerLeafEpisode {
  sessionId: string;
  runId: string;
  planRunId: string;
  planRevision: number;
  nodeId: string;
  state: EpisodeState;
  firstSequence: number;
  lastContiguousSequence: number;
  maxSequence: number;
  terminalSequence?: number;
  outcome?: LeafOutcomeV1;
  facts: ExecutionFactEnvelopeV1[];
}

export type AppendFactResult =
  | { kind: 'accepted'; state: EpisodeState; finalizedNow: boolean }
  | { kind: 'duplicate' }
  | { kind: 'quarantined'; reason: string };

export interface QuarantinedFact {
  id: number;
  eventId?: string;
  sessionId?: string;
  reason: string;
  raw: unknown;
  receivedAt: string;
}

interface FactRow {
  event_id: string;
  raw_json: string;
}

interface SequenceRow extends FactRow {
  sequence: number;
}

interface SessionRow {
  session_id: string;
  run_id: string;
  plan_run_id: string;
  plan_revision: number;
  node_id: string;
  state: EpisodeState;
  first_sequence: number;
  last_contiguous_sequence: number;
  max_sequence: number;
  terminal_sequence: number | null;
  terminal_event_id: string | null;
  outcome: LeafOutcomeV1 | null;
}

interface QuarantineRow {
  id: number;
  event_id: string | null;
  session_id: string | null;
  reason: string;
  raw_json: string;
  received_at: string;
}

export class EpisodeLedger {
  private readonly db: SqliteDatabase;

  constructor(dbPath = 'data/planner-evolution.db') {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.db = openSqliteDatabase(dbPath);
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    if (dbPath !== ':memory:') this.db.pragma('journal_mode = WAL');
    this.initSchema();
  }

  appendFact(fact: ExecutionFactEnvelopeV1): AppendFactResult {
    return this.db.transaction((): AppendFactResult => {
      const canonical = stableStringify(fact);
      const byId = this.db.prepare(
        'SELECT event_id, raw_json FROM planner_execution_facts WHERE event_id = ?',
      ).get(fact.eventId) as FactRow | undefined;
      if (byId) {
        if (byId.raw_json === canonical) return { kind: 'duplicate' };
        return this.quarantineInTransaction(fact, 'event_id_conflict');
      }

      const bySequence = this.db.prepare(`
        SELECT event_id, sequence, raw_json
        FROM planner_execution_facts
        WHERE session_id = ? AND sequence = ?
      `).get(fact.sessionId, fact.sequence) as SequenceRow | undefined;
      if (bySequence) {
        if (bySequence.raw_json === canonical) return { kind: 'duplicate' };
        return this.quarantineInTransaction(fact, 'sequence_conflict');
      }

      const existing = this.sessionRow(fact.sessionId);
      const isTerminal = fact.eventType === 'execution.session.terminal';
      if (existing?.terminal_sequence != null) {
        if (isTerminal) return this.quarantineInTransaction(fact, 'terminal_conflict');
        if (
          fact.sequence > existing.terminal_sequence
          && fact.eventType !== 'execution.late_result_ignored'
        ) {
          return this.quarantineInTransaction(fact, 'event_after_terminal');
        }
      }

      this.db.prepare(`
        INSERT INTO planner_execution_facts (
          event_id, schema, event_type, session_id, run_id, plan_run_id,
          plan_revision, node_id, sequence, occurred_at, code_revision,
          config_revision, causation_id, correlation_id, raw_json, received_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        fact.eventId,
        fact.schema,
        fact.eventType,
        fact.sessionId,
        fact.runId,
        fact.planRunId,
        fact.planRevision,
        fact.nodeId,
        fact.sequence,
        fact.occurredAt,
        fact.codeRevision,
        fact.configRevision,
        fact.causationId ?? null,
        fact.correlationId,
        canonical,
        new Date().toISOString(),
      );

      const terminal = terminalPayloadV1(fact);
      const terminalSequence = terminal ? fact.sequence : existing?.terminal_sequence ?? null;
      const terminalEventId = terminal ? fact.eventId : existing?.terminal_event_id ?? null;
      const outcome = terminal?.outcome ?? existing?.outcome ?? null;
      const firstSequence = Math.min(existing?.first_sequence ?? fact.sequence, fact.sequence);
      const maxSequence = Math.max(existing?.max_sequence ?? fact.sequence, fact.sequence);
      const lastContiguousSequence = this.computeLastContiguous(fact.sessionId);
      const state = this.computeState(fact.sessionId, terminalSequence);
      const finalizedNow = state === 'finalized' && existing?.state !== 'finalized';

      this.db.prepare(`
        INSERT INTO planner_episode_sessions (
          session_id, run_id, plan_run_id, plan_revision, node_id, state,
          first_sequence, last_contiguous_sequence, max_sequence,
          terminal_sequence, terminal_event_id, outcome, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          state = excluded.state,
          first_sequence = excluded.first_sequence,
          last_contiguous_sequence = excluded.last_contiguous_sequence,
          max_sequence = excluded.max_sequence,
          terminal_sequence = excluded.terminal_sequence,
          terminal_event_id = excluded.terminal_event_id,
          outcome = excluded.outcome,
          updated_at = excluded.updated_at
      `).run(
        fact.sessionId,
        existing?.run_id ?? fact.runId,
        existing?.plan_run_id ?? fact.planRunId,
        existing?.plan_revision ?? fact.planRevision,
        existing?.node_id ?? fact.nodeId,
        state,
        firstSequence,
        lastContiguousSequence,
        maxSequence,
        terminalSequence,
        terminalEventId,
        outcome,
        new Date().toISOString(),
      );

      return { kind: 'accepted', state, finalizedNow };
    })();
  }

  quarantine(raw: unknown, reason: string): { kind: 'quarantined'; reason: string } {
    return this.db.transaction(() => this.quarantineInTransaction(raw, reason))();
  }

  getEpisode(sessionId: string): PlannerLeafEpisode | null {
    const session = this.sessionRow(sessionId);
    if (!session) return null;
    const rows = this.db.prepare(`
      SELECT raw_json
      FROM planner_execution_facts
      WHERE session_id = ?
      ORDER BY sequence ASC
    `).all(sessionId) as Array<{ raw_json: string }>;

    return {
      sessionId: session.session_id,
      runId: session.run_id,
      planRunId: session.plan_run_id,
      planRevision: session.plan_revision,
      nodeId: session.node_id,
      state: session.state,
      firstSequence: session.first_sequence,
      lastContiguousSequence: session.last_contiguous_sequence,
      maxSequence: session.max_sequence,
      ...(session.terminal_sequence == null ? {} : { terminalSequence: session.terminal_sequence }),
      ...(session.outcome == null ? {} : { outcome: session.outcome }),
      facts: rows.map(row => JSON.parse(row.raw_json) as ExecutionFactEnvelopeV1),
    };
  }

  listEpisodes(options: { state?: EpisodeState; limit?: number } = {}): PlannerLeafEpisode[] {
    const limit = Math.min(10_000, Math.max(1, Math.floor(options.limit ?? 1_000)));
    const rows = options.state
      ? this.db.prepare(`
          SELECT session_id FROM planner_episode_sessions
          WHERE state = ? ORDER BY updated_at ASC LIMIT ?
        `).all(options.state, limit) as Array<{ session_id: string }>
      : this.db.prepare(`
          SELECT session_id FROM planner_episode_sessions
          ORDER BY updated_at ASC LIMIT ?
        `).all(limit) as Array<{ session_id: string }>;
    return rows
      .map(row => this.getEpisode(row.session_id))
      .filter((episode): episode is PlannerLeafEpisode => episode != null);
  }

  listQuarantine(limit = 100): QuarantinedFact[] {
    const rows = this.db.prepare(`
      SELECT id, event_id, session_id, reason, raw_json, received_at
      FROM planner_fact_quarantine
      ORDER BY id DESC
      LIMIT ?
    `).all(limit) as QuarantineRow[];
    return rows.map(row => ({
      id: row.id,
      ...(row.event_id ? { eventId: row.event_id } : {}),
      ...(row.session_id ? { sessionId: row.session_id } : {}),
      reason: row.reason,
      raw: safeParse(row.raw_json),
      receivedAt: row.received_at,
    }));
  }

  getCursor(consumerId: string): string | null {
    const row = this.db.prepare(
      'SELECT cursor FROM planner_ingest_cursors WHERE consumer_id = ?',
    ).get(consumerId) as { cursor: string } | undefined;
    return row?.cursor ?? null;
  }

  setCursor(consumerId: string, cursor: string): void {
    this.db.prepare(`
      INSERT INTO planner_ingest_cursors (consumer_id, cursor, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(consumer_id) DO UPDATE SET
        cursor = excluded.cursor,
        updated_at = excluded.updated_at
    `).run(consumerId, cursor, new Date().toISOString());
  }

  close(): void {
    this.db.close();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS planner_execution_facts (
        event_id TEXT PRIMARY KEY,
        schema TEXT NOT NULL,
        event_type TEXT NOT NULL,
        session_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        plan_run_id TEXT NOT NULL,
        plan_revision INTEGER NOT NULL,
        node_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        occurred_at TEXT NOT NULL,
        code_revision TEXT NOT NULL,
        config_revision TEXT NOT NULL,
        causation_id TEXT,
        correlation_id TEXT NOT NULL,
        raw_json TEXT NOT NULL,
        received_at TEXT NOT NULL,
        UNIQUE(session_id, sequence)
      );

      CREATE INDEX IF NOT EXISTS idx_planner_facts_plan
        ON planner_execution_facts(plan_run_id, plan_revision, node_id);

      CREATE TABLE IF NOT EXISTS planner_episode_sessions (
        session_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        plan_run_id TEXT NOT NULL,
        plan_revision INTEGER NOT NULL,
        node_id TEXT NOT NULL,
        state TEXT NOT NULL,
        first_sequence INTEGER NOT NULL,
        last_contiguous_sequence INTEGER NOT NULL,
        max_sequence INTEGER NOT NULL,
        terminal_sequence INTEGER,
        terminal_event_id TEXT,
        outcome TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS planner_fact_quarantine (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT,
        session_id TEXT,
        reason TEXT NOT NULL,
        raw_json TEXT NOT NULL,
        received_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS planner_ingest_cursors (
        consumer_id TEXT PRIMARY KEY,
        cursor TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    this.db.pragma('user_version = 1');
  }

  private sessionRow(sessionId: string): SessionRow | undefined {
    return this.db.prepare(`
      SELECT session_id, run_id, plan_run_id, plan_revision, node_id, state,
        first_sequence, last_contiguous_sequence, max_sequence,
        terminal_sequence, terminal_event_id, outcome
      FROM planner_episode_sessions
      WHERE session_id = ?
    `).get(sessionId) as SessionRow | undefined;
  }

  private computeLastContiguous(sessionId: string): number {
    const rows = this.db.prepare(`
      SELECT sequence
      FROM planner_execution_facts
      WHERE session_id = ?
      ORDER BY sequence ASC
    `).all(sessionId) as Array<{ sequence: number }>;
    let expected = 1;
    for (const row of rows) {
      if (row.sequence !== expected) break;
      expected += 1;
    }
    return expected - 1;
  }

  private computeState(sessionId: string, terminalSequence: number | null): EpisodeState {
    if (terminalSequence == null) return 'open';
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM planner_execution_facts
      WHERE session_id = ? AND sequence BETWEEN 1 AND ?
    `).get(sessionId, terminalSequence) as { count: number };
    return row.count === terminalSequence ? 'finalized' : 'awaiting_facts';
  }

  private quarantineInTransaction(raw: unknown, reason: string): { kind: 'quarantined'; reason: string } {
    const record = isRecord(raw) ? raw : null;
    this.db.prepare(`
      INSERT INTO planner_fact_quarantine (
        event_id, session_id, reason, raw_json, received_at
      ) VALUES (?, ?, ?, ?, ?)
    `).run(
      stringOrNull(record?.eventId),
      stringOrNull(record?.sessionId),
      reason,
      stableStringify(raw),
      new Date().toISOString(),
    );
    return { kind: 'quarantined', reason };
  }
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortJson(value)) ?? 'null';
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value).sort().map(key => [key, sortJson(value[key])]),
  );
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}
