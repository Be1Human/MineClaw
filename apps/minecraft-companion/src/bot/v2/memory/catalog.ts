import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { openSqliteDatabase, type SqliteDatabase } from '../infra/sqliteDatabase.js';
import type { MemoryRecord, MemorySourceBatch, MemoryStatus } from './contracts.js';

export interface BackfillWatermark {
  adapterId: string;
  profileId: string;
  cursor: string | null;
  scanned: number;
  indexed: number;
  sourceCount?: number;
  completed: boolean;
  updatedAt: number;
}

export interface CatalogQuery {
  profileId: string;
  kind?: MemoryRecord['kind'];
  status?: MemoryStatus;
  limit?: number;
}

export interface CatalogSearch extends CatalogQuery {
  query?: string;
  from?: number;
  to?: number;
  entities?: string[];
  locations?: string[];
}

interface CatalogRow {
  id: string;
  profile_id: string;
  kind: MemoryRecord['kind'];
  status: MemoryStatus;
  summary: string;
  occurred_at: number | null;
  created_at: number;
  updated_at: number;
  importance: number;
  confidence: number;
  metadata_json: string;
}

/** Rebuildable metadata index. It never stores authoritative raw payloads. */
export class MemoryCatalog {
  private readonly db: SqliteDatabase;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.db = openSqliteDatabase(dbPath);
    this.initSchema();
  }

  applySourceBatch(adapterId: string, profileId: string, batch: MemorySourceBatch): BackfillWatermark {
    return this.db.transaction(() => {
      const previous = this.getWatermark(adapterId, profileId);
      for (const record of batch.records) {
        if (record.profileId !== profileId) {
          throw new Error(`[MemoryCatalog] profile mismatch: expected ${profileId}, got ${record.profileId}`);
        }
        this.upsertRecord(record, adapterId);
      }
      const next: BackfillWatermark = {
        adapterId,
        profileId,
        cursor: batch.nextCursor,
        scanned: (previous?.scanned ?? 0) + batch.records.length,
        indexed: this.countByAdapter(adapterId, profileId),
        ...(batch.sourceCount == null ? {} : { sourceCount: batch.sourceCount }),
        completed: batch.exhausted,
        updatedAt: Date.now(),
      };
      this.db.prepare(`
        INSERT INTO memory_backfill_watermarks
          (adapter_id,profile_id,cursor,scanned,indexed,source_count,completed,updated_at)
        VALUES (?,?,?,?,?,?,?,?)
        ON CONFLICT(adapter_id,profile_id) DO UPDATE SET
          cursor=excluded.cursor,scanned=excluded.scanned,indexed=excluded.indexed,
          source_count=COALESCE(excluded.source_count,memory_backfill_watermarks.source_count),
          completed=excluded.completed,updated_at=excluded.updated_at
      `).run(
        adapterId, profileId, next.cursor, next.scanned, next.indexed,
        next.sourceCount ?? null, next.completed ? 1 : 0, next.updatedAt,
      );
      return next;
    })();
  }

  getWatermark(adapterId: string, profileId: string): BackfillWatermark | null {
    const row = this.db.prepare(`
      SELECT adapter_id,profile_id,cursor,scanned,indexed,source_count,completed,updated_at
      FROM memory_backfill_watermarks WHERE adapter_id=? AND profile_id=?
    `).get(adapterId, profileId) as {
      adapter_id: string; profile_id: string; cursor: string | null; scanned: number;
      indexed: number; source_count: number | null; completed: number; updated_at: number;
    } | undefined;
    if (!row) return null;
    return {
      adapterId: row.adapter_id,
      profileId: row.profile_id,
      cursor: row.cursor,
      scanned: row.scanned,
      indexed: row.indexed,
      ...(row.source_count == null ? {} : { sourceCount: row.source_count }),
      completed: row.completed === 1,
      updatedAt: row.updated_at,
    };
  }

  query(input: CatalogQuery): MemoryRecord[] {
    const clauses = ['profile_id=?'];
    const params: unknown[] = [input.profileId];
    if (input.kind) { clauses.push('kind=?'); params.push(input.kind); }
    if (input.status) { clauses.push('status=?'); params.push(input.status); }
    const rows = this.db.prepare(`
      SELECT * FROM memory_catalog WHERE ${clauses.join(' AND ')}
      ORDER BY importance DESC, COALESCE(occurred_at,updated_at) DESC, id ASC LIMIT ?
    `).all(...params, input.limit ?? 100) as CatalogRow[];
    return this.hydrateMany(rows);
  }

  search(input: CatalogSearch): MemoryRecord[] {
    const clauses = ['c.profile_id=?'];
    const params: unknown[] = [input.profileId];
    const prefixParams: unknown[] = [];
    let fromSql = 'memory_catalog c';
    if (input.kind) { clauses.push('c.kind=?'); params.push(input.kind); }
    if (input.status) { clauses.push('c.status=?'); params.push(input.status); }
    if (input.from != null) { clauses.push('COALESCE(c.occurred_at,c.updated_at)>=?'); params.push(input.from); }
    if (input.to != null) { clauses.push('COALESCE(c.occurred_at,c.updated_at)<=?'); params.push(input.to); }
    const terms = searchTerms(input.query ?? '');
    if (terms.length > 0) {
      // Force the selective inverted index to drive the join. Otherwise SQLite may scan
      // the whole profile to satisfy ORDER BY before applying an IN subquery.
      fromSql = `(
        SELECT DISTINCT term_record_id FROM memory_record_terms
        WHERE profile_id=? AND term IN (${terms.map(() => '?').join(',')})
      ) matched CROSS JOIN memory_catalog c ON c.id=matched.term_record_id`;
      prefixParams.push(input.profileId, ...terms);
    }
    const entities = (input.entities ?? []).map(value => value.trim()).filter(Boolean);
    if (entities.length > 0) {
      clauses.push(`EXISTS(SELECT 1 FROM memory_record_entities e WHERE e.record_id=c.id AND e.entity IN (${entities.map(() => '?').join(',')}))`);
      params.push(...entities);
    }
    const locations = (input.locations ?? []).map(value => value.trim()).filter(Boolean);
    if (locations.length > 0) {
      clauses.push(`EXISTS(SELECT 1 FROM memory_record_locations l WHERE l.record_id=c.id AND l.location_ref IN (${locations.map(() => '?').join(',')}))`);
      params.push(...locations);
    }
    const rows = this.db.prepare(`
      SELECT c.* FROM ${fromSql} WHERE ${clauses.join(' AND ')}
      ORDER BY c.importance DESC, COALESCE(c.occurred_at,c.updated_at) DESC, c.id ASC LIMIT ?
    `).all(...prefixParams, ...params, input.limit ?? 300) as CatalogRow[];
    return this.hydrateMany(rows);
  }

  count(profileId: string): number {
    return (this.db.prepare('SELECT COUNT(*) AS count FROM memory_catalog WHERE profile_id=?')
      .get(profileId) as { count: number }).count;
  }

  countByAdapter(adapterId: string, profileId: string): number {
    return (this.db.prepare(`
      SELECT COUNT(DISTINCT record_id) AS count FROM memory_record_sources
      WHERE adapter_id=? AND profile_id=?
    `).get(adapterId, profileId) as { count: number }).count;
  }

  resetProfile(profileId: string): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM memory_catalog WHERE profile_id=?').run(profileId);
      this.db.prepare('DELETE FROM memory_backfill_watermarks WHERE profile_id=?').run(profileId);
    })();
  }

  close(): void {
    this.db.close();
  }

  private initSchema(): void {
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS memory_catalog (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        summary TEXT NOT NULL,
        occurred_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        importance REAL NOT NULL,
        confidence REAL NOT NULL,
        metadata_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memory_catalog_profile_kind_status
        ON memory_catalog(profile_id,kind,status);
      CREATE INDEX IF NOT EXISTS idx_memory_catalog_profile_time
        ON memory_catalog(profile_id,occurred_at DESC);
      CREATE TABLE IF NOT EXISTS memory_record_sources (
        record_id TEXT NOT NULL REFERENCES memory_catalog(id) ON DELETE CASCADE,
        profile_id TEXT NOT NULL,
        adapter_id TEXT NOT NULL,
        store TEXT NOT NULL,
        source_id TEXT NOT NULL,
        PRIMARY KEY(record_id,store,source_id)
      );
      CREATE INDEX IF NOT EXISTS idx_memory_sources_adapter
        ON memory_record_sources(adapter_id,profile_id);
      CREATE TABLE IF NOT EXISTS memory_record_evidence (
        record_id TEXT NOT NULL REFERENCES memory_catalog(id) ON DELETE CASCADE,
        evidence_ref TEXT NOT NULL,
        PRIMARY KEY(record_id,evidence_ref)
      );
      CREATE TABLE IF NOT EXISTS memory_record_entities (
        record_id TEXT NOT NULL REFERENCES memory_catalog(id) ON DELETE CASCADE,
        entity TEXT NOT NULL,
        PRIMARY KEY(record_id,entity)
      );
      CREATE TABLE IF NOT EXISTS memory_record_locations (
        record_id TEXT NOT NULL REFERENCES memory_catalog(id) ON DELETE CASCADE,
        location_ref TEXT NOT NULL,
        PRIMARY KEY(record_id,location_ref)
      );
      CREATE TABLE IF NOT EXISTS memory_record_terms (
        term_record_id TEXT NOT NULL REFERENCES memory_catalog(id) ON DELETE CASCADE,
        profile_id TEXT NOT NULL,
        term TEXT NOT NULL,
        PRIMARY KEY(term_record_id,term)
      );
      CREATE INDEX IF NOT EXISTS idx_memory_terms_lookup
        ON memory_record_terms(profile_id,term,term_record_id);
      CREATE TABLE IF NOT EXISTS memory_backfill_watermarks (
        adapter_id TEXT NOT NULL,
        profile_id TEXT NOT NULL,
        cursor TEXT,
        scanned INTEGER NOT NULL,
        indexed INTEGER NOT NULL,
        source_count INTEGER,
        completed INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(adapter_id,profile_id)
      );
    `);
    this.backfillMissingTerms();
  }

  private upsertRecord(record: MemoryRecord, adapterId: string): void {
    this.db.prepare(`
      INSERT INTO memory_catalog
        (id,profile_id,kind,status,summary,occurred_at,created_at,updated_at,importance,confidence,metadata_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        profile_id=excluded.profile_id,kind=excluded.kind,status=excluded.status,
        summary=excluded.summary,occurred_at=excluded.occurred_at,created_at=excluded.created_at,
        updated_at=excluded.updated_at,importance=excluded.importance,
        confidence=excluded.confidence,metadata_json=excluded.metadata_json
    `).run(
      record.id, record.profileId, record.kind, record.status, record.summary,
      record.occurredAt ?? null, record.createdAt, record.updatedAt,
      clamp(record.importance), clamp(record.confidence), JSON.stringify(record.metadata),
    );
    this.db.prepare('DELETE FROM memory_record_sources WHERE record_id=?').run(record.id);
    this.db.prepare('DELETE FROM memory_record_evidence WHERE record_id=?').run(record.id);
    this.db.prepare('DELETE FROM memory_record_entities WHERE record_id=?').run(record.id);
    this.db.prepare('DELETE FROM memory_record_locations WHERE record_id=?').run(record.id);
    this.db.prepare('DELETE FROM memory_record_terms WHERE term_record_id=?').run(record.id);
    const source = this.db.prepare(`INSERT INTO memory_record_sources(record_id,profile_id,adapter_id,store,source_id) VALUES(?,?,?,?,?)`);
    for (const ref of record.sourceRefs) source.run(record.id, record.profileId, adapterId, ref.store, ref.id);
    const evidence = this.db.prepare('INSERT INTO memory_record_evidence(record_id,evidence_ref) VALUES(?,?)');
    for (const ref of unique(record.evidenceRefs)) evidence.run(record.id, ref);
    const entity = this.db.prepare('INSERT INTO memory_record_entities(record_id,entity) VALUES(?,?)');
    for (const value of unique(record.entities)) entity.run(record.id, value);
    const location = this.db.prepare('INSERT INTO memory_record_locations(record_id,location_ref) VALUES(?,?)');
    for (const value of unique(record.locationRefs)) location.run(record.id, value);
    this.indexTerms(record.id, record.profileId, [record.summary, ...record.entities, ...record.locationRefs].join(' '));
  }

  private backfillMissingTerms(): void {
    const rows = this.db.prepare(`
      SELECT c.id,c.profile_id,c.summary FROM memory_catalog c
      WHERE NOT EXISTS(SELECT 1 FROM memory_record_terms t WHERE t.term_record_id=c.id)
    `).all() as Array<{ id: string; profile_id: string; summary: string }>;
    if (rows.length === 0) return;
    this.db.transaction(() => {
      for (const row of rows) this.indexTerms(row.id, row.profile_id, row.summary);
    })();
  }

  private indexTerms(recordId: string, profileId: string, text: string): void {
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO memory_record_terms(term_record_id,profile_id,term) VALUES(?,?,?)
    `);
    for (const term of searchTerms(text)) insert.run(recordId, profileId, term);
  }

  private hydrateMany(rows: CatalogRow[]): MemoryRecord[] {
    if (rows.length === 0) return [];
    const ids = rows.map(row => row.id);
    const placeholders = ids.map(() => '?').join(',');
    const sources = groupBy(this.db.prepare(`
      SELECT record_id,store,source_id FROM memory_record_sources
      WHERE record_id IN (${placeholders}) ORDER BY record_id,store,source_id
    `).all(...ids) as Array<{ record_id: string; store: string; source_id: string }>, row => row.record_id);
    const evidence = groupBy(this.db.prepare(`
      SELECT record_id,evidence_ref FROM memory_record_evidence
      WHERE record_id IN (${placeholders}) ORDER BY record_id,evidence_ref
    `).all(...ids) as Array<{ record_id: string; evidence_ref: string }>, row => row.record_id);
    const entities = groupBy(this.db.prepare(`
      SELECT record_id,entity FROM memory_record_entities
      WHERE record_id IN (${placeholders}) ORDER BY record_id,entity
    `).all(...ids) as Array<{ record_id: string; entity: string }>, row => row.record_id);
    const locations = groupBy(this.db.prepare(`
      SELECT record_id,location_ref FROM memory_record_locations
      WHERE record_id IN (${placeholders}) ORDER BY record_id,location_ref
    `).all(...ids) as Array<{ record_id: string; location_ref: string }>, row => row.record_id);
    return rows.map(row => ({
      id: row.id,
      profileId: row.profile_id,
      kind: row.kind,
      status: row.status,
      summary: row.summary,
      ...(row.occurred_at == null ? {} : { occurredAt: row.occurred_at }),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      importance: row.importance,
      confidence: row.confidence,
      sourceRefs: (sources.get(row.id) ?? []).map(item => ({ store: item.store, id: item.source_id })),
      evidenceRefs: (evidence.get(row.id) ?? []).map(item => item.evidence_ref),
      entities: (entities.get(row.id) ?? []).map(item => item.entity),
      locationRefs: (locations.get(row.id) ?? []).map(item => item.location_ref),
      metadata: safeObject(row.metadata_json),
    }));
  }
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))];
}

function safeObject(json: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(json);
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function groupBy<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const id = key(row);
    const values = grouped.get(id) ?? [];
    values.push(row);
    grouped.set(id, values);
  }
  return grouped;
}

function searchTerms(query: string): string[] {
  const normalized = query.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const values = normalized.match(/[a-z0-9_]{2,}|[\p{Script=Han}]{2,}/gu) ?? [];
  const terms: string[] = [];
  for (const value of values) {
    if (/^[\p{Script=Han}]+$/u.test(value) && value.length > 2) {
      for (let index = 0; index < value.length - 1; index += 1) terms.push(value.slice(index, index + 2));
    } else {
      terms.push(value);
    }
  }
  return [...new Set(terms)].filter(term => !['什么', '那个', '这个', '怎么', '我们', '你们'].includes(term)).slice(0, 12);
}
