import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { openSqliteDatabase, type SqliteDatabase } from '../sqliteDatabase.js';
import {
  LLM_TRACE_EVENT_SCHEMA_V1,
  isLlmTraceEventType,
  type LlmTraceAgent,
  type LlmTraceEventInputV1,
  type LlmTraceEventPage,
  type LlmTraceEventQuery,
  type LlmTraceEventType,
  type LlmTraceEventV1,
  type LlmTraceOpenCall,
} from './types.js';

const DEFAULT_PAGE_LIMIT = 200;
const MAX_PAGE_LIMIT = 1_000;
const DEFAULT_MAX_PAYLOAD_BYTES = 2 * 1024 * 1024;

export interface LlmTraceEventStoreOptions {
  filename: string;
  profileId: string;
  maxPayloadBytes?: number;
  maxDatabaseBytes?: number;
}

export interface LlmTraceArchiveResult {
  archivedEvents: number;
  firstSeq: number | null;
  lastSeq: number | null;
}

export class LlmTraceCorruptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlmTraceCorruptionError';
  }
}

export class LlmTraceCapacityError extends Error {
  readonly code = 'trace_capacity_exceeded';

  constructor(message: string) {
    super(message);
    this.name = 'LlmTraceCapacityError';
  }
}

export class LlmTraceDuplicateEventError extends Error {
  constructor(readonly eventId: string) {
    super(`LLM trace eventId already exists with different content: ${eventId}`);
    this.name = 'LlmTraceDuplicateEventError';
  }
}

export class LlmTraceEventStore {
  private readonly db: SqliteDatabase;
  private readonly profileId: string;
  private readonly maxPayloadBytes: number;
  private readonly maxDatabaseBytes?: number;

  constructor(options: LlmTraceEventStoreOptions) {
    const profileId = options.profileId.trim();
    if (!profileId) throw new Error('LLM trace profileId is required');
    if (options.filename !== ':memory:') mkdirSync(dirname(options.filename), { recursive: true });

    this.profileId = profileId;
    this.maxPayloadBytes = positiveInteger(options.maxPayloadBytes, DEFAULT_MAX_PAYLOAD_BYTES, 'maxPayloadBytes');
    this.maxDatabaseBytes = options.maxDatabaseBytes === undefined
      ? undefined
      : positiveInteger(options.maxDatabaseBytes, undefined, 'maxDatabaseBytes');
    this.db = openSqliteDatabase(options.filename);
    if (options.filename !== ':memory:') this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS llm_trace_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS llm_trace_events (
        profile_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        event_id TEXT NOT NULL UNIQUE,
        occurred_at TEXT NOT NULL,
        type TEXT NOT NULL,
        call_id TEXT,
        parent_call_id TEXT,
        correlation_id TEXT,
        interaction_session_id TEXT,
        goal_session_id TEXT,
        task_id TEXT,
        agent TEXT NOT NULL,
        node TEXT,
        turn INTEGER,
        model_call_index INTEGER,
        state_revision INTEGER,
        epoch INTEGER,
        payload_json TEXT NOT NULL,
        PRIMARY KEY (profile_id, seq)
      );
      CREATE TABLE IF NOT EXISTS llm_trace_event_archive (
        profile_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        event_id TEXT NOT NULL UNIQUE,
        occurred_at TEXT NOT NULL,
        type TEXT NOT NULL,
        call_id TEXT,
        parent_call_id TEXT,
        correlation_id TEXT,
        interaction_session_id TEXT,
        goal_session_id TEXT,
        task_id TEXT,
        agent TEXT NOT NULL,
        node TEXT,
        turn INTEGER,
        model_call_index INTEGER,
        state_revision INTEGER,
        epoch INTEGER,
        payload_json TEXT NOT NULL,
        archived_at TEXT NOT NULL,
        PRIMARY KEY (profile_id, seq)
      );
      CREATE TABLE IF NOT EXISTS llm_trace_maintenance (
        maintenance_id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        scope_json TEXT NOT NULL,
        affected_events INTEGER NOT NULL,
        first_seq INTEGER,
        last_seq INTEGER,
        occurred_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_trace_call
        ON llm_trace_events(profile_id, call_id, seq);
      CREATE INDEX IF NOT EXISTS idx_trace_task
        ON llm_trace_events(profile_id, task_id, seq);
      CREATE INDEX IF NOT EXISTS idx_trace_interaction
        ON llm_trace_events(profile_id, interaction_session_id, seq);
      CREATE INDEX IF NOT EXISTS idx_trace_session
        ON llm_trace_events(profile_id, goal_session_id, seq);
      CREATE INDEX IF NOT EXISTS idx_trace_type
        ON llm_trace_events(profile_id, type, seq);
    `);
    this.ensureMetadata();
    this.validateIntegrity();
  }

  append(input: LlmTraceEventInputV1): LlmTraceEventV1 {
    validateEventInput(input);
    const eventId = input.eventId?.trim() || randomUUID();
    const payloadJson = stringifyPayload(input.payload);
    if (Buffer.byteLength(payloadJson, 'utf8') > this.maxPayloadBytes) {
      throw new LlmTraceCapacityError(`LLM trace payload exceeds ${this.maxPayloadBytes} bytes`);
    }

    const existing = this.findByEventId(eventId);
    if (existing) {
      const candidate = { ...existing, ...input, eventId };
      if (sameEventContent(existing, candidate)) return existing;
      throw new LlmTraceDuplicateEventError(eventId);
    }

    const event = this.db.transaction(() => {
      this.assertDatabaseCapacity(payloadJson);
      const seq = this.nextSeq();
      const next: LlmTraceEventV1 = {
        schema: LLM_TRACE_EVENT_SCHEMA_V1,
        eventId,
        profileId: this.profileId,
        seq,
        occurredAt: input.occurredAt,
        type: input.type,
        callId: input.callId,
        parentCallId: input.parentCallId,
        correlationId: input.correlationId,
        interactionSessionId: input.interactionSessionId,
        goalSessionId: input.goalSessionId,
        taskId: input.taskId,
        agent: input.agent,
        node: input.node,
        turn: input.turn,
        modelCallIndex: input.modelCallIndex,
        stateRevision: input.stateRevision,
        epoch: input.epoch,
        payload: JSON.parse(payloadJson) as LlmTraceEventV1['payload'],
      };
      this.insertEvent(next, payloadJson);
      this.writeNextSeq(seq + 1);
      return next;
    })();
    return cloneEvent(event);
  }

  getByEventId(eventId: string): LlmTraceEventV1 | null {
    const event = this.findByEventId(eventId);
    return event ? cloneEvent(event) : null;
  }

  listEvents(query: LlmTraceEventQuery = {}): LlmTraceEventPage {
    const limit = boundedLimit(query.limit);
    const source = query.includeArchived
      ? `(SELECT ${EVENT_COLUMNS} FROM llm_trace_events UNION ALL SELECT ${EVENT_COLUMNS} FROM llm_trace_event_archive)`
      : 'llm_trace_events';
    const where = ['profile_id = ?'];
    const params: unknown[] = [this.profileId];
    if (query.afterSeq !== undefined) {
      assertNonNegativeInteger(query.afterSeq, 'afterSeq');
      where.push('seq > ?');
      params.push(query.afterSeq);
    }
    if (query.beforeSeq !== undefined) {
      assertNonNegativeInteger(query.beforeSeq, 'beforeSeq');
      where.push('seq < ?');
      params.push(query.beforeSeq);
    }
    addEquals(where, params, 'call_id', query.callId);
    addEquals(where, params, 'interaction_session_id', query.interactionSessionId);
    addEquals(where, params, 'goal_session_id', query.goalSessionId);
    addEquals(where, params, 'task_id', query.taskId);
    addEquals(where, params, 'agent', query.agent);
    if (query.types?.length) {
      for (const type of query.types) {
        if (!isLlmTraceEventType(type)) throw new Error(`invalid LLM trace event type: ${type}`);
      }
      where.push(`type IN (${query.types.map(() => '?').join(', ')})`);
      params.push(...query.types);
    }
    const rows = this.db.prepare(`
      SELECT ${EVENT_COLUMNS} FROM ${source}
      WHERE ${where.join(' AND ')}
      ORDER BY seq ASC
      LIMIT ?
    `).all(...params, limit + 1) as TraceEventRow[];
    return {
      events: rows.slice(0, limit).map(rowToEvent),
      hasMore: rows.length > limit,
    };
  }

  listOpenCalls(): LlmTraceOpenCall[] {
    const rows = this.db.prepare(`
      SELECT request.call_id, request.seq, request.occurred_at, request.agent,
             request.node, request.interaction_session_id, request.goal_session_id, request.task_id
      FROM llm_trace_events AS request
      WHERE request.profile_id = ?
        AND request.type = 'llm.request.recorded'
        AND request.call_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM llm_trace_events AS terminal
          WHERE terminal.profile_id = request.profile_id
            AND terminal.call_id = request.call_id
            AND terminal.type IN (
              'llm.response.recorded', 'llm.call.failed', 'llm.call.cancelled',
              'trace.persistence_gap'
            )
        )
      ORDER BY request.seq ASC
    `).all(this.profileId) as OpenCallRow[];
    return rows.map(row => ({
      callId: row.call_id,
      requestSeq: row.seq,
      occurredAt: row.occurred_at,
      agent: row.agent as LlmTraceAgent,
      node: row.node ?? undefined,
      interactionSessionId: row.interaction_session_id ?? undefined,
      goalSessionId: row.goal_session_id ?? undefined,
      taskId: row.task_id ?? undefined,
    }));
  }

  archiveSession(input: {
    interactionSessionId?: string;
    goalSessionId?: string;
    occurredAt?: string;
  }): LlmTraceArchiveResult {
    const interactionSessionId = input.interactionSessionId?.trim();
    const goalSessionId = input.goalSessionId?.trim();
    if (!interactionSessionId && !goalSessionId) {
      throw new Error('archiveSession requires interactionSessionId or goalSessionId');
    }
    return this.db.transaction(() => {
      const where = ['profile_id = ?'];
      const params: unknown[] = [this.profileId];
      addEquals(where, params, 'interaction_session_id', interactionSessionId);
      addEquals(where, params, 'goal_session_id', goalSessionId);
      const condition = where.join(' AND ');
      const bounds = this.db.prepare(`
        SELECT COUNT(*) AS count, MIN(seq) AS first_seq, MAX(seq) AS last_seq
        FROM llm_trace_events WHERE ${condition}
      `).get(...params) as { count: number; first_seq: number | null; last_seq: number | null };
      if (bounds.count === 0) return { archivedEvents: 0, firstSeq: null, lastSeq: null };
      const archivedAt = input.occurredAt ?? new Date().toISOString();
      this.db.prepare(`
        INSERT INTO llm_trace_event_archive (${EVENT_COLUMNS}, archived_at)
        SELECT ${EVENT_COLUMNS}, ? FROM llm_trace_events WHERE ${condition}
      `).run(archivedAt, ...params);
      this.db.prepare(`DELETE FROM llm_trace_events WHERE ${condition}`).run(...params);
      this.db.prepare(`
        INSERT INTO llm_trace_maintenance (
          maintenance_id, profile_id, kind, scope_json, affected_events,
          first_seq, last_seq, occurred_at
        ) VALUES (?, ?, 'archive_session', ?, ?, ?, ?, ?)
      `).run(
        randomUUID(),
        this.profileId,
        JSON.stringify({ interactionSessionId, goalSessionId }),
        bounds.count,
        bounds.first_seq,
        bounds.last_seq,
        archivedAt,
      );
      return {
        archivedEvents: bounds.count,
        firstSeq: bounds.first_seq,
        lastSeq: bounds.last_seq,
      };
    })();
  }

  validateIntegrity(): void {
    const rows = this.db.prepare(`
      SELECT ${EVENT_COLUMNS} FROM (
        SELECT ${EVENT_COLUMNS} FROM llm_trace_events
        UNION ALL
        SELECT ${EVENT_COLUMNS} FROM llm_trace_event_archive
      ) WHERE profile_id = ? ORDER BY seq ASC
    `).all(this.profileId) as TraceEventRow[];
    let expected = 1;
    for (const row of rows) {
      if (row.seq !== expected) {
        throw new LlmTraceCorruptionError(`LLM trace seq gap for ${this.profileId}: expected ${expected}, got ${row.seq}`);
      }
      try {
        rowToEvent(row);
      } catch (error) {
        throw new LlmTraceCorruptionError(
          `LLM trace event ${row.event_id} is invalid: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      expected += 1;
    }
    const storedNext = Number(this.readMetadata('next_seq') ?? '1');
    if (!Number.isSafeInteger(storedNext) || storedNext !== expected) {
      throw new LlmTraceCorruptionError(
        `LLM trace next_seq mismatch for ${this.profileId}: expected ${expected}, got ${storedNext}`,
      );
    }
  }

  close(): void {
    this.db.close();
  }

  private ensureMetadata(): void {
    const schema = this.readMetadata('schema');
    if (schema && schema !== LLM_TRACE_EVENT_SCHEMA_V1) {
      throw new LlmTraceCorruptionError(`unsupported LLM trace schema: ${schema}`);
    }
    const storedProfile = this.readMetadata('profile_id');
    if (storedProfile && storedProfile !== this.profileId) {
      throw new LlmTraceCorruptionError(
        `LLM trace database belongs to profile ${storedProfile}, not ${this.profileId}`,
      );
    }
    this.db.transaction(() => {
      this.insertMetadata('schema', LLM_TRACE_EVENT_SCHEMA_V1);
      this.insertMetadata('profile_id', this.profileId);
      this.insertMetadata('next_seq', '1');
    })();
  }

  private insertMetadata(key: string, value: string): void {
    this.db.prepare('INSERT OR IGNORE INTO llm_trace_metadata (key, value) VALUES (?, ?)').run(key, value);
  }

  private readMetadata(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM llm_trace_metadata WHERE key = ?')
      .get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  private nextSeq(): number {
    const value = Number(this.readMetadata('next_seq'));
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new LlmTraceCorruptionError(`invalid next_seq metadata: ${value}`);
    }
    return value;
  }

  private writeNextSeq(nextSeq: number): void {
    this.db.prepare('UPDATE llm_trace_metadata SET value = ? WHERE key = ?')
      .run(String(nextSeq), 'next_seq');
  }

  private insertEvent(event: LlmTraceEventV1, payloadJson: string): void {
    this.db.prepare(`
      INSERT INTO llm_trace_events (
        profile_id, seq, event_id, occurred_at, type, call_id, parent_call_id,
        correlation_id, interaction_session_id, goal_session_id, task_id,
        agent, node, turn, model_call_index, state_revision, epoch, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.profileId,
      event.seq,
      event.eventId,
      event.occurredAt,
      event.type,
      event.callId ?? null,
      event.parentCallId ?? null,
      event.correlationId ?? null,
      event.interactionSessionId ?? null,
      event.goalSessionId ?? null,
      event.taskId ?? null,
      event.agent,
      event.node ?? null,
      event.turn ?? null,
      event.modelCallIndex ?? null,
      event.stateRevision ?? null,
      event.epoch ?? null,
      payloadJson,
    );
  }

  private findByEventId(eventId: string): LlmTraceEventV1 | null {
    const row = this.db.prepare(`
      SELECT ${EVENT_COLUMNS} FROM (
        SELECT ${EVENT_COLUMNS} FROM llm_trace_events
        UNION ALL
        SELECT ${EVENT_COLUMNS} FROM llm_trace_event_archive
      ) WHERE event_id = ? LIMIT 1
    `).get(eventId) as TraceEventRow | undefined;
    return row ? rowToEvent(row) : null;
  }

  private assertDatabaseCapacity(payloadJson: string): void {
    if (this.maxDatabaseBytes === undefined) return;
    const pageCount = Number(this.db.pragma('page_count', { simple: true }));
    const pageSize = Number(this.db.pragma('page_size', { simple: true }));
    const estimated = pageCount * pageSize + Buffer.byteLength(payloadJson, 'utf8');
    if (estimated > this.maxDatabaseBytes) {
      throw new LlmTraceCapacityError(
        `LLM trace database would exceed ${this.maxDatabaseBytes} bytes`,
      );
    }
  }
}

const EVENT_COLUMNS = `
  profile_id, seq, event_id, occurred_at, type, call_id, parent_call_id,
  correlation_id, interaction_session_id, goal_session_id, task_id,
  agent, node, turn, model_call_index, state_revision, epoch, payload_json
`;

interface TraceEventRow {
  profile_id: string;
  seq: number;
  event_id: string;
  occurred_at: string;
  type: string;
  call_id: string | null;
  parent_call_id: string | null;
  correlation_id: string | null;
  interaction_session_id: string | null;
  goal_session_id: string | null;
  task_id: string | null;
  agent: string;
  node: string | null;
  turn: number | null;
  model_call_index: number | null;
  state_revision: number | null;
  epoch: number | null;
  payload_json: string;
}

interface OpenCallRow {
  call_id: string;
  seq: number;
  occurred_at: string;
  agent: string;
  node: string | null;
  interaction_session_id: string | null;
  goal_session_id: string | null;
  task_id: string | null;
}

function rowToEvent(row: TraceEventRow): LlmTraceEventV1 {
  if (!isLlmTraceEventType(row.type)) throw new Error(`unknown event type ${row.type}`);
  if (!isAgent(row.agent)) throw new Error(`unknown agent ${row.agent}`);
  const payload = JSON.parse(row.payload_json) as unknown;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('payload must be a JSON object');
  }
  return {
    schema: LLM_TRACE_EVENT_SCHEMA_V1,
    eventId: row.event_id,
    profileId: row.profile_id,
    seq: row.seq,
    occurredAt: row.occurred_at,
    type: row.type,
    callId: row.call_id ?? undefined,
    parentCallId: row.parent_call_id ?? undefined,
    correlationId: row.correlation_id ?? undefined,
    interactionSessionId: row.interaction_session_id ?? undefined,
    goalSessionId: row.goal_session_id ?? undefined,
    taskId: row.task_id ?? undefined,
    agent: row.agent,
    node: row.node ?? undefined,
    turn: row.turn ?? undefined,
    modelCallIndex: row.model_call_index ?? undefined,
    stateRevision: row.state_revision ?? undefined,
    epoch: row.epoch ?? undefined,
    payload: payload as LlmTraceEventV1['payload'],
  };
}

function validateEventInput(input: LlmTraceEventInputV1): void {
  if (!isLlmTraceEventType(input.type)) throw new Error(`invalid LLM trace event type: ${input.type}`);
  if (!isAgent(input.agent)) throw new Error(`invalid LLM trace agent: ${input.agent}`);
  if (!input.occurredAt || !Number.isFinite(Date.parse(input.occurredAt))) {
    throw new Error('LLM trace occurredAt must be an ISO timestamp');
  }
  if (!input.payload || typeof input.payload !== 'object' || Array.isArray(input.payload)) {
    throw new Error('LLM trace payload must be a JSON object');
  }
  for (const [key, value] of [
    ['turn', input.turn],
    ['modelCallIndex', input.modelCallIndex],
    ['stateRevision', input.stateRevision],
    ['epoch', input.epoch],
  ] as const) {
    if (value !== undefined) assertNonNegativeInteger(value, key);
  }
}

function stringifyPayload(payload: LlmTraceEventV1['payload']): string {
  try {
    const json = JSON.stringify(payload);
    if (json === undefined) throw new Error('payload is not JSON serializable');
    return json;
  } catch (error) {
    throw new Error(`LLM trace payload is not JSON serializable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function cloneEvent(event: LlmTraceEventV1): LlmTraceEventV1 {
  return JSON.parse(JSON.stringify(event)) as LlmTraceEventV1;
}

function sameEventContent(existing: LlmTraceEventV1, candidate: Partial<LlmTraceEventV1>): boolean {
  const comparable = (event: Partial<LlmTraceEventV1>) => ({
    occurredAt: event.occurredAt,
    type: event.type,
    callId: event.callId,
    parentCallId: event.parentCallId,
    correlationId: event.correlationId,
    interactionSessionId: event.interactionSessionId,
    goalSessionId: event.goalSessionId,
    taskId: event.taskId,
    agent: event.agent,
    node: event.node,
    turn: event.turn,
    modelCallIndex: event.modelCallIndex,
    stateRevision: event.stateRevision,
    epoch: event.epoch,
    payload: event.payload,
  });
  return JSON.stringify(comparable(existing)) === JSON.stringify(comparable(candidate));
}

function isAgent(value: unknown): value is LlmTraceAgent {
  return value === 'mainbrain' || value === 'goalagent' || value === 'system' || value === 'unknown';
}

function addEquals(where: string[], params: unknown[], column: string, value?: string): void {
  if (!value) return;
  where.push(`${column} = ?`);
  params.push(value);
}

function boundedLimit(limit?: number): number {
  if (limit === undefined) return DEFAULT_PAGE_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) {
    throw new Error(`limit must be an integer between 1 and ${MAX_PAGE_LIMIT}`);
  }
  return limit;
}

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
}

function positiveInteger(
  value: number | undefined,
  fallback: number | undefined,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (resolved === undefined || !Number.isSafeInteger(resolved) || resolved < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return resolved;
}
