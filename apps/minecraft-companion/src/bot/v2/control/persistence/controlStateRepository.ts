import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { openSqliteDatabase, type SqliteDatabase } from '../../infra/sqliteDatabase.js';
import type { ControlEventInput, PersistedControlEvent } from '../contracts/controlEvent.js';
import { reduceControlEvent } from '../contracts/controlEvent.js';
import {
  assertGoalAgentControlAggregate,
  cloneControlAggregate,
  createInitialControlAggregate,
  type GoalAgentControlAggregate,
} from '../contracts/controlState.js';

export interface ControlRepositoryAppendRequest {
  companionId: string;
  expectedControlRevision: number;
  event: ControlEventInput;
}

export type ControlRepositoryAppendResult =
  | { kind: 'committed'; aggregate: GoalAgentControlAggregate; event: PersistedControlEvent }
  | { kind: 'idempotent_replay'; aggregate: GoalAgentControlAggregate; event: PersistedControlEvent }
  | {
      kind: 'rejected';
      reason: 'stale' | 'conflict' | 'invalid_transition';
      aggregate: GoalAgentControlAggregate;
      event: PersistedControlEvent;
    };

export interface ControlStateRepositoryPort {
  load(companionId: string): GoalAgentControlAggregate | null;
  initialize(companionId: string, reconcileId: string, now?: number): GoalAgentControlAggregate;
  append(request: ControlRepositoryAppendRequest): ControlRepositoryAppendResult;
  listEvents(companionId: string, afterEventSequence?: number): readonly PersistedControlEvent[];
  close(): void;
}

export class ControlStateRepository implements ControlStateRepositoryPort {
  private readonly db: SqliteDatabase;

  constructor(filename: string) {
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
    this.db = openSqliteDatabase(filename);
    if (filename !== ':memory:') this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS goal_agent_control_events (
        companion_id TEXT NOT NULL,
        event_sequence INTEGER NOT NULL,
        event_id TEXT NOT NULL,
        command_id TEXT NOT NULL,
        stage TEXT NOT NULL,
        work_id TEXT,
        step_id TEXT NOT NULL,
        root_command_digest TEXT NOT NULL,
        step_digest TEXT NOT NULL,
        idempotency_key TEXT,
        control_revision INTEGER,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        occurred_at INTEGER NOT NULL,
        PRIMARY KEY (companion_id, event_sequence),
        UNIQUE (companion_id, event_id)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS uq_goal_agent_control_committed_step
        ON goal_agent_control_events(companion_id, idempotency_key)
        WHERE idempotency_key IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_goal_agent_control_events_work
        ON goal_agent_control_events(companion_id, work_id, event_sequence);
      CREATE TABLE IF NOT EXISTS goal_agent_control_snapshots (
        companion_id TEXT PRIMARY KEY,
        control_revision INTEGER NOT NULL,
        last_event_sequence INTEGER NOT NULL,
        state_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  initialize(companionId: string, reconcileId: string, now = Date.now()): GoalAgentControlAggregate {
    return this.db.transaction(() => {
      const existing = this.load(companionId);
      if (existing) return existing;
      const aggregate = createInitialControlAggregate(companionId, {
        kind: 'system_reconcile',
        reconcileId,
      }, now);
      this.writeSnapshot(aggregate, now);
      return cloneControlAggregate(aggregate);
    })();
  }

  load(companionId: string): GoalAgentControlAggregate | null {
    const row = this.db.prepare(`
      SELECT state_json FROM goal_agent_control_snapshots WHERE companion_id = ?
    `).get(companionId) as { state_json: string } | undefined;
    if (!row) return null;
    const aggregate = JSON.parse(row.state_json) as GoalAgentControlAggregate;
    assertGoalAgentControlAggregate(aggregate);
    return cloneControlAggregate(aggregate);
  }

  append(request: ControlRepositoryAppendRequest): ControlRepositoryAppendResult {
    return this.db.transaction(() => this.appendInTransaction(request))();
  }

  listEvents(companionId: string, afterEventSequence = 0): readonly PersistedControlEvent[] {
    const rows = this.db.prepare(`
      SELECT companion_id, event_sequence, event_id, command_id, stage, work_id,
             step_id, root_command_digest, step_digest, control_revision,
             event_type, payload_json, occurred_at
      FROM goal_agent_control_events
      WHERE companion_id = ? AND event_sequence > ?
      ORDER BY event_sequence ASC
    `).all(companionId, afterEventSequence) as ControlEventRow[];
    return rows.map(rowToEvent);
  }

  replay(companionId: string): GoalAgentControlAggregate | null {
    const snapshot = this.load(companionId);
    if (!snapshot) return null;
    const base = createInitialControlAggregate(
      companionId,
      { kind: 'system_reconcile', reconcileId: `replay:${companionId}` },
      snapshot.state.updatedAt,
    );
    return this.listEvents(companionId).reduce(reduceControlEvent, base);
  }

  close(): void {
    this.db.close();
  }

  private appendInTransaction(request: ControlRepositoryAppendRequest): ControlRepositoryAppendResult {
    const current = this.load(request.companionId);
    if (!current) throw new Error(`control_aggregate_not_initialized:${request.companionId}`);
    const identity = request.event.identity;
    validateIdentity(identity.commandId, identity.stepId, identity.rootCommandDigest, identity.stepDigest);
    const idempotencyKey = committedStepKey(identity.commandId, identity.stepId);
    const existing = this.db.prepare(`
      SELECT companion_id, event_sequence, event_id, command_id, stage, work_id,
             step_id, root_command_digest, step_digest, control_revision,
             event_type, payload_json, occurred_at
      FROM goal_agent_control_events
      WHERE companion_id = ? AND idempotency_key = ?
    `).get(request.companionId, idempotencyKey) as ControlEventRow | undefined;
    if (existing) {
      const persisted = rowToEvent(existing);
      if (persisted.identity.rootCommandDigest === identity.rootCommandDigest
        && persisted.identity.stepDigest === identity.stepDigest) {
        return { kind: 'idempotent_replay', aggregate: current, event: persisted };
      }
      const conflict = this.insertAuditEvent(request, current, 'command_step_conflict');
      return { kind: 'rejected', reason: 'conflict', aggregate: conflict.aggregate, event: conflict.event };
    }
    if (request.expectedControlRevision !== current.controlRevision) {
      const stale = this.insertAuditEvent(request, current, 'stale_control_revision');
      return { kind: 'rejected', reason: 'stale', aggregate: stale.aggregate, event: stale.event };
    }

    const eventSequence = current.lastEventSequence + 1;
    const controlRevision = request.event.mutation ? current.controlRevision + 1 : null;
    const persisted: PersistedControlEvent = {
      ...structuredClone(request.event),
      companionId: request.companionId,
      eventSequence,
      controlRevision,
    };
    let next: GoalAgentControlAggregate;
    try {
      next = reduceControlEvent(current, persisted);
    } catch (error) {
      if (!isInvalidControlTransition(error)) throw error;
      const invalid = this.insertAuditEvent(
        request,
        current,
        `invalid_transition:${error instanceof Error ? error.message : String(error)}`,
      );
      return {
        kind: 'rejected',
        reason: 'invalid_transition',
        aggregate: invalid.aggregate,
        event: invalid.event,
      };
    }
    this.insertEvent(persisted, idempotencyKey);
    this.writeSnapshot(next, request.event.occurredAt);
    return { kind: 'committed', aggregate: cloneControlAggregate(next), event: structuredClone(persisted) };
  }

  private insertAuditEvent(
    request: ControlRepositoryAppendRequest,
    current: GoalAgentControlAggregate,
    reason: string,
  ): { aggregate: GoalAgentControlAggregate; event: PersistedControlEvent } {
    const event: PersistedControlEvent = {
      ...structuredClone(request.event),
      eventId: `${request.event.eventId}:audit:${randomUUID()}`,
      eventType: `control.${reason}`,
      mutation: null,
      payload: { ...structuredClone(request.event.payload), reason },
      companionId: request.companionId,
      eventSequence: current.lastEventSequence + 1,
      controlRevision: null,
    };
    const next = reduceControlEvent(current, event);
    this.insertEvent(event, null);
    this.writeSnapshot(next, event.occurredAt);
    return { aggregate: next, event };
  }

  private insertEvent(event: PersistedControlEvent, idempotencyKey: string | null): void {
    this.db.prepare(`
      INSERT INTO goal_agent_control_events (
        companion_id, event_sequence, event_id, command_id, stage, work_id,
        step_id, root_command_digest, step_digest, idempotency_key,
        control_revision, event_type, payload_json, occurred_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.companionId,
      event.eventSequence,
      event.eventId,
      event.identity.commandId,
      event.identity.stage,
      event.identity.workId,
      event.identity.stepId,
      event.identity.rootCommandDigest,
      event.identity.stepDigest,
      idempotencyKey,
      event.controlRevision,
      event.eventType,
      JSON.stringify({ mutation: event.mutation, payload: event.payload }),
      event.occurredAt,
    );
  }

  private writeSnapshot(aggregate: GoalAgentControlAggregate, updatedAt: number): void {
    assertGoalAgentControlAggregate(aggregate);
    this.db.prepare(`
      INSERT INTO goal_agent_control_snapshots (
        companion_id, control_revision, last_event_sequence, state_json, updated_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(companion_id) DO UPDATE SET
        control_revision = excluded.control_revision,
        last_event_sequence = excluded.last_event_sequence,
        state_json = excluded.state_json,
        updated_at = excluded.updated_at
    `).run(
      aggregate.companionId,
      aggregate.controlRevision,
      aggregate.lastEventSequence,
      JSON.stringify(aggregate),
      updatedAt,
    );
  }
}

interface ControlEventRow {
  companion_id: string;
  event_sequence: number;
  event_id: string;
  command_id: string;
  stage: string;
  work_id: string | null;
  step_id: string;
  root_command_digest: string;
  step_digest: string;
  control_revision: number | null;
  event_type: string;
  payload_json: string;
  occurred_at: number;
}

function rowToEvent(row: ControlEventRow): PersistedControlEvent {
  const stored = JSON.parse(row.payload_json) as Pick<PersistedControlEvent, 'mutation' | 'payload'>;
  return {
    companionId: row.companion_id,
    eventSequence: row.event_sequence,
    eventId: row.event_id,
    identity: {
      commandId: row.command_id,
      stage: row.stage,
      workId: row.work_id,
      stepId: row.step_id,
      rootCommandDigest: row.root_command_digest,
      stepDigest: row.step_digest,
    },
    controlRevision: row.control_revision,
    eventType: row.event_type,
    mutation: stored.mutation,
    payload: stored.payload,
    occurredAt: row.occurred_at,
  };
}

function committedStepKey(commandId: string, stepId: string): string {
  return createHash('sha256').update(`${commandId}\0${stepId}`).digest('hex');
}

function validateIdentity(
  commandId: string,
  stepId: string,
  rootCommandDigest: string,
  stepDigest: string,
): void {
  if (!commandId.trim() || !stepId.trim()) throw new Error('control_command_identity_required');
  if (!rootCommandDigest.trim() || !stepDigest.trim()) throw new Error('control_command_digest_required');
}

function isInvalidControlTransition(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /transition|transfer|commit|quarantine|resume_token|control_grant|acquisition|body_epoch/.test(error.message);
}
