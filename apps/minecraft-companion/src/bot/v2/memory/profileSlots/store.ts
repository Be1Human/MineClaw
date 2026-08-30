import { randomUUID } from 'node:crypto';
import type { SqliteDatabase } from '../../infra/sqliteDatabase.js';
import type { FactStatus } from '../../infra/chatMemory.js';
import { MEMORY_SLOT_CATALOG, getMemorySlotDefinition, getOpposingMemorySlotKey } from './catalog.js';
import type {
  MemorySlotDefinition,
  MemorySlotValue,
  MemorySlotView,
  PutMemorySlotValueInput,
} from './contracts.js';

interface SlotRow {
  id: string;
  profile_id: string;
  slot_key: string;
  catalog_version: number;
  value_json: string;
  normalized_key: string;
  status: FactStatus;
  confidence: number;
  importance: number;
  source_kind: MemorySlotValue['sourceKind'];
  supersedes_id: string | null;
  created_at: number;
  updated_at: number;
}

export class ProfileMemorySlotStore {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly profileId: string,
  ) {
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_slot_values (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL,
        slot_key TEXT NOT NULL,
        catalog_version INTEGER NOT NULL,
        value_json TEXT NOT NULL,
        normalized_key TEXT NOT NULL,
        status TEXT NOT NULL,
        confidence REAL NOT NULL,
        importance REAL NOT NULL,
        source_kind TEXT NOT NULL,
        supersedes_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memory_slot_values_profile_status
        ON memory_slot_values(profile_id, status, slot_key, updated_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_slot_values_active_unique
        ON memory_slot_values(profile_id, slot_key, normalized_key)
        WHERE status='active';
      CREATE TABLE IF NOT EXISTS memory_slot_evidence (
        slot_value_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        relation TEXT NOT NULL,
        PRIMARY KEY(slot_value_id, message_id)
      );
      CREATE INDEX IF NOT EXISTS idx_memory_slot_evidence_message
        ON memory_slot_evidence(message_id, slot_value_id);
    `);
  }

  catalog(input: { group?: string; filledOnly?: boolean; status?: FactStatus } = {}): MemorySlotView[] {
    const status = input.status ?? 'active';
    const values = this.values({ status });
    const bySlot = new Map<string, MemorySlotValue[]>();
    for (const value of values) {
      const current = bySlot.get(value.slotKey) ?? [];
      current.push(value);
      bySlot.set(value.slotKey, current);
    }
    return MEMORY_SLOT_CATALOG
      .filter(definition => !input.group || definition.group === input.group)
      .map(definition => ({ definition, values: bySlot.get(definition.slotKey) ?? [] }))
      .filter(view => !input.filledOnly || view.values.length > 0);
  }

  values(input: { status?: FactStatus; slotKey?: string; query?: string } = {}): MemorySlotValue[] {
    const clauses = ['v.profile_id=?'];
    const params: unknown[] = [this.profileId];
    if (input.status) { clauses.push('v.status=?'); params.push(input.status); }
    if (input.slotKey) { clauses.push('v.slot_key=?'); params.push(input.slotKey); }
    if (input.query?.trim()) { clauses.push('v.value_json LIKE ?'); params.push(`%${input.query.trim()}%`); }
    const rows = this.db.prepare(`
      SELECT v.* FROM memory_slot_values v
      WHERE ${clauses.join(' AND ')}
      ORDER BY v.importance DESC, v.confidence DESC, v.updated_at DESC
    `).all(...params) as SlotRow[];
    return rows.map(row => this.row(row));
  }

  get(id: string): MemorySlotValue | null {
    const row = this.db.prepare('SELECT * FROM memory_slot_values WHERE id=? AND profile_id=?')
      .get(id, this.profileId) as SlotRow | undefined;
    return row ? this.row(row) : null;
  }

  put(input: PutMemorySlotValueInput): MemorySlotValue | { rejected: string } {
    const definition = getMemorySlotDefinition(input.slotKey);
    if (!definition) return { rejected: 'unknown_slot_key' };
    const value = validateValue(definition, input.value);
    if (!value.ok) return { rejected: value.reason };
    const sourceIds = [...new Set(input.sourceMessageIds.filter(Boolean))].slice(0, 50);
    if (sourceIds.length === 0) return { rejected: 'owner_evidence_required' };
    if (!this.sourcesBelongToProfile(sourceIds)) return { rejected: 'owner_evidence_outside_profile' };
    if (definition.capturePolicy === 'explicit_only' && !['explicit_tool', 'manual_edit', 'migration'].includes(input.sourceKind)) {
      return { rejected: 'explicit_capture_required' };
    }
    const status = input.status ?? 'active';
    const now = Date.now();
    const normalizedKey = definition.valueType === 'set' ? normalize(value.value) : '__scalar__';
    const existing = this.db.prepare(`
      SELECT * FROM memory_slot_values
      WHERE profile_id=? AND slot_key=? AND normalized_key=? AND status=?
        AND (?='set' OR value_json=?)
      ORDER BY updated_at DESC LIMIT 1
    `).get(this.profileId, input.slotKey, normalizedKey, status, definition.valueType, JSON.stringify(value.value)) as SlotRow | undefined;
    if (existing) {
      const updated = this.db.transaction(() => {
        if (status === 'active') this.supersedeOpposingActiveValue(input.slotKey, normalizedKey, now);
        this.addEvidence(existing.id, sourceIds, 'supports');
        this.db.prepare('UPDATE memory_slot_values SET confidence=?,importance=?,updated_at=? WHERE id=?')
          .run(Math.max(existing.confidence, clamp(input.confidence ?? 0.85)), Math.max(existing.importance, clamp(input.importance ?? 0.7)), now, existing.id);
        return this.get(existing.id)!;
      });
      return updated();
    }

    const write = this.db.transaction((): MemorySlotValue => {
      let supersedesId: string | undefined;
      if (status === 'active') supersedesId = this.supersedeOpposingActiveValue(input.slotKey, normalizedKey, now);
      if (status === 'active' && definition.valueType !== 'set') {
        const previous = this.db.prepare(`SELECT id FROM memory_slot_values WHERE profile_id=? AND slot_key=? AND status='active' ORDER BY updated_at DESC LIMIT 1`)
          .get(this.profileId, input.slotKey) as { id: string } | undefined;
        supersedesId = previous?.id;
        if (previous) this.db.prepare(`UPDATE memory_slot_values SET status='superseded',updated_at=? WHERE id=?`).run(now, previous.id);
      }
      const record: MemorySlotValue = {
        id: `slot-${randomUUID()}`,
        profileId: this.profileId,
        slotKey: definition.slotKey,
        catalogVersion: definition.catalogVersion,
        value: value.value,
        normalizedKey,
        status,
        confidence: clamp(input.confidence ?? (status === 'candidate' ? 0.5 : 0.85)),
        importance: clamp(input.importance ?? 0.7),
        sourceKind: input.sourceKind,
        sourceMessageIds: sourceIds,
        supersedesId,
        createdAt: now,
        updatedAt: now,
      };
      this.db.prepare(`INSERT INTO memory_slot_values VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        record.id, record.profileId, record.slotKey, record.catalogVersion, JSON.stringify(record.value), record.normalizedKey,
        record.status, record.confidence, record.importance, record.sourceKind, record.supersedesId ?? null, record.createdAt, record.updatedAt,
      );
      this.addEvidence(record.id, sourceIds, 'supports');
      return record;
    });
    try { return write(); } catch (error) {
      return { rejected: error instanceof Error ? error.message : 'slot_write_failed' };
    }
  }

  replace(id: string, value: unknown, sourceMessageIds: string[], sourceKind: MemorySlotValue['sourceKind'] = 'manual_edit'): MemorySlotValue | { rejected: string } | null {
    const old = this.get(id);
    if (!old || old.status !== 'active') return null;
    const next = this.put({
      slotKey: old.slotKey,
      value,
      status: 'active',
      confidence: 1,
      importance: old.importance,
      sourceKind,
      sourceMessageIds,
    });
    if ('rejected' in next) return next;
    if (next.id !== old.id) {
      this.db.prepare(`UPDATE memory_slot_values SET status='superseded',updated_at=? WHERE id=? AND profile_id=? AND status='active'`)
        .run(Date.now(), old.id, this.profileId);
    }
    return next;
  }

  remove(id: string): boolean {
    return this.db.prepare(`UPDATE memory_slot_values SET status='deleted',updated_at=? WHERE id=? AND profile_id=? AND status='active'`)
      .run(Date.now(), id, this.profileId).changes > 0;
  }

  restore(id: string): MemorySlotValue | null {
    const old = this.get(id);
    if (!old || !['deleted', 'superseded'].includes(old.status)) return null;
    const sources = old.sourceMessageIds;
    const restored = this.put({
      slotKey: old.slotKey,
      value: old.value,
      status: 'active',
      confidence: old.confidence,
      importance: old.importance,
      sourceKind: 'manual_edit',
      sourceMessageIds: sources,
    });
    return 'rejected' in restored ? null : restored;
  }

  sourceMessageIds(id: string): string[] {
    return (this.db.prepare(`SELECT message_id FROM memory_slot_evidence WHERE slot_value_id=? ORDER BY message_id`).all(id) as Array<{ message_id: string }>)
      .map(row => row.message_id);
  }

  countActiveSlots(): number {
    const row = this.db.prepare(`SELECT COUNT(DISTINCT slot_key) AS count FROM memory_slot_values WHERE profile_id=? AND status='active'`)
      .get(this.profileId) as { count: number };
    return Number(row.count);
  }

  private row(row: SlotRow): MemorySlotValue {
    return {
      id: row.id,
      profileId: row.profile_id,
      slotKey: row.slot_key,
      catalogVersion: row.catalog_version,
      value: JSON.parse(row.value_json) as unknown,
      normalizedKey: row.normalized_key,
      status: row.status,
      confidence: row.confidence,
      importance: row.importance,
      sourceKind: row.source_kind,
      sourceMessageIds: this.sourceMessageIds(row.id),
      supersedesId: row.supersedes_id ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private sourcesBelongToProfile(ids: string[]): boolean {
    const placeholders = ids.map(() => '?').join(',');
    const row = this.db.prepare(`SELECT COUNT(*) AS count FROM chat_messages WHERE profile_id=? AND role='owner' AND id IN (${placeholders})`)
      .get(this.profileId, ...ids) as { count: number };
    return Number(row.count) === ids.length;
  }

  private addEvidence(valueId: string, sourceIds: string[], relation: string): void {
    const insert = this.db.prepare('INSERT OR IGNORE INTO memory_slot_evidence(slot_value_id,message_id,relation) VALUES(?,?,?)');
    for (const sourceId of sourceIds) insert.run(valueId, sourceId, relation);
  }

  private supersedeOpposingActiveValue(slotKey: string, normalizedKey: string, now: number): string | undefined {
    const opposingSlotKey = getOpposingMemorySlotKey(slotKey);
    if (!opposingSlotKey) return undefined;
    const opposing = this.db.prepare(`
      SELECT id FROM memory_slot_values
      WHERE profile_id=? AND slot_key=? AND normalized_key=? AND status='active'
      ORDER BY updated_at DESC LIMIT 1
    `).get(this.profileId, opposingSlotKey, normalizedKey) as { id: string } | undefined;
    if (opposing) {
      this.db.prepare(`UPDATE memory_slot_values SET status='superseded',updated_at=? WHERE id=?`)
        .run(now, opposing.id);
    }
    return opposing?.id;
  }
}

function validateValue(definition: MemorySlotDefinition, input: unknown): { ok: true; value: unknown } | { ok: false; reason: string } {
  if (definition.valueType === 'structured') {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, reason: 'structured_value_required' };
    const encoded = JSON.stringify(input);
    return encoded.length <= 1200 && safeText(encoded) ? { ok: true, value: input } : { ok: false, reason: 'invalid_slot_value' };
  }
  if (typeof input !== 'string') return { ok: false, reason: 'string_value_required' };
  const clean = input.trim().replace(/\s+/g, ' ');
  if (!clean || clean.length > 280 || !safeText(clean)) return { ok: false, reason: 'invalid_slot_value' };
  if (definition.valueType === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(clean)) return { ok: false, reason: 'iso_date_required' };
  return { ok: true, value: clean };
}

function safeText(text: string): boolean {
  return !/[\u0000-\u001F\u007F]/.test(text)
    && !/(?:api[_ -]?key|password|passwd|token|secret|sk-[\w-]{8,})/i.test(text)
    && !/(?:ignore (?:all |previous|above)?\s*instructions|system prompt|开发者消息|忽略(?:之前|以上)?指令)/i.test(text);
}

function normalize(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase().replace(/\s+/g, ' ') : JSON.stringify(value);
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}
