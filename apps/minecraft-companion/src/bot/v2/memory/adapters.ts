import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { SqliteDatabase } from '../infra/sqliteDatabase.js';
import { openSqliteDatabase } from '../infra/sqliteDatabase.js';
import type { BotMemoryStore } from '../infra/botMemory.js';
import type {
  MemoryKind,
  MemoryRecord,
  MemorySourceAdapter,
  MemorySourceBatch,
  MemoryStatus,
  SourceRef,
} from './contracts.js';

interface CursorRecord {
  cursor: string;
  record: MemoryRecord;
}

type Row = Record<string, unknown>;

export function canonicalMemoryId(profileId: string, store: string, sourceId: string): string {
  return `mem-${createHash('sha256').update(`${profileId}\0${store}\0${sourceId}`).digest('hex').slice(0, 32)}`;
}

/** Test/extension adapter for already canonicalized source snapshots. */
export class ArrayMemorySourceAdapter implements MemorySourceAdapter {
  constructor(readonly id: string, private readonly load: (profileId: string) => MemoryRecord[]) {}

  async scan(profileId: string, cursor: string | null, limit: number): Promise<MemorySourceBatch> {
    const records = this.load(profileId).map(record => withAdapter(record, this.id));
    return page(records.map(record => ({ cursor: record.id, record })), cursor, limit);
  }
}

export class ChatMemorySourceAdapter implements MemorySourceAdapter {
  readonly id = 'chat-memory';

  constructor(private readonly dbPath: string) {}

  async scan(profileId: string, cursor: string | null, limit: number): Promise<MemorySourceBatch> {
    return page(readDatabase(this.dbPath, db => this.read(db, profileId)), cursor, limit);
  }

  private read(db: SqliteDatabase, profileId: string): CursorRecord[] {
    const output: CursorRecord[] = [];
    if (hasTable(db, 'chat_messages')) {
      const rows = db.prepare('SELECT id,session_id,role,content,ts FROM chat_messages WHERE profile_id=?').all(profileId) as Row[];
      for (const row of rows) {
        const sourceId = `message:${text(row.id)}`;
        output.push(cursorRecord('message', number(row.ts), sourceId, record({
          profileId,
          store: this.id,
          sourceId,
          kind: 'conversation',
          summary: summarize(text(row.content)),
          occurredAt: number(row.ts),
          importance: row.role === 'owner' ? 0.6 : 0.35,
          confidence: 1,
          metadata: { authorityType: 'chat_message', sessionId: text(row.session_id), role: text(row.role) },
        })));
      }
    }
    if (hasTable(db, 'memory_facts')) {
      const rows = db.prepare('SELECT * FROM memory_facts WHERE profile_id=?').all(profileId) as Row[];
      for (const row of rows) {
        const sourceId = `fact:${text(row.id)}`;
        const sourceIds = jsonStrings(row.source_ids_json);
        output.push(cursorRecord('fact', number(row.updated_at), sourceId, record({
          profileId,
          store: this.id,
          sourceId,
          kind: factKind(text(row.kind)),
          status: factStatus(text(row.status)),
          summary: summarize(text(row.text)),
          occurredAt: number(row.created_at),
          createdAt: number(row.created_at),
          updatedAt: number(row.updated_at),
          importance: number(row.importance, 0.5),
          confidence: number(row.confidence, 0.5),
          evidenceRefs: sourceIds.map(id => sourceKey(this.id, `message:${id}`)),
          metadata: {
            authorityType: 'memory_fact',
            scope: text(row.scope),
            legacyKind: text(row.kind),
            legacyStatus: text(row.status),
            ...(row.supersedes_id ? { supersedesId: text(row.supersedes_id) } : {}),
          },
        })));
      }
    }
    if (hasTable(db, 'conversation_summaries')) {
      const rows = db.prepare('SELECT * FROM conversation_summaries WHERE profile_id=?').all(profileId) as Row[];
      for (const row of rows) {
        const sourceId = `summary:${text(row.id)}`;
        const covered = jsonStrings(row.covered_ids_json);
        output.push(cursorRecord('summary', number(row.created_at), sourceId, record({
          profileId,
          store: this.id,
          sourceId,
          kind: 'conversation',
          summary: summarize(text(row.summary)),
          occurredAt: number(row.created_at),
          importance: 0.55,
          confidence: 0.8,
          evidenceRefs: covered.map(id => sourceKey(this.id, `message:${id}`)),
          metadata: {
            authorityType: 'conversation_summary',
            sessionId: text(row.session_id),
            openLoops: jsonStrings(row.open_loops_json),
            commitments: jsonStrings(row.commitments_json),
          },
        })));
      }
    }
    return output;
  }
}

export class MemoryV2SourceAdapter implements MemorySourceAdapter {
  readonly id = 'memory-v2';

  constructor(private readonly dbPath: string) {}

  async scan(profileId: string, cursor: string | null, limit: number): Promise<MemorySourceBatch> {
    return scanSqliteRows(this.dbPath, profileId, cursor, limit, [
      { table: 'conversations', map: row => this.mapRow('conversations', row, profileId) },
      { table: 'events', map: row => this.mapRow('events', row, profileId) },
      { table: 'tasks', map: row => this.mapRow('tasks', row, profileId) },
      { table: 'spatial', map: row => this.mapRow('spatial', row, profileId) },
      { table: 'objects', map: row => this.mapRow('objects', row, profileId) },
      { table: 'users', map: row => this.mapRow('users', row, profileId) },
      { table: 'trajectory', map: row => this.mapRow('trajectory', row, profileId) },
    ]);
  }

  private mapRow(table: string, row: Row, profileId: string): MemoryRecord {
    if (table === 'conversations') {
      const sourceId = `conversation:${text(row.id)}`;
      return record({
        profileId, store: this.id, sourceId, kind: 'conversation', summary: summarize(text(row.content)),
        occurredAt: number(row.ts), importance: row.role === 'owner' ? 0.55 : 0.3, confidence: 1,
        metadata: {
          authorityType: 'conversation', turnId: text(row.turn_id), role: text(row.role),
          source: text(row.source), isPending: Boolean(number(row.is_pending)),
          ...(row.task_context ? { taskContext: text(row.task_context) } : {}),
        },
      });
    }
    if (table === 'events') {
      const sourceId = `event:${text(row.id)}`;
      return record({
        profileId, store: this.id, sourceId, kind: 'event', summary: `事件：${text(row.type)}`,
        occurredAt: number(row.ts), importance: eventImportance(text(row.level)), confidence: 1,
        entities: payloadEntities(row.payload_json),
        metadata: { authorityType: 'event', eventType: text(row.type), level: text(row.level) },
      });
    }
    if (table === 'tasks') {
      const sourceId = `task:${text(row.id)}`;
      return record({
        profileId, store: this.id, sourceId, kind: 'task_experience',
        summary: `任务 ${text(row.kind)}：${text(row.state)}`,
        occurredAt: number(row.created_at), createdAt: number(row.created_at), updatedAt: number(row.updated_at),
        importance: ['failed', 'completed'].includes(text(row.state)) ? 0.7 : 0.45, confidence: 1,
        metadata: {
          authorityType: 'task', taskId: text(row.id), taskKind: text(row.kind), state: text(row.state),
          ...(row.parent_id ? { parentId: text(row.parent_id) } : {}),
        },
      });
    }
    if (table === 'spatial') {
      const sourceId = `spatial:${text(row.id)}`;
      const location = `${text(row.kind)}:${number(row.x)},${number(row.y)},${number(row.z)}`;
      return record({
        profileId, store: this.id, sourceId, kind: 'spatial', summary: `地点 ${text(row.kind)}：${number(row.x)}, ${number(row.y)}, ${number(row.z)}`,
        occurredAt: number(row.ts), importance: 0.55, confidence: 1, locationRefs: [location],
        metadata: { authorityType: 'spatial', spatialKind: text(row.kind) },
      });
    }
    if (table === 'objects') {
      const sourceId = `object:${text(row.id)}`;
      const location = `point:${number(row.pos_x)},${number(row.pos_y)},${number(row.pos_z)}`;
      return record({
        profileId, store: this.id, sourceId, kind: 'spatial', summary: `物体 ${text(row.name)}（${text(row.kind)}）`,
        occurredAt: number(row.ts), importance: 0.45, confidence: 1,
        entities: [text(row.name)], locationRefs: [location],
        metadata: { authorityType: 'object', objectKind: text(row.kind) },
      });
    }
    if (table === 'users') {
      const sourceId = `user:${text(row.username)}`;
      return record({
        profileId, store: this.id, sourceId, kind: 'identity',
        summary: summarize(text(row.history_summary) || `用户 ${text(row.username)}`),
        occurredAt: number(row.updated_at), importance: 0.75, confidence: 0.75,
        entities: [text(row.username)],
        metadata: { authorityType: 'user', username: text(row.username), hasPreferences: Boolean(row.preferences_json) },
      });
    }
    const sourceId = `trajectory:${number(row.ts)}`;
    const location = `${text(row.dimension)}:${number(row.x)},${number(row.y)},${number(row.z)}`;
    return record({
      profileId, store: this.id, sourceId, kind: 'spatial', summary: `轨迹 ${location}`,
      occurredAt: number(row.ts), importance: 0.15, confidence: 1, locationRefs: [location],
      metadata: { authorityType: 'trajectory', dimension: text(row.dimension), biome: text(row.biome) },
    });
  }

  private read(db: SqliteDatabase, profileId: string): CursorRecord[] {
    const output: CursorRecord[] = [];
    this.readRows(db, 'conversations', row => {
      const sourceId = `conversation:${text(row.id)}`;
      return cursorRecord('conversation', number(row.ts), sourceId, record({
        profileId, store: this.id, sourceId, kind: 'conversation', summary: summarize(text(row.content)),
        occurredAt: number(row.ts), importance: row.role === 'owner' ? 0.55 : 0.3, confidence: 1,
        metadata: {
          authorityType: 'conversation', turnId: text(row.turn_id), role: text(row.role),
          source: text(row.source), isPending: Boolean(number(row.is_pending)),
          ...(row.task_context ? { taskContext: text(row.task_context) } : {}),
        },
      }));
    }, output);
    this.readRows(db, 'events', row => {
      const sourceId = `event:${text(row.id)}`;
      return cursorRecord('event', number(row.ts), sourceId, record({
        profileId, store: this.id, sourceId, kind: 'event', summary: `事件：${text(row.type)}`,
        occurredAt: number(row.ts), importance: eventImportance(text(row.level)), confidence: 1,
        entities: payloadEntities(row.payload_json),
        metadata: { authorityType: 'event', eventType: text(row.type), level: text(row.level) },
      }));
    }, output);
    this.readRows(db, 'tasks', row => {
      const sourceId = `task:${text(row.id)}`;
      return cursorRecord('task', number(row.updated_at), sourceId, record({
        profileId, store: this.id, sourceId, kind: 'task_experience',
        summary: `任务 ${text(row.kind)}：${text(row.state)}`,
        occurredAt: number(row.created_at), createdAt: number(row.created_at), updatedAt: number(row.updated_at),
        importance: ['failed', 'completed'].includes(text(row.state)) ? 0.7 : 0.45, confidence: 1,
        metadata: {
          authorityType: 'task', taskId: text(row.id), taskKind: text(row.kind), state: text(row.state),
          ...(row.parent_id ? { parentId: text(row.parent_id) } : {}),
        },
      }));
    }, output);
    this.readRows(db, 'spatial', row => {
      const sourceId = `spatial:${text(row.id)}`;
      const location = `${text(row.kind)}:${number(row.x)},${number(row.y)},${number(row.z)}`;
      return cursorRecord('spatial', number(row.ts), sourceId, record({
        profileId, store: this.id, sourceId, kind: 'spatial', summary: `地点 ${text(row.kind)}：${number(row.x)}, ${number(row.y)}, ${number(row.z)}`,
        occurredAt: number(row.ts), importance: 0.55, confidence: 1, locationRefs: [location],
        metadata: { authorityType: 'spatial', spatialKind: text(row.kind) },
      }));
    }, output);
    this.readRows(db, 'objects', row => {
      const sourceId = `object:${text(row.id)}`;
      const location = `point:${number(row.pos_x)},${number(row.pos_y)},${number(row.pos_z)}`;
      return cursorRecord('object', number(row.ts), sourceId, record({
        profileId, store: this.id, sourceId, kind: 'spatial', summary: `物体 ${text(row.name)}（${text(row.kind)}）`,
        occurredAt: number(row.ts), importance: 0.45, confidence: 1,
        entities: [text(row.name)], locationRefs: [location],
        metadata: { authorityType: 'object', objectKind: text(row.kind) },
      }));
    }, output);
    this.readRows(db, 'users', row => {
      const sourceId = `user:${text(row.username)}`;
      return cursorRecord('user', number(row.updated_at), sourceId, record({
        profileId, store: this.id, sourceId, kind: 'identity',
        summary: summarize(text(row.history_summary) || `用户 ${text(row.username)}`),
        occurredAt: number(row.updated_at), importance: 0.75, confidence: 0.75,
        entities: [text(row.username)],
        metadata: { authorityType: 'user', username: text(row.username), hasPreferences: Boolean(row.preferences_json) },
      }));
    }, output);
    this.readRows(db, 'trajectory', row => {
      const sourceId = `trajectory:${number(row.ts)}`;
      const location = `${text(row.dimension)}:${number(row.x)},${number(row.y)},${number(row.z)}`;
      return cursorRecord('trajectory', number(row.ts), sourceId, record({
        profileId, store: this.id, sourceId, kind: 'spatial', summary: `轨迹 ${location}`,
        occurredAt: number(row.ts), importance: 0.15, confidence: 1, locationRefs: [location],
        metadata: { authorityType: 'trajectory', dimension: text(row.dimension), biome: text(row.biome) },
      }));
    }, output);
    return output;
  }

  private readRows(db: SqliteDatabase, table: string, map: (row: Row) => CursorRecord, output: CursorRecord[]): void {
    if (!hasTable(db, table)) return;
    for (const row of db.prepare(`SELECT * FROM ${table}`).all() as Row[]) output.push(map(row));
  }
}

export class PlannerEpisodeSourceAdapter implements MemorySourceAdapter {
  readonly id = 'planner-episode-ledger';

  constructor(private readonly dbPath: string) {}

  async scan(profileId: string, cursor: string | null, limit: number): Promise<MemorySourceBatch> {
    return page(readDatabase(this.dbPath, db => this.read(db, profileId)), cursor, limit);
  }

  private read(db: SqliteDatabase, profileId: string): CursorRecord[] {
    if (!hasTable(db, 'planner_episode_sessions')) return [];
    const sessions = db.prepare('SELECT * FROM planner_episode_sessions').all() as Row[];
    const facts = hasTable(db, 'planner_execution_facts')
      ? db.prepare('SELECT session_id,event_id,event_type,occurred_at FROM planner_execution_facts ORDER BY session_id,sequence').all() as Row[]
      : [];
    const bySession = new Map<string, Row[]>();
    for (const fact of facts) {
      const list = bySession.get(text(fact.session_id)) ?? [];
      list.push(fact);
      bySession.set(text(fact.session_id), list);
    }
    return sessions.map(row => {
      const sessionId = text(row.session_id);
      const sourceId = `session:${sessionId}`;
      const sessionFacts = bySession.get(sessionId) ?? [];
      const occurredAt = sessionFacts.length > 0 ? Date.parse(text(sessionFacts[0]!.occurred_at)) : Date.parse(text(row.updated_at));
      return cursorRecord('session', finiteTime(occurredAt), sourceId, record({
        profileId, store: this.id, sourceId, kind: 'task_experience',
        summary: `计划节点 ${text(row.node_id)}：${text(row.outcome) || text(row.state)}`,
        occurredAt: finiteTime(occurredAt), updatedAt: finiteTime(Date.parse(text(row.updated_at))),
        importance: text(row.state) === 'finalized' ? 0.75 : 0.45, confidence: 1,
        evidenceRefs: sessionFacts.map(fact => sourceKey(this.id, `fact:${text(fact.event_id)}`)),
        metadata: {
          authorityType: 'planner_episode', sessionId, runId: text(row.run_id),
          planRunId: text(row.plan_run_id), planRevision: number(row.plan_revision), nodeId: text(row.node_id),
          state: text(row.state), outcome: text(row.outcome),
        },
      }));
    });
  }
}

export class BotMemorySourceAdapter implements MemorySourceAdapter {
  readonly id = 'bot-memory';

  constructor(private readonly store: BotMemoryStore, private readonly ownerName?: string) {}

  async scan(profileId: string, cursor: string | null, limit: number): Promise<MemorySourceBatch> {
    const output: CursorRecord[] = [];
    for (const scope of ['user', 'memory'] as const) {
      for (const line of this.store.read(scope, this.ownerName)) {
        const digest = createHash('sha256').update(line).digest('hex');
        const sourceId = `${scope}:${digest}`;
        output.push(cursorRecord(scope, 0, sourceId, record({
          profileId, store: this.id, sourceId,
          kind: scope === 'user' ? 'preference' : 'event',
          status: 'candidate', summary: summarize(line), importance: scope === 'user' ? 0.55 : 0.35,
          confidence: 0.45, metadata: { authorityType: 'markdown', scope, compatibilityOnly: true },
        })));
      }
    }
    return page(output, cursor, limit);
  }
}

function record(input: {
  profileId: string;
  store: string;
  sourceId: string;
  kind: MemoryKind;
  summary: string;
  status?: MemoryStatus;
  occurredAt?: number;
  createdAt?: number;
  updatedAt?: number;
  importance: number;
  confidence: number;
  entities?: string[];
  locationRefs?: string[];
  evidenceRefs?: string[];
  metadata?: Record<string, unknown>;
  sourceRefs?: SourceRef[];
}): MemoryRecord {
  const createdAt = input.createdAt ?? input.occurredAt ?? 0;
  return {
    id: canonicalMemoryId(input.profileId, input.store, input.sourceId),
    profileId: input.profileId,
    kind: input.kind,
    status: input.status ?? 'active',
    summary: input.summary,
    ...(input.occurredAt == null ? {} : { occurredAt: input.occurredAt }),
    createdAt,
    updatedAt: input.updatedAt ?? createdAt,
    importance: clamp(input.importance),
    confidence: clamp(input.confidence),
    entities: unique(input.entities ?? []),
    locationRefs: unique(input.locationRefs ?? []),
    sourceRefs: input.sourceRefs ?? [{ store: input.store, id: input.sourceId }],
    evidenceRefs: unique(input.evidenceRefs ?? []),
    metadata: { ...input.metadata, sourceAdapterId: input.store },
  };
}

function withAdapter(recordValue: MemoryRecord, adapterId: string): MemoryRecord {
  return { ...recordValue, metadata: { ...recordValue.metadata, sourceAdapterId: adapterId } };
}

function cursorRecord(group: string, timestamp: number, sourceId: string, recordValue: MemoryRecord): CursorRecord {
  return { cursor: `${group}:${String(Math.max(0, timestamp)).padStart(16, '0')}:${sourceId}`, record: recordValue };
}

function page(records: CursorRecord[], cursor: string | null, limit: number): MemorySourceBatch {
  const sorted = records.sort((a, b) => a.cursor.localeCompare(b.cursor));
  const remaining = cursor == null ? sorted : sorted.filter(item => item.cursor > cursor);
  const selected = remaining.slice(0, Math.max(1, limit));
  const exhausted = selected.length === remaining.length;
  return {
    records: selected.map(item => item.record),
    nextCursor: selected.at(-1)?.cursor ?? cursor,
    exhausted,
    ...(exhausted ? { sourceCount: sorted.length } : {}),
  };
}

function readDatabase(dbPath: string, read: (db: SqliteDatabase) => CursorRecord[]): CursorRecord[] {
  if (!existsSync(dbPath)) return [];
  const db = openSqliteDatabase(dbPath, { readonly: true, fileMustExist: true });
  try { return read(db); } finally { db.close(); }
}

interface SqliteScanGroup {
  table: string;
  map: (row: Row) => MemoryRecord;
}

/** Rowid keyset pagination keeps multi-gigabyte authority stores out of process memory. */
function scanSqliteRows(
  dbPath: string,
  _profileId: string,
  cursor: string | null,
  limit: number,
  groups: SqliteScanGroup[],
): MemorySourceBatch {
  if (!existsSync(dbPath)) return { records: [], nextCursor: null, exhausted: true, sourceCount: 0 };
  const db = openSqliteDatabase(dbPath, { readonly: true, fileMustExist: true });
  try {
    const state = parseSqliteCursor(cursor);
    const records: MemoryRecord[] = [];
    let groupIndex = state.group;
    let rowid = state.rowid;
    const pageLimit = Math.max(1, limit);
    while (groupIndex < groups.length && records.length < pageLimit) {
      const group = groups[groupIndex]!;
      if (!hasTable(db, group.table)) {
        groupIndex += 1;
        rowid = 0;
        continue;
      }
      const remaining = pageLimit - records.length;
      const rows = db.prepare(`SELECT rowid AS __rowid,* FROM ${group.table} WHERE rowid>? ORDER BY rowid ASC LIMIT ?`)
        .all(rowid, remaining + 1) as Row[];
      const selected = rows.slice(0, remaining);
      records.push(...selected.map(group.map));
      if (selected.length > 0) rowid = number(selected.at(-1)?.__rowid);
      if (rows.length > remaining) {
        return { records, nextCursor: sqliteCursor(groupIndex, rowid), exhausted: false };
      }
      groupIndex += 1;
      rowid = 0;
    }
    const exhausted = groupIndex >= groups.length;
    return {
      records,
      nextCursor: exhausted ? null : sqliteCursor(groupIndex, rowid),
      exhausted,
      ...(exhausted ? { sourceCount: countSqliteRows(db, groups) } : {}),
    };
  } finally {
    db.close();
  }
}

function countSqliteRows(db: SqliteDatabase, groups: SqliteScanGroup[]): number {
  let count = 0;
  for (const group of groups) {
    if (!hasTable(db, group.table)) continue;
    count += (db.prepare(`SELECT COUNT(*) AS count FROM ${group.table}`).get() as { count: number }).count;
  }
  return count;
}

function parseSqliteCursor(cursor: string | null): { group: number; rowid: number } {
  if (!cursor) return { group: 0, rowid: 0 };
  try {
    const value = JSON.parse(cursor) as { group?: unknown; rowid?: unknown };
    const group = number(value.group, -1);
    const rowid = number(value.rowid, -1);
    if (!Number.isInteger(group) || group < 0 || !Number.isInteger(rowid) || rowid < 0) throw new Error('invalid');
    return { group, rowid };
  } catch {
    throw new Error(`[MemoryV2SourceAdapter] invalid cursor: ${cursor}`);
  }
}

function sqliteCursor(group: number, rowid: number): string {
  return JSON.stringify({ group, rowid });
}

function hasTable(db: SqliteDatabase, table: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

function sourceKey(store: string, id: string): string {
  return `${store}:${id}`;
}

function factKind(value: string): MemoryKind {
  if (['identity', 'boundary', 'preference', 'commitment'].includes(value)) return value as MemoryKind;
  return value === 'project' ? 'commitment' : 'event';
}

function factStatus(value: string): MemoryStatus {
  if (['active', 'candidate', 'superseded', 'deleted', 'expired'].includes(value)) return value as MemoryStatus;
  return 'candidate';
}

function eventImportance(level: string): number {
  if (['critical', 'error', 'danger'].includes(level.toLowerCase())) return 0.85;
  if (['warning', 'warn'].includes(level.toLowerCase())) return 0.65;
  return 0.4;
}

function payloadEntities(json: unknown): string[] {
  const value = jsonValue(json);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const row = value as Row;
  return unique(['entity', 'entityId', 'mob', 'target', 'username', 'player'].map(key => text(row[key])).filter(Boolean));
}

function jsonStrings(value: unknown): string[] {
  const parsed = jsonValue(value);
  return Array.isArray(parsed) ? parsed.filter(item => typeof item === 'string') : [];
}

function jsonValue(value: unknown): unknown {
  if (typeof value !== 'string' || !value) return null;
  try { return JSON.parse(value) as unknown; } catch { return null; }
}

function summarize(value: string, limit = 280): string {
  const clean = value.replace(/\s+/g, ' ').trim();
  return clean.length <= limit ? clean : `${clean.slice(0, limit - 1)}…`;
}

function text(value: unknown): string {
  return value == null ? '' : String(value);
}

function number(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function finiteTime(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))];
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}
