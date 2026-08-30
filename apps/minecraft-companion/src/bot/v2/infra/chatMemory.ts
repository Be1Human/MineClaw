/**
 * FEAT-MEM-09 · 纯聊天分层记忆
 *
 * 只管理 Profile 作用域内的聊天消息、长期事实和会话摘要；不承载地点、物品、
 * 任务或世界状态。所有派生内容都保留来源消息，原始消息是可重建的权威数据。
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  openSqliteDatabase,
  type SqliteDatabase,
} from './sqliteDatabase.js';
import {
  ProfileMemorySlotStore,
  classifyOwnerMemorySpeech,
  getMemorySlotDefinition,
  isExplicitMemoryStatement,
  routeDeterministicMemorySlot,
  searchMemorySlotDefinitions,
  type MemorySlotSourceKind,
  type MemorySlotValue,
  type MemorySlotView,
  type PutMemorySlotValueInput,
} from '../memory/profileSlots/index.js';
import { tuning } from './tuning.js';

export type ChatRole = 'owner' | 'bot' | 'system';
export type FactStatus = 'candidate' | 'active' | 'superseded' | 'deleted' | 'rejected' | 'expired';
export type FactKind = 'preference' | 'identity' | 'relationship' | 'commitment' | 'boundary' | 'project' | 'agent_note';

export interface ChatMessage {
  id: string;
  sessionId: string;
  role: ChatRole;
  content: string;
  timestamp: number;
}

export interface MemoryFact {
  id: string;
  profileId: string;
  scope: 'user' | 'agent';
  kind: FactKind;
  text: string;
  status: FactStatus;
  confidence: number;
  importance: number;
  sourceMessageIds: string[];
  supersedesId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface ConversationSummary {
  id: string;
  profileId: string;
  sessionId: string;
  coveredMessageIds: string[];
  summary: string;
  openLoops: string[];
  commitments: string[];
  createdAt: number;
}

export type MemoryConsolidationAction = 'add' | 'reinforce' | 'replace' | 'candidate' | 'ignore';

export interface MemoryConsolidationOperation {
  action: MemoryConsolidationAction;
  kind?: FactKind;
  text?: string;
  slotKey?: string;
  value?: unknown;
  sourceMessageIds: string[];
  targetFactId?: string;
  confidence?: number;
  importance?: number;
}

export interface MemoryConsolidationCommitResult {
  processed: number;
  added: number;
  reinforced: number;
  replaced: number;
  candidates: number;
  ignored: number;
}

export interface EmbeddingProvider {
  readonly id: string;
  embed(text: string): readonly number[];
}

/** 无网络依赖的可插拔基线；生产可替换为任意同步本地 Embedding provider。 */
export class LocalTokenEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'local-token-hash-v1';
  constructor(private readonly dimensions = 96) {}

  embed(text: string): readonly number[] {
    const vector = Array.from({ length: this.dimensions }, () => 0);
    for (const token of normalizedTokens(text)) {
      const hash = stableTokenHash(token);
      vector[Math.abs(hash) % this.dimensions]! += hash < 0 ? -1 : 1;
    }
    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    return norm > 0 ? vector.map(value => value / norm) : vector;
  }
}

export interface ChatMemoryConfig {
  dbPath: string;
  profileId: string;
  promptBudgetChars?: number;
  autoCapture?: boolean | (() => boolean);
  /** 同一会话累计达到该字符数时，先保留原文并生成摘要。0 表示关闭自动 Flush。 */
  flushThresholdChars?: number;
  embeddingProvider?: EmbeddingProvider | null;
}

export interface ChatMemoryMetrics {
  captured: number;
  rejected: Record<string, number>;
  flushes: number;
  retrievals: number;
  retrievalLatencyMs: number;
  embeddingRequests: number;
  embeddingFailures: number;
  embeddingFallbacks: number;
}

export interface MemoryPromptContext {
  text: string;
  retrievalMode: 'fts5' | 'hybrid';
  retrievedFactIds: string[];
  retrievedSlotValueIds: string[];
  retrievedMessageIds: string[];
  includedSummary: boolean;
}

interface FactRow {
  id: string; profile_id: string; scope: string; kind: string; text: string; status: FactStatus;
  confidence: number; importance: number; source_ids_json: string; supersedes_id: string | null;
  created_at: number; updated_at: number;
}

const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const INVISIBLE_FORMAT = /\p{Cf}/u;
const SECRET = /(?:api[_ -]?key|password|passwd|token|secret|sk-[\w-]{8,})/i;
const PROMPT_INJECTION = /(?:ignore (?:all |previous |above )?instructions|system prompt|开发者消息|忽略(?:之前|以上)?指令)/i;
const TRANSIENT = /^(?:你好|嗨|哈哈|谢谢|谢谢你|晚安|早上好|我今天(?:有点)?累|hello|hi|thanks|thank you|good night)[！!。？?!.]*$/i;

/**
 * BUG-MEM-18 · 注入给模型的证据权限必须和持久层 provenance 一致。
 * 固定放在 Context 头部并计入预算，不能为了多塞一条召回结果而省略。
 */
export const MEMORY_EVIDENCE_RULES = [
  '证据规则：与用户身份、经历、行为或偏好有关的结论，只能由 user 事实或 owner 原话支持；bot/agent 内容只能证明助手曾说过什么。',
  '对“我记得/喜欢什么”等回忆查询，官方记忆槽表示该主题当前完整权威值；相关历史只能补充，不能删减或覆盖槽位；若用户当前消息明确修改偏好，则以当前消息为准。',
  '回答前逐项核对问题中的主体、角色、时间、关系和数量；没有明确关系时不得拼接独立事实。',
  '必要前提缺失、歧义或不匹配时，应说明不知道或向用户澄清，不得把推断写成用户事实。',
].join('\n');

export function validateFactText(text: string): { ok: true; text: string } | { ok: false; reason: string } {
  const clean = text.trim().replace(/\s+/g, ' ');
  if (!clean) return { ok: false, reason: 'empty' };
  if (clean.length > 280) return { ok: false, reason: 'too_long' };
  if (CONTROL.test(clean)) return { ok: false, reason: 'control_character' };
  if (INVISIBLE_FORMAT.test(clean)) return { ok: false, reason: 'invisible_format_character' };
  if (SECRET.test(clean)) return { ok: false, reason: 'sensitive_secret' };
  if (PROMPT_INJECTION.test(clean)) return { ok: false, reason: 'prompt_injection' };
  if (TRANSIENT.test(clean)) return { ok: false, reason: 'transient' };
  return { ok: true, text: clean };
}

export class ChatMemoryService {
  private readonly db: SqliteDatabase;
  private readonly profileId: string;
  private readonly budget: number;
  private readonly autoCapture: () => boolean;
  private readonly flushThresholdChars: number;
  private readonly embeddingProvider: EmbeddingProvider | null;
  private readonly slotStore: ProfileMemorySlotStore;
  private readonly metrics: ChatMemoryMetrics = {
    captured: 0,
    rejected: {},
    flushes: 0,
    retrievals: 0,
    retrievalLatencyMs: 0,
    embeddingRequests: 0,
    embeddingFailures: 0,
    embeddingFallbacks: 0,
  };
  private lastQuery = '';
  private seq = 0;

  constructor(cfg: ChatMemoryConfig) {
    if (!cfg.profileId.trim()) throw new Error('profileId is required');
    mkdirSync(dirname(cfg.dbPath), { recursive: true });
    this.db = openSqliteDatabase(cfg.dbPath);
    this.profileId = cfg.profileId;
    this.budget = cfg.promptBudgetChars ?? 6000;
    const autoCapture = cfg.autoCapture;
    this.autoCapture = typeof autoCapture === 'function'
      ? autoCapture
      : () => autoCapture ?? true;
    this.flushThresholdChars = cfg.flushThresholdChars ?? 12000;
    this.embeddingProvider = cfg.embeddingProvider ?? null;
    this.init();
    this.slotStore = new ProfileMemorySlotStore(this.db, this.profileId);
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chat_messages (
        id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, session_id TEXT NOT NULL,
        role TEXT NOT NULL, content TEXT NOT NULL, ts INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_chat_messages_scope_time ON chat_messages(profile_id, ts);
      CREATE TABLE IF NOT EXISTS memory_facts (
        id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, scope TEXT NOT NULL, kind TEXT NOT NULL,
        text TEXT NOT NULL, status TEXT NOT NULL, confidence REAL NOT NULL, importance REAL NOT NULL,
        source_ids_json TEXT NOT NULL, supersedes_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memory_facts_scope_status ON memory_facts(profile_id, status, updated_at DESC);
      CREATE TABLE IF NOT EXISTS conversation_summaries (
        id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, session_id TEXT NOT NULL,
        covered_ids_json TEXT NOT NULL, summary TEXT NOT NULL, open_loops_json TEXT NOT NULL,
        commitments_json TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_summaries_scope_session ON conversation_summaries(profile_id, session_id, created_at DESC);
      CREATE VIRTUAL TABLE IF NOT EXISTS chat_messages_fts USING fts5(
        profile_id UNINDEXED, message_id UNINDEXED, content, tokenize='unicode61'
      );
      CREATE TABLE IF NOT EXISTS chat_message_relations (
        profile_id TEXT NOT NULL, message_id TEXT NOT NULL, subject TEXT NOT NULL,
        relation TEXT NOT NULL, object TEXT NOT NULL, ts INTEGER NOT NULL,
        PRIMARY KEY(profile_id, message_id)
      );
      CREATE INDEX IF NOT EXISTS idx_chat_relations_subject ON chat_message_relations(profile_id, subject, ts DESC);
      CREATE TABLE IF NOT EXISTS chat_message_embeddings (
        profile_id TEXT NOT NULL, message_id TEXT NOT NULL, provider_id TEXT NOT NULL,
        vector_json TEXT NOT NULL, ts INTEGER NOT NULL,
        PRIMARY KEY(profile_id, message_id, provider_id)
      );
      CREATE INDEX IF NOT EXISTS idx_chat_embeddings_provider ON chat_message_embeddings(profile_id, provider_id, ts DESC);
      CREATE TABLE IF NOT EXISTS chat_memory_consolidation_messages (
        profile_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        status TEXT NOT NULL,
        processed_at INTEGER NOT NULL,
        run_id TEXT NOT NULL,
        PRIMARY KEY(profile_id, message_id)
      );
      CREATE INDEX IF NOT EXISTS idx_chat_memory_consolidation_run
        ON chat_memory_consolidation_messages(profile_id, processed_at DESC);
    `);
  }

  recordMessage(message: ChatMessage): void {
    if (!message.id || !message.content.trim()) return;
    this.db.prepare(`INSERT OR REPLACE INTO chat_messages(id,profile_id,session_id,role,content,ts) VALUES(?,?,?,?,?,?)`)
      .run(message.id, this.profileId, message.sessionId, message.role, message.content, message.timestamp);
    this.db.prepare(`DELETE FROM chat_messages_fts WHERE profile_id=? AND message_id=?`).run(this.profileId, message.id);
    this.db.prepare(`INSERT INTO chat_messages_fts(profile_id,message_id,content) VALUES(?,?,?)`).run(this.profileId, message.id, message.content);
    this.db.prepare(`DELETE FROM chat_message_relations WHERE profile_id=? AND message_id=?`).run(this.profileId, message.id);
    const triple = parseFactTriple(message.content);
    if (triple) {
      this.db.prepare(`INSERT INTO chat_message_relations(profile_id,message_id,subject,relation,object,ts) VALUES(?,?,?,?,?,?)`)
        .run(this.profileId, message.id, normalizeRelationEntity(triple.subject), triple.relation, triple.object, message.timestamp);
    }
    this.indexEmbedding(message);
    if (message.role === 'owner') {
      this.lastQuery = message.content;
      this.applyExplicitIntent(message);
      if (this.autoCapture()) this.captureCandidate(message);
    }
  }

  /** 历史迁移/Benchmark 批量回放入口；语义与逐条 recordMessage 相同，但只提交一个 SQLite 事务。 */
  recordMessages(messages: ChatMessage[]): { recorded: number } {
    const valid = messages.filter(message => message.id && message.content.trim());
    const insertMessage = this.db.prepare(`INSERT OR REPLACE INTO chat_messages(id,profile_id,session_id,role,content,ts) VALUES(?,?,?,?,?,?)`);
    const deleteFts = this.db.prepare(`DELETE FROM chat_messages_fts WHERE profile_id=? AND message_id=?`);
    const insertFts = this.db.prepare(`INSERT INTO chat_messages_fts(profile_id,message_id,content) VALUES(?,?,?)`);
    const deleteRelation = this.db.prepare(`DELETE FROM chat_message_relations WHERE profile_id=? AND message_id=?`);
    const insertRelation = this.db.prepare(`INSERT INTO chat_message_relations(profile_id,message_id,subject,relation,object,ts) VALUES(?,?,?,?,?,?)`);
    const deleteEmbedding = this.db.prepare(`DELETE FROM chat_message_embeddings WHERE profile_id=? AND message_id=?`);
    this.db.transaction(() => {
      for (const message of valid) {
        insertMessage.run(message.id, this.profileId, message.sessionId, message.role, message.content, message.timestamp);
        deleteFts.run(this.profileId, message.id);
        insertFts.run(this.profileId, message.id, message.content);
        deleteRelation.run(this.profileId, message.id);
        const triple = parseFactTriple(message.content);
        if (triple) insertRelation.run(this.profileId, message.id, normalizeRelationEntity(triple.subject), triple.relation, triple.object, message.timestamp);
        if (this.embeddingProvider) this.indexEmbedding(message); else deleteEmbedding.run(this.profileId, message.id);
        if (message.role === 'owner') {
          this.lastQuery = message.content;
          this.applyExplicitIntent(message);
          if (this.autoCapture()) this.captureCandidate(message);
        }
      }
    })();
    return { recorded: valid.length };
  }

  private indexEmbedding(message: ChatMessage): void {
    this.db.prepare(`DELETE FROM chat_message_embeddings WHERE profile_id=? AND message_id=?`).run(this.profileId, message.id);
    if (!this.embeddingProvider) return;
    this.metrics.embeddingRequests += 1;
    try {
      const vector = [...this.embeddingProvider.embed(message.content)];
      if (vector.length === 0 || vector.some(value => !Number.isFinite(value))) throw new Error('invalid embedding vector');
      this.db.prepare(`INSERT INTO chat_message_embeddings(profile_id,message_id,provider_id,vector_json,ts) VALUES(?,?,?,?,?)`)
        .run(this.profileId, message.id, this.embeddingProvider.id, JSON.stringify(vector), message.timestamp);
    } catch {
      this.metrics.embeddingFailures += 1;
    }
  }

  addFact(input: Omit<MemoryFact, 'id' | 'profileId' | 'createdAt' | 'updatedAt' | 'status'> & { status?: FactStatus }): MemoryFact | { rejected: string } {
    const verdict = validateFactText(input.text);
    if (!verdict.ok) return { rejected: verdict.reason };
    const now = Date.now();
    const requestedStatus = input.status ?? 'active';
    const existing = this.getFacts().find(f =>
      f.scope === input.scope
      && f.text === verdict.text
      && (f.status === requestedStatus || (requestedStatus === 'candidate' && f.status === 'active')));
    if (existing) {
      const merged = [...new Set([...existing.sourceMessageIds, ...input.sourceMessageIds])];
      const promotionCount = Math.max(1, Math.floor(tuning().memoryConsolidation.dynamicPromotionEvidenceCount));
      const nextStatus = existing.status === 'candidate' && requestedStatus === 'candidate' && merged.length >= promotionCount
        ? 'active'
        : existing.status;
      this.db.prepare(`UPDATE memory_facts SET source_ids_json=?,status=?,confidence=?,importance=?,updated_at=? WHERE id=?`)
        .run(JSON.stringify(merged), nextStatus, Math.max(existing.confidence, input.confidence), Math.max(existing.importance, input.importance), now, existing.id);
      return { ...existing, status: nextStatus, sourceMessageIds: merged, confidence: Math.max(existing.confidence, input.confidence), importance: Math.max(existing.importance, input.importance), updatedAt: now };
    }
    const fact: MemoryFact = {
      id: `fact-${now}-${++this.seq}`, profileId: this.profileId, scope: input.scope, kind: input.kind,
      text: verdict.text, status: input.status ?? 'active', confidence: clamp(input.confidence), importance: clamp(input.importance),
      sourceMessageIds: [...new Set(input.sourceMessageIds)], createdAt: now, updatedAt: now,
    };
    this.persistFact(fact);
    return fact;
  }

  /** save_memory 兼容入口：由调用方传入已经落库的对话来源，保证事实可追溯。 */
  saveToolFact(text: string, scope: 'user' | 'agent', sourceMessageIds: string[]): MemoryFact | MemorySlotValue | { rejected: string } {
    const route = scope === 'user' ? routeDeterministicMemorySlot(text) : null;
    if (route?.operation === 'add') {
      return this.putMemorySlotValue({
        slotKey: route.slotKey,
        value: route.value,
        confidence: 1,
        importance: 0.9,
        sourceKind: 'explicit_tool',
        sourceMessageIds,
      });
    }
    const result = this.addFact({
      scope,
      kind: scope === 'agent' ? 'agent_note' : inferKind(text),
      text,
      confidence: 1,
      importance: 0.9,
      sourceMessageIds,
    });
    if ('rejected' in result) this.noteRejected(result.rejected);
    return result;
  }

  /** 控制面手工新增没有聊天消息可引用时，先创建显式 provenance 消息再写事实。 */
  addManualFact(input: Omit<MemoryFact, 'id' | 'profileId' | 'createdAt' | 'updatedAt' | 'status' | 'sourceMessageIds'>): MemoryFact | { rejected: string } {
    const now = Date.now();
    const sourceId = `manual-${now}-${++this.seq}`;
    this.recordMessage({
      id: sourceId,
      sessionId: 'memory-control-plane',
      role: 'owner',
      content: `记忆控制面手工录入：${input.text}`,
      timestamp: now,
    });
    const result = this.addFact({ ...input, sourceMessageIds: [sourceId] });
    if ('rejected' in result) this.noteRejected(result.rejected);
    return result;
  }

  replaceFact(id: string, text: string, sourceMessageIds: string[]): MemoryFact | { rejected: string } | null {
    const old = this.getFact(id);
    if (!old || old.status !== 'active') return null;
    const verdict = validateFactText(text);
    if (!verdict.ok) return { rejected: verdict.reason };
    const sources = [...new Set(sourceMessageIds)];
    if (sources.length === 0) {
      const sourceId = `manual-edit-${Date.now()}-${++this.seq}`;
      this.recordMessage({
        id: sourceId,
        sessionId: 'memory-control-plane',
        role: 'owner',
        content: `记忆控制面修改为：${verdict.text}`,
        timestamp: Date.now(),
      });
      sources.push(sourceId);
    }

    // 幂等修改：相同正文只补来源，不能把唯一 Active 版本自我 supersede。
    if (old.text === verdict.text) {
      const now = Date.now();
      const merged = [...new Set([...old.sourceMessageIds, ...sources])];
      this.db.prepare(`UPDATE memory_facts SET source_ids_json=?,confidence=1,updated_at=? WHERE id=? AND profile_id=? AND status='active'`)
        .run(JSON.stringify(merged), now, old.id, this.profileId);
      return { ...old, sourceMessageIds: merged, confidence: 1, updatedAt: now };
    }

    const replace = this.db.transaction((): MemoryFact => {
      const now = Date.now();
      const duplicate = this.getFacts({ status: 'active' }).find(fact => fact.id !== old.id && fact.scope === old.scope && fact.text === verdict.text);
      let next: MemoryFact;
      if (duplicate) {
        const merged = [...new Set([...duplicate.sourceMessageIds, ...sources])];
        this.db.prepare(`UPDATE memory_facts SET source_ids_json=?,confidence=1,importance=?,supersedes_id=?,updated_at=? WHERE id=? AND profile_id=?`)
          .run(JSON.stringify(merged), Math.max(duplicate.importance, old.importance), old.id, now, duplicate.id, this.profileId);
        next = { ...duplicate, sourceMessageIds: merged, confidence: 1, importance: Math.max(duplicate.importance, old.importance), supersedesId: old.id, updatedAt: now };
      } else {
        next = {
          id: `fact-${now}-${++this.seq}`,
          profileId: this.profileId,
          scope: old.scope,
          kind: old.kind,
          text: verdict.text,
          status: 'active',
          confidence: 1,
          importance: old.importance,
          sourceMessageIds: sources,
          supersedesId: old.id,
          createdAt: now,
          updatedAt: now,
        };
        this.persistFact(next);
      }
      this.db.prepare(`UPDATE memory_facts SET status='superseded',updated_at=? WHERE id=? AND profile_id=? AND status='active'`)
        .run(now, old.id, this.profileId);
      return next;
    });
    return replace();
  }

  removeFact(id: string): boolean {
    const res = this.db.prepare(`UPDATE memory_facts SET status='deleted',updated_at=? WHERE id=? AND profile_id=? AND status='active'`)
      .run(Date.now(), id, this.profileId);
    return res.changes > 0;
  }

  getFacts(filter: { status?: FactStatus; query?: string } = {}): MemoryFact[] {
    const clauses = ['profile_id=?'];
    const params: unknown[] = [this.profileId];
    if (filter.status) { clauses.push('status=?'); params.push(filter.status); }
    if (filter.query?.trim()) { clauses.push('text LIKE ?'); params.push(`%${filter.query.trim()}%`); }
    const rows = this.db.prepare(`SELECT * FROM memory_facts WHERE ${clauses.join(' AND ')} ORDER BY importance DESC, confidence DESC, updated_at DESC`).all(...params) as FactRow[];
    return rows.map(rowToFact);
  }

  getFact(id: string): MemoryFact | null {
    const row = this.db.prepare(`SELECT * FROM memory_facts WHERE id=? AND profile_id=?`).get(id, this.profileId) as FactRow | undefined;
    return row ? rowToFact(row) : null;
  }

  getMessagesByIds(ids: string[]): ChatMessage[] {
    const unique = [...new Set(ids.filter(Boolean))].slice(0, 100);
    if (unique.length === 0) return [];
    const rows = this.db.prepare(`SELECT id,session_id,role,content,ts FROM chat_messages WHERE profile_id=? AND id IN (${unique.map(() => '?').join(',')}) ORDER BY ts ASC`)
      .all(this.profileId, ...unique) as Array<{ id: string; session_id: string; role: ChatRole; content: string; ts: number }>;
    return rows.map(row => ({ id: row.id, sessionId: row.session_id, role: row.role, content: row.content, timestamp: row.ts }));
  }

  approveFact(id: string): MemoryFact | null {
    const fact = this.getFact(id);
    if (!fact || fact.status !== 'candidate') return null;
    const now = Date.now();
    this.db.prepare(`UPDATE memory_facts SET status='active',confidence=1,updated_at=? WHERE id=? AND profile_id=? AND status='candidate'`)
      .run(now, id, this.profileId);
    return { ...fact, status: 'active', confidence: 1, updatedAt: now };
  }

  rejectFact(id: string): boolean {
    return this.db.prepare(`UPDATE memory_facts SET status='rejected',updated_at=? WHERE id=? AND profile_id=? AND status='candidate'`)
      .run(Date.now(), id, this.profileId).changes > 0;
  }

  mapFactToMemorySlot(id: string, slotKey: string, value: unknown): MemorySlotValue | { rejected: string } | null {
    const fact = this.getFact(id);
    if (!fact || !['candidate', 'active'].includes(fact.status) || fact.scope !== 'user') return null;
    const mapped = this.putMemorySlotValue({
      slotKey,
      value,
      confidence: 1,
      importance: fact.importance,
      sourceKind: 'manual_edit',
      sourceMessageIds: fact.sourceMessageIds,
    });
    if (!('rejected' in mapped)) {
      this.db.prepare(`UPDATE memory_facts SET status='superseded',updated_at=? WHERE id=? AND profile_id=?`)
        .run(Date.now(), id, this.profileId);
    }
    return mapped;
  }

  getMemorySlotCatalog(input: { group?: string; filledOnly?: boolean; status?: FactStatus } = {}): MemorySlotView[] {
    return this.slotStore.catalog(input);
  }

  getMemorySlotValues(input: { status?: FactStatus; slotKey?: string; query?: string } = {}): MemorySlotValue[] {
    return this.slotStore.values(input);
  }

  putMemorySlotValue(input: PutMemorySlotValueInput): MemorySlotValue | { rejected: string } {
    const result = this.slotStore.put(input);
    if ('rejected' in result) this.noteRejected(`slot_${result.rejected}`);
    return result;
  }

  putManualMemorySlotValue(input: Omit<PutMemorySlotValueInput, 'sourceKind' | 'sourceMessageIds'>): MemorySlotValue | { rejected: string } {
    const now = Date.now();
    const sourceId = `manual-slot-${now}-${++this.seq}`;
    this.recordMessage({
      id: sourceId,
      sessionId: 'memory-control-plane',
      role: 'owner',
      content: `记忆控制面手工填写槽位 ${input.slotKey}：${formatSlotValue(input.value)}`,
      timestamp: now,
    });
    return this.putMemorySlotValue({ ...input, sourceKind: 'manual_edit', sourceMessageIds: [sourceId] });
  }

  replaceMemorySlotValue(id: string, value: unknown, sourceMessageIds: string[] = [], sourceKind: MemorySlotSourceKind = 'manual_edit'): MemorySlotValue | { rejected: string } | null {
    const sources = [...new Set(sourceMessageIds.filter(Boolean))];
    if (sources.length === 0) {
      const old = this.slotStore.get(id);
      if (!old) return null;
      const now = Date.now();
      const sourceId = `manual-slot-edit-${now}-${++this.seq}`;
      this.recordMessage({
        id: sourceId,
        sessionId: 'memory-control-plane',
        role: 'owner',
        content: `记忆控制面修改槽位 ${old.slotKey}：${formatSlotValue(value)}`,
        timestamp: now,
      });
      sources.push(sourceId);
    }
    return this.slotStore.replace(id, value, sources, sourceKind);
  }

  removeMemorySlotValue(id: string): boolean {
    return this.slotStore.remove(id);
  }

  restoreMemorySlotValue(id: string): MemorySlotValue | null {
    return this.slotStore.restore(id);
  }

  getMemorySlotValueSources(id: string): ChatMessage[] | null {
    const value = this.slotStore.get(id);
    return value ? this.getMessagesByIds(value.sourceMessageIds) : null;
  }

  countActiveMemorySlots(): number {
    return this.slotStore.countActiveSlots();
  }

  searchActiveMemorySlots(query: string, limit = tuning().memoryConsolidation.recallSlotLimit): MemorySlotValue[] {
    const keys = new Set(searchMemorySlotDefinitions(query, limit).map(definition => definition.slotKey));
    if (this.getMemorySlotValues({ status: 'active', slotKey: 'identity.preferred_name' }).length > 0) {
      keys.add('identity.preferred_name');
    }
    return this.getMemorySlotValues({ status: 'active' })
      .filter(value => keys.has(value.slotKey))
      .slice(0, Math.max(1, Math.floor(limit)));
  }

  previewLegacyFactSlotMigration(): LegacyFactSlotMigrationPreview[] {
    return this.getFacts({ status: 'active' }).filter(fact => fact.scope === 'user').map(fact => {
      const speechAct = classifyOwnerMemorySpeech(fact.text);
      if (!['statement', 'explicit_statement'].includes(speechAct)) {
        return { factId: fact.id, text: fact.text, outcome: 'rejected', reason: speechAct };
      }
      const route = routeDeterministicMemorySlot(fact.text);
      if (!route || route.operation !== 'add') {
        return { factId: fact.id, text: fact.text, outcome: 'dynamic_candidate' };
      }
      return { factId: fact.id, text: fact.text, outcome: 'official_slot', slotKey: route.slotKey, value: route.value };
    });
  }

  applyLegacyFactSlotMigration(): { migrated: number; dynamicCandidates: number; rejected: number } {
    const result = { migrated: 0, dynamicCandidates: 0, rejected: 0 };
    for (const preview of this.previewLegacyFactSlotMigration()) {
      if (preview.outcome === 'rejected') { result.rejected += 1; continue; }
      if (preview.outcome === 'dynamic_candidate') { result.dynamicCandidates += 1; continue; }
      const fact = this.getFact(preview.factId);
      if (!fact || !preview.slotKey) continue;
      const migrated = this.putMemorySlotValue({
        slotKey: preview.slotKey,
        value: preview.value,
        confidence: fact.confidence,
        importance: fact.importance,
        sourceKind: 'migration',
        sourceMessageIds: fact.sourceMessageIds,
      });
      if (!('rejected' in migrated)) result.migrated += 1;
    }
    return result;
  }

  /** 返回尚未经过周期整理的主人消息；正文预算是软上限，绝不截断并误结算原文。 */
  pendingOwnerMessages(limit: number, maxChars: number): ChatMessage[] {
    const safeLimit = Math.max(1, Math.floor(limit));
    const safeChars = Math.max(1, Math.floor(maxChars));
    const rows = this.db.prepare(`
      SELECT m.id,m.session_id,m.role,m.content,m.ts
      FROM chat_messages m
      LEFT JOIN chat_memory_consolidation_messages c
        ON c.profile_id=m.profile_id AND c.message_id=m.id
      WHERE m.profile_id=? AND m.role='owner' AND c.message_id IS NULL
      ORDER BY m.ts ASC,m.id ASC
      LIMIT ?
    `).all(this.profileId, safeLimit) as Array<{ id: string; session_id: string; role: ChatRole; content: string; ts: number }>;
    const messages: ChatMessage[] = [];
    let usedChars = 0;
    for (const row of rows) {
      if (!row.content) continue;
      if (messages.length > 0 && usedChars + row.content.length > safeChars) break;
      messages.push({ id: row.id, sessionId: row.session_id, role: row.role, content: row.content, timestamp: row.ts });
      usedChars += row.content.length;
    }
    return messages;
  }

  pendingOwnerMessageCount(): number {
    return (this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM chat_messages m
      LEFT JOIN chat_memory_consolidation_messages c
        ON c.profile_id=m.profile_id AND c.message_id=m.id
      WHERE m.profile_id=? AND m.role='owner' AND c.message_id IS NULL
    `).get(this.profileId) as { count: number }).count;
  }

  /**
   * 事实操作与消息处理账本同事务提交。任何来源、目标或安全校验失败都会让整批回滚，
   * 因而下一个周期能够安全重试同一批原始消息。
   */
  commitConsolidation(
    batch: ChatMessage[],
    operations: MemoryConsolidationOperation[],
    runId: string,
  ): MemoryConsolidationCommitResult {
    const cleanRunId = runId.trim();
    if (!cleanRunId) throw new Error('memory consolidation runId is required');
    const batchIds = [...new Set(batch.map(message => message.id).filter(Boolean))];
    if (batchIds.length === 0) return emptyConsolidationResult();

    const commit = this.db.transaction((): MemoryConsolidationCommitResult => {
      const placeholders = batchIds.map(() => '?').join(',');
      const sourceRows = this.db.prepare(`
        SELECT id,role,content FROM chat_messages
        WHERE profile_id=? AND id IN (${placeholders})
      `).all(this.profileId, ...batchIds) as Array<{ id: string; role: ChatRole; content: string }>;
      const authorized = new Set(sourceRows.filter(row => row.role === 'owner').map(row => row.id));
      const sourceContent = new Map(sourceRows.map(row => [row.id, row.content]));
      if (authorized.size !== batchIds.length) throw new Error('memory consolidation source is not current-profile owner evidence');

      const processedRows = this.db.prepare(`
        SELECT message_id FROM chat_memory_consolidation_messages
        WHERE profile_id=? AND message_id IN (${placeholders})
      `).all(this.profileId, ...batchIds) as Array<{ message_id: string }>;
      if (processedRows.length === batchIds.length) return emptyConsolidationResult();
      if (processedRows.length > 0) throw new Error('memory consolidation batch mixes processed and pending messages');

      const result = emptyConsolidationResult();
      for (const operation of operations) {
        const sources = [...new Set(operation.sourceMessageIds.filter(Boolean))];
        if (operation.action !== 'ignore' && sources.length === 0) throw new Error('memory consolidation fact requires owner evidence');
        if (sources.some(id => !authorized.has(id))) throw new Error('memory consolidation operation referenced evidence outside its batch');

        if (operation.action === 'ignore') {
          result.ignored += 1;
          continue;
        }

        if (operation.slotKey) {
          const evidence = sources.map(id => sourceContent.get(id) ?? '');
          if (evidence.every(text => !['statement', 'explicit_statement'].includes(classifyOwnerMemorySpeech(text)))) {
            result.ignored += 1;
            continue;
          }
          if (operation.value === undefined) throw new Error('memory consolidation slot operation requires value');
          const slotResult = this.putMemorySlotValue({
            slotKey: operation.slotKey,
            value: operation.value,
            status: operation.action === 'candidate' ? 'candidate' : 'active',
            confidence: operation.confidence,
            importance: operation.importance,
            sourceKind: evidence.some(isExplicitMemoryStatement) ? 'explicit_tool' : 'conversation',
            sourceMessageIds: sources,
          });
          if ('rejected' in slotResult) {
            if (['explicit_capture_required', 'invalid_slot_value'].includes(slotResult.rejected)) {
              result.ignored += 1;
              continue;
            }
            throw new Error(`memory consolidation slot rejected: ${slotResult.rejected}`);
          }
          if (operation.action === 'candidate') result.candidates += 1;
          else if (operation.action === 'reinforce') result.reinforced += 1;
          else if (operation.action === 'replace') result.replaced += 1;
          else result.added += 1;
          continue;
        }

        if (operation.action === 'reinforce') {
          const target = operation.targetFactId ? this.getFact(operation.targetFactId) : null;
          if (!target || target.status !== 'active') throw new Error('memory consolidation reinforce target is not active');
          const reinforced = this.addFact({
            scope: target.scope,
            kind: target.kind,
            text: target.text,
            confidence: operation.confidence ?? target.confidence,
            importance: operation.importance ?? target.importance,
            sourceMessageIds: sources,
          });
          if ('rejected' in reinforced) throw new Error(`memory consolidation rejected: ${reinforced.rejected}`);
          result.reinforced += 1;
          continue;
        }

        if (operation.action === 'replace') {
          if (!operation.targetFactId || !operation.text?.trim()) throw new Error('memory consolidation replace requires target and text');
          const replaced = this.replaceFact(operation.targetFactId, operation.text, sources);
          if (!replaced) throw new Error('memory consolidation replace target is not active');
          if ('rejected' in replaced) throw new Error(`memory consolidation rejected: ${replaced.rejected}`);
          result.replaced += 1;
          continue;
        }

        if (!operation.kind || !operation.text?.trim()) throw new Error('memory consolidation add requires kind and text');
        const explicitDynamic = sources.some(id => isExplicitMemoryStatement(sourceContent.get(id) ?? ''));
        const dynamicCandidate = operation.action === 'candidate' || !explicitDynamic;
        const added = this.addFact({
          scope: operation.kind === 'agent_note' ? 'agent' : 'user',
          kind: operation.kind,
          text: operation.text,
          status: dynamicCandidate ? 'candidate' : 'active',
          confidence: operation.confidence ?? (dynamicCandidate ? 0.5 : 0.85),
          importance: operation.importance ?? 0.65,
          sourceMessageIds: sources,
        });
        if ('rejected' in added) throw new Error(`memory consolidation rejected: ${added.rejected}`);
        if (dynamicCandidate) result.candidates += 1;
        else result.added += 1;
      }

      const processedAt = Date.now();
      const insertLedger = this.db.prepare(`
        INSERT INTO chat_memory_consolidation_messages(profile_id,message_id,status,processed_at,run_id)
        VALUES(?,?,'processed',?,?)
      `);
      for (const id of batchIds) insertLedger.run(this.profileId, id, processedAt, cleanRunId);
      result.processed = batchIds.length;
      return result;
    });
    return commit();
  }

  /** 从权威原始消息重建当前 Profile 的 FTS5 派生索引。 */
  rebuildSearchIndex(): { indexed: number } {
    const rebuild = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM chat_messages_fts WHERE profile_id=?`).run(this.profileId);
      this.db.prepare(`DELETE FROM chat_message_relations WHERE profile_id=?`).run(this.profileId);
      this.db.prepare(`DELETE FROM chat_message_embeddings WHERE profile_id=?`).run(this.profileId);
      const rows = this.db.prepare(`SELECT id,session_id,role,content,ts FROM chat_messages WHERE profile_id=? ORDER BY ts ASC`).all(this.profileId) as Array<{ id: string; session_id: string; role: ChatRole; content: string; ts: number }>;
      const insert = this.db.prepare(`INSERT INTO chat_messages_fts(profile_id,message_id,content) VALUES(?,?,?)`);
      const insertRelation = this.db.prepare(`INSERT INTO chat_message_relations(profile_id,message_id,subject,relation,object,ts) VALUES(?,?,?,?,?,?)`);
      for (const row of rows) {
        insert.run(this.profileId, row.id, row.content);
        const triple = parseFactTriple(row.content);
        if (triple) insertRelation.run(this.profileId, row.id, normalizeRelationEntity(triple.subject), triple.relation, triple.object, row.ts);
        this.indexEmbedding({ id: row.id, sessionId: row.session_id, role: row.role, content: row.content, timestamp: row.ts });
      }
      return rows.length;
    });
    return { indexed: rebuild() };
  }

  /** 恢复 deleted/superseded 事实；若其后继仍 Active，则后继退出，避免冲突共同注入。 */
  restoreFact(id: string): MemoryFact | null {
    const fact = this.getFact(id);
    if (!fact || (fact.status !== 'deleted' && fact.status !== 'superseded')) return null;
    const restore = this.db.transaction(() => {
      const now = Date.now();
      this.db.prepare(`UPDATE memory_facts SET status='superseded',updated_at=? WHERE profile_id=? AND supersedes_id=? AND status='active'`)
        .run(now, this.profileId, fact.id);
      this.db.prepare(`UPDATE memory_facts SET status='active',updated_at=? WHERE id=? AND profile_id=?`)
        .run(now, fact.id, this.profileId);
      return { ...fact, status: 'active' as const, updatedAt: now };
    });
    return restore();
  }

  exportMarkdown(): string {
    const facts = this.getFacts();
    const lines = [`# Chat Memory Export`, '', `Profile: ${this.profileId}`, `Exported: ${new Date().toISOString()}`, ''];
    for (const status of ['active', 'candidate', 'superseded', 'deleted', 'rejected', 'expired'] as const) {
      const group = facts.filter(fact => fact.status === status);
      if (group.length === 0) continue;
      lines.push(`## ${status}`, '');
      for (const fact of group) {
        lines.push(`- ${fact.text}`, `  - id: ${fact.id}`, `  - kind: ${fact.kind}`, `  - confidence: ${fact.confidence}`, `  - sources: ${fact.sourceMessageIds.join(', ') || '(manual)'}`);
      }
      lines.push('');
    }
    return `${lines.join('\n')}\n`;
  }

  searchMessages(query: string, limit = 5): Array<ChatMessage & { before?: string; after?: string }> {
    const startedAt = Date.now();
    const normalized = query.trim().replace(/["'`*:^(){}\[\]]/g, ' ').trim();
    if (!normalized) return [];
    let ids: string[] = [];
    try {
      const ftsQuery = buildFtsQuery(normalized);
      ids = (this.db.prepare(`SELECT message_id FROM chat_messages_fts WHERE profile_id=? AND chat_messages_fts MATCH ? ORDER BY bm25(chat_messages_fts) LIMIT ?`)
        .all(this.profileId, ftsQuery, limit) as Array<{ message_id: string }>).map(r => r.message_id);
    } catch { /* FTS query can reject malformed CJK tokens; use exact LIKE below. */ }
    type MessageRow = { id: string; session_id: string; role: ChatRole; content: string; ts: number };
    const unorderedRows = ids.length
      ? this.db.prepare(`SELECT * FROM chat_messages WHERE profile_id=? AND id IN (${ids.map(() => '?').join(',')})`).all(this.profileId, ...ids) as MessageRow[]
      : this.db.prepare(`SELECT * FROM chat_messages WHERE profile_id=? AND content LIKE ? ORDER BY ts DESC LIMIT ?`).all(this.profileId, `%${normalized}%`, limit) as MessageRow[];
    // FTS5 已按 BM25 返回 ID。第二次查权威消息正文时必须恢复该顺序，不能用时间排序覆盖相关性。
    const rowById = new Map(unorderedRows.map(row => [row.id, row]));
    const rows = ids.length ? ids.map(id => rowById.get(id)).filter((row): row is MessageRow => Boolean(row)) : unorderedRows;
    const result = rows.map(row => {
      const neighbors = this.db.prepare(`SELECT content FROM chat_messages WHERE profile_id=? AND session_id=? AND ts BETWEEN ? AND ? ORDER BY ts`)
        .all(this.profileId, row.session_id, row.ts - 1, row.ts + 1) as Array<{ content: string }>;
      return { id: row.id, sessionId: row.session_id, role: row.role, content: row.content, timestamp: row.ts, before: neighbors[0]?.content, after: neighbors.at(-1)?.content };
    });
    this.metrics.retrievals += 1;
    this.metrics.retrievalLatencyMs += Date.now() - startedAt;
    return result;
  }

  private searchRelationMessagesBySubject(subject: string, limit: number): Array<ChatMessage & { before?: string; after?: string }> {
    const normalized = normalizeRelationEntity(subject);
    if (!normalized) return [];
    const rows = this.db.prepare(`
      WITH ranked AS (
        SELECT message_id, relation, ts,
               ROW_NUMBER() OVER (PARTITION BY relation ORDER BY ts DESC, message_id DESC) AS rn
        FROM chat_message_relations
        WHERE profile_id=? AND subject=?
      )
      SELECT m.id,m.session_id,m.role,m.content,m.ts
      FROM ranked r
      JOIN chat_messages m ON m.profile_id=? AND m.id=r.message_id
      WHERE r.rn=1
      ORDER BY r.ts DESC LIMIT ?
    `).all(this.profileId, normalized, this.profileId, limit) as Array<{ id: string; session_id: string; role: ChatRole; content: string; ts: number }>;
    return rows.map(row => ({ id: row.id, sessionId: row.session_id, role: row.role, content: row.content, timestamp: row.ts }));
  }

  private latestRelationMessage(subject: string, relation: string): ChatMessage | null {
    const row = this.db.prepare(`
      SELECT m.id,m.session_id,m.role,m.content,m.ts
      FROM chat_message_relations r
      JOIN chat_messages m ON m.profile_id=r.profile_id AND m.id=r.message_id
      WHERE r.profile_id=? AND r.subject=? AND r.relation=?
      ORDER BY r.ts DESC, r.message_id DESC LIMIT 1
    `).get(this.profileId, normalizeRelationEntity(subject), relation) as
      { id: string; session_id: string; role: ChatRole; content: string; ts: number } | undefined;
    return row ? { id: row.id, sessionId: row.session_id, role: row.role, content: row.content, timestamp: row.ts } : null;
  }

  private searchEmbeddingMessages(query: string, limit: number): ChatMessage[] | null {
    if (!this.embeddingProvider || !query.trim() || limit <= 0) return [];
    this.metrics.embeddingRequests += 1;
    let queryVector: readonly number[];
    try {
      queryVector = this.embeddingProvider.embed(query);
      if (queryVector.length === 0 || queryVector.some(value => !Number.isFinite(value))) throw new Error('invalid embedding vector');
    } catch {
      this.metrics.embeddingFailures += 1;
      this.metrics.embeddingFallbacks += 1;
      return null;
    }
    const rows = this.db.prepare(`
      SELECT m.id,m.session_id,m.role,m.content,m.ts,e.vector_json
      FROM chat_message_embeddings e
      JOIN chat_messages m ON m.profile_id=e.profile_id AND m.id=e.message_id
      WHERE e.profile_id=? AND e.provider_id=?
    `).all(this.profileId, this.embeddingProvider.id) as Array<{ id: string; session_id: string; role: ChatRole; content: string; ts: number; vector_json: string }>;
    return rows
      .map(row => ({ row, score: cosineSimilarity(queryVector, JSON.parse(row.vector_json) as number[]) }))
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score || b.row.ts - a.row.ts)
      .slice(0, limit)
      .map(({ row }) => ({ id: row.id, sessionId: row.session_id, role: row.role, content: row.content, timestamp: row.ts }));
  }

  private searchHybridMessages(query: string, limit: number): Array<ChatMessage & { before?: string; after?: string }> {
    const lexical = this.searchMessages(query, Math.max(limit, limit * 2));
    if (!this.embeddingProvider) return lexical.slice(0, limit);
    const semantic = this.searchEmbeddingMessages(query, Math.max(limit, limit * 2));
    if (semantic === null) return lexical.slice(0, limit);
    const scores = new Map<string, { message: ChatMessage & { before?: string; after?: string }; score: number }>();
    const merge = (messages: Array<ChatMessage & { before?: string; after?: string }>, weight: number) => messages.forEach((message, index) => {
      const current = scores.get(message.id);
      const score = weight / (60 + index + 1);
      scores.set(message.id, { message, score: (current?.score ?? 0) + score });
    });
    merge(lexical, 1);
    merge(semantic, 1);
    const ranked = [...scores.values()].sort((a, b) => b.score - a.score).map(item => item.message);
    return mmrSelectMessages(ranked, query, limit);
  }

  /**
   * Hybrid 多跳召回：先命中问题中的显式实体，再从命中事实抽取新实体继续扩展。
   * 适用于“作品→作者→配偶→国籍”等关系链；全程仍走当前 Profile 的 FTS5。
   */
  searchMessagesMultiHop(query: string, limit = 8, expansionHops = 2): Array<ChatMessage & { before?: string; after?: string }> {
    if (!query.trim() || limit <= 0) return [];
    const relationQuery = looksLikeRelationChainQuery(query);
    const found = new Map<string, { message: ChatMessage & { before?: string; after?: string }; score: number }>();
    const latestRelation = new Map<string, string>();
    const seenQueries = new Set<string>();
    // 关系链问题优先只用显式专名启动搜索；没有专名时才回退整句查询。
    // 若同时把整句加入首跳，超长知识池中的 country/sport/capital 等通用词
    // 会把候选推到探索上限，使正确实体的后续 object 链在到达前被截断。
    const queryAnchors = relationQuery ? extractRetrievalAnchors(query, false) : [];
    const anchoredRelationWalk = queryAnchors.length > 0;
    let frontier = queryAnchors.length > 0 ? queryAnchors : [query];

    const explorationLimit = Math.max(limit, limit * 4);
    for (let hop = 0; hop <= expansionHops && frontier.length > 0 && found.size < explorationLimit; hop += 1) {
      const next: string[] = [];
      for (const current of frontier.slice(0, 32)) {
        const key = current.trim().toLocaleLowerCase();
        if (!key || seenQueries.has(key)) continue;
        seenQueries.add(key);
        const perQueryLimit = hop === 0
          ? relationQuery ? Math.min(8, limit) : Math.min(32, Math.max(8, limit))
          : 3;
        let candidates: Array<ChatMessage & { before?: string; after?: string }>;
        if (hop === 0) {
          const exactRelations = anchoredRelationWalk
            ? this.searchRelationMessagesBySubject(current, Math.max(8, perQueryLimit))
            : [];
          candidates = exactRelations.length > 0
            ? exactRelations
            : this.searchHybridMessages(current, perQueryLimit);
        } else {
          const exactRelations = this.searchRelationMessagesBySubject(current, Math.max(8, perQueryLimit));
          candidates = anchoredRelationWalk && exactRelations.length > 0
            ? exactRelations
            : [...exactRelations, ...this.searchHybridMessages(current, perQueryLimit)]
              .sort((a, b) => relationCandidatePriority(b, current) - relationCandidatePriority(a, current));
        }
        for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
          const candidate = candidates[candidateIndex]!;
          const candidateTriple = parseFactTriple(candidate.content);
          const message = candidateTriple
            ? this.latestRelationMessage(candidateTriple.subject, candidateTriple.relation) ?? candidate
            : candidate;
          const triple = parseFactTriple(message.content);
          if (triple) {
            const previousId = latestRelation.get(triple.key);
            const previous = previousId ? found.get(previousId)?.message : undefined;
            if (previousId && previousId !== message.id) {
              if (previous && previous.timestamp >= message.timestamp) continue;
              found.delete(previousId);
            }
            latestRelation.set(triple.key, message.id);
          }
          const relevance = overlapScore(normalizedTokens(query), normalizedTokens(message.content));
          const score = (hop === 0 ? 2 : 1)
            + relevance * 5
            + (hop === 0 ? 6 : 2) / (candidateIndex + 1)
            + relationCandidatePriority(message, current) * 1.5;
          const existing = found.get(message.id);
          if (!existing || score > existing.score) found.set(message.id, { message, score });
          // 结构化关系只沿 object 继续，避免同一句的通用专名挤占下一跳队列；
          // 非结构化聊天文本才使用启发式 Anchor 扩展。
          const anchors = triple ? [triple.object] : extractRetrievalAnchors(message.content);
          for (const anchor of anchors) {
            const anchorKey = anchor.toLocaleLowerCase();
            if (!seenQueries.has(anchorKey)) next.push(anchor);
          }
        }
        if (found.size >= explorationLimit) break;
      }
      frontier = [...new Set(next)];
    }
    return [...found.values()]
      .sort((a, b) => b.score - a.score || b.message.timestamp - a.message.timestamp)
      .slice(0, relationQuery ? Math.min(limit, 16) : limit)
      .map(item => item.message);
  }

  /** 返回当前 Profile 最近写入的原始消息；仅用于无检索的 Recent-only 基线和降级路径。 */
  recentMessages(limit = 20): ChatMessage[] {
    const rows = this.db.prepare(`SELECT id,session_id,role,content,ts FROM chat_messages WHERE profile_id=? ORDER BY ts DESC LIMIT ?`)
      .all(this.profileId, limit) as Array<{ id: string; session_id: string; role: ChatRole; content: string; ts: number }>;
    return rows.reverse().map(row => ({ id: row.id, sessionId: row.session_id, role: row.role, content: row.content, timestamp: row.ts }));
  }

  /** 压缩前 Flush：保存原始消息后才写摘要，任何异常都不会删除消息。 */
  /**
   * 混合召回的本地基线：FTS/子串命中保留精确实体，归一化 token 重叠补足同义表达。
   * 该接口不依赖远程 Embedding；接入向量提供方时可在此合并其得分而不改变调用方。
   */
  searchFacts(query: string, limit = 5): MemoryFact[] {
    const tokens = normalizedTokens(query);
    if (tokens.length === 0) return [];
    const scored = this.getFacts({ status: 'active' })
      .map(fact => {
        const overlap = overlapScore(tokens, normalizedTokens(fact.text));
        return { fact, overlap, score: overlap + fact.importance * 0.1 + fact.confidence * 0.05 };
      })
      .filter(item => item.overlap > 0)
      .sort((a, b) => b.score - a.score || b.fact.updatedAt - a.fact.updatedAt);
    const candidates = scored.length > 0 || !isGenericPreferenceQuery(query)
      ? scored
      : this.getFacts({ status: 'active' })
        .filter(fact => fact.kind === 'preference' || fact.kind === 'boundary' || fact.kind === 'identity')
        .map(fact => ({ fact, score: fact.importance + fact.confidence, overlap: 0 }))
        .sort((a, b) => b.score - a.score || b.fact.updatedAt - a.fact.updatedAt);
    return candidates
      .slice(0, limit)
      .map(item => item.fact);
  }

  flushSession(sessionId: string): ConversationSummary | null {
    const rows = this.db.prepare(`SELECT id,content FROM chat_messages WHERE profile_id=? AND session_id=? ORDER BY ts`).all(this.profileId, sessionId) as Array<{ id: string; content: string }>;
    if (rows.length === 0) return null;
    const text = rows.map(r => r.content).join(' ');
    const openLoops = rows.map(r => r.content).filter(t => /(?:待办|之后|稍后|下次|还没|问题)/.test(t)).slice(-5);
    const commitments = rows.map(r => r.content).filter(t => /(?:答应|会|承诺|记得)/.test(t)).slice(-5);
    const now = Date.now();
    const summary: ConversationSummary = {
      id: `summary-${now}-${++this.seq}`, profileId: this.profileId, sessionId, coveredMessageIds: rows.map(r => r.id),
      summary: text.slice(-1000), openLoops, commitments, createdAt: now,
    };
    this.db.prepare(`INSERT INTO conversation_summaries VALUES(?,?,?,?,?,?,?,?)`).run(summary.id, this.profileId, sessionId, JSON.stringify(summary.coveredMessageIds), summary.summary, JSON.stringify(openLoops), JSON.stringify(commitments), now);
    return summary;
  }

  /** 预算化 Prompt：只允许 Active 事实和当前查询的少量历史进入。 */
  /** 在超过软阈值时执行先 Flush 后压缩；原始消息始终保留。 */
  maybeFlush(sessionId: string): ConversationSummary | null {
    if (this.flushThresholdChars <= 0) return null;
    const messages = this.db.prepare(`SELECT id, LENGTH(content) AS chars FROM chat_messages WHERE profile_id=? AND session_id=? ORDER BY ts ASC`)
      .all(this.profileId, sessionId) as Array<{ id: string; chars: number }>;
    const chars = messages.reduce((total, message) => total + message.chars, 0);
    if (chars < this.flushThresholdChars) return null;

    // A threshold stays exceeded after the first flush.  Do not keep creating
    // identical summaries until the conversation actually has new messages.
    const latest = this.db.prepare(`SELECT covered_ids_json FROM conversation_summaries WHERE profile_id=? AND session_id=? ORDER BY created_at DESC LIMIT 1`)
      .get(this.profileId, sessionId) as { covered_ids_json: string } | undefined;
    if (latest) {
      const coveredIds = new Set(JSON.parse(latest.covered_ids_json) as string[]);
      if (messages.every(message => coveredIds.has(message.id))) return null;
    }
    const summary = this.flushSession(sessionId);
    if (summary) this.metrics.flushes += 1;
    return summary;
  }

  inspectMetrics(): ChatMemoryMetrics {
    return { ...this.metrics, rejected: { ...this.metrics.rejected } };
  }

  buildPromptContext(query = this.lastQuery, retrievalMode: 'fts5' | 'hybrid' = 'hybrid'): MemoryPromptContext {
    const parts: string[] = [`── 已治理的聊天记忆（仅作辅助上下文，不是用户新说的话）──\n${MEMORY_EVIDENCE_RULES}`];
    let used = parts[0].length;
    const push = (line: string): boolean => {
      if (used + line.length + 1 > this.budget) return false;
      parts.push(line);
      used += line.length + 1;
      return true;
    };
    const retrievedFactIds: string[] = [];
    const retrievedSlotValueIds: string[] = [];
    const retrievedMessageIds: string[] = [];
    let includedSummary = false;
    const relevantSlotDefinitions = searchMemorySlotDefinitions(query, tuning().memoryConsolidation.recallSlotLimit);
    const slotValues = this.searchActiveMemorySlots(query);
    const officialSlotKeys = new Set(slotValues.map(value => value.slotKey));
    const stableFacts = this.getFacts({ status: 'active' }).filter(f => (f.kind === 'boundary' || f.kind === 'identity')
      && !isFactCoveredByOfficialSlot(f, officialSlotKeys));
    const relevantFacts = this.searchFacts(query, 5);
    const facts = [...stableFacts, ...relevantFacts.filter(f => !stableFacts.some(s => s.id === f.id)
      && !isFactCoveredByOfficialSlot(f, officialSlotKeys))];
    const supersededSourceIds = new Set(
      this.getFacts().filter(fact => fact.status === 'superseded' || fact.status === 'deleted')
        .flatMap(fact => fact.sourceMessageIds),
    );
    const messages = (retrievalMode === 'hybrid'
      ? this.searchMessagesMultiHop(query, 32, 3)
      : this.searchMessages(query, 8))
      .filter(message => !supersededSourceIds.has(message.id));
    const evidenceGaps = evidenceQualifierGaps(query, [
      ...facts.filter(fact => fact.scope === 'user').map(fact => fact.text),
      ...officialSlotEvidence(slotValues),
      ...messages.filter(message => message.role === 'owner').map(message => message.content),
    ]);
    if (evidenceGaps.length > 0) {
      push(`证据缺口（以下问题限定词未在 user/owner 证据中出现）：${evidenceGaps.join('、')}。不得用近似经历或 bot/agent 内容补齐。`);
    }
    for (const value of slotValues) {
      const definition = getMemorySlotDefinition(value.slotKey);
      if (!definition) continue;
      if (definition.sensitivity === 'restricted' && !relevantSlotDefinitions.some(item => item.slotKey === value.slotKey)) continue;
      if (push(`官方记忆槽（${definition.title}）：${formatSlotValue(value.value)}`)) retrievedSlotValueIds.push(value.id);
    }
    for (const fact of facts) {
      if (push(`已确认事实（${fact.scope}）：${fact.text} [来源层：模型扩展]`)) retrievedFactIds.push(fact.id);
    }
    const summaries = this.db.prepare(`SELECT summary,open_loops_json,commitments_json FROM conversation_summaries WHERE profile_id=? ORDER BY created_at DESC LIMIT 1`).all(this.profileId) as Array<{ summary: string; open_loops_json: string; commitments_json: string }>;
    for (const summary of summaries) {
      if (query.trim() && !hasRelevantTokens(query, summary.summary)) continue;
      if (push(`会话摘要（混合角色派生，仅用于定位，不可单独证明用户事实）：${summary.summary}`)) includedSummary = true;
      for (const item of JSON.parse(summary.open_loops_json) as string[]) push(`摘要未决（混合角色派生）：${item}`);
      for (const item of JSON.parse(summary.commitments_json) as string[]) push(`摘要承诺（混合角色派生）：${item}`);
    }
    for (const message of messages) {
      if (push(`相关历史（${message.role}）：${message.content}`)) retrievedMessageIds.push(message.id);
    }
    return {
      text: parts.length === 1 ? '' : parts.join('\n'),
      retrievalMode,
      retrievedFactIds,
      retrievedSlotValueIds,
      retrievedMessageIds,
      includedSummary,
    };
  }

  toPromptContext(query = this.lastQuery, retrievalMode: 'fts5' | 'hybrid' = 'hybrid'): string {
    return this.buildPromptContext(query, retrievalMode).text;
  }

  close(): void { this.db.close(); }

  private persistFact(fact: MemoryFact): void {
    this.db.prepare(`INSERT INTO memory_facts VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      fact.id, fact.profileId, fact.scope, fact.kind, fact.text, fact.status, fact.confidence, fact.importance,
      JSON.stringify(fact.sourceMessageIds), fact.supersedesId ?? null, fact.createdAt, fact.updatedAt,
    );
  }

  private applyExplicitIntent(message: ChatMessage): void {
    const text = message.content.trim();
    const remember = text.match(/^(?:请)?记住[，,:：]?\s*(.+)$/);
    if (remember) {
      const route = routeDeterministicMemorySlot(text);
      if (route) {
        if (route.operation === 'remove') {
          const target = this.getMemorySlotValues({ status: 'active', slotKey: route.slotKey })
            .find(value => String(value.value).trim().toLowerCase() === route.value.trim().toLowerCase());
          if (target) this.removeMemorySlotValue(target.id);
        } else {
          const slotResult = this.putMemorySlotValue({
            slotKey: route.slotKey,
            value: route.value,
            confidence: 1,
            importance: 0.9,
            sourceKind: 'explicit_tool',
            sourceMessageIds: [message.id],
          });
          if ('rejected' in slotResult) this.noteRejected(`slot_${slotResult.rejected}`);
        }
        return;
      }
      const result = this.addFact({ scope: 'user', kind: inferKind(remember[1]!), text: remember[1]!, confidence: 1, importance: 0.9, sourceMessageIds: [message.id] });
      if ('rejected' in result) this.noteRejected(result.rejected);
      return;
    }
    const forget = text.match(/^(?:请)?忘掉[，,:：]?\s*(.+)$/);
    if (forget) {
      const target = this.selectActiveFact(cleanIntentTarget(forget[1]!));
      if (target) this.removeFact(target.id);
      return;
    }
    const replace = text.match(/^(?:改成|改一下)[，,:：]?\s*(.+)$/);
    if (replace) {
      const nextText = cleanIntentTarget(replace[1]!);
      const target = this.selectActiveFact(nextText);
      if (target) {
        const result = this.replaceFact(target.id, nextText, [message.id]);
        if (result && 'rejected' in result) this.noteRejected(result.rejected);
      }
    }
  }

  private selectActiveFact(text: string): MemoryFact | null {
    const active = this.getFacts({ status: 'active' });
    if (active.length === 0) return null;
    const tokens = normalizedTokens(text);
    const scored = active
      .map(fact => ({ fact, score: overlapScore(tokens, normalizedTokens(fact.text)) }))
      .sort((a, b) => b.score - a.score || b.fact.updatedAt - a.fact.updatedAt);
    if (scored[0] && scored[0].score > 0) return scored[0].fact;
    const kind = inferKind(text);
    const sameKind = active.filter(fact => fact.kind === kind);
    if (sameKind.length === 1) return sameKind[0]!;
    return active.length === 1 ? active[0]! : null;
  }

  private noteRejected(reason: string): void {
    this.metrics.rejected[reason] = (this.metrics.rejected[reason] ?? 0) + 1;
  }

  private captureCandidate(message: ChatMessage): void {
    const text = message.content.trim();
    if (!['statement', 'explicit_statement'].includes(classifyOwnerMemorySpeech(text))) return;
    const route = routeDeterministicMemorySlot(text);
    if (route) {
      if (route.operation === 'remove') {
        const target = this.getMemorySlotValues({ status: 'active', slotKey: route.slotKey })
          .find(value => String(value.value).trim().toLowerCase() === route.value.trim().toLowerCase());
        if (target) this.removeMemorySlotValue(target.id);
      } else {
        const result = this.putMemorySlotValue({
          slotKey: route.slotKey,
          value: route.value,
          confidence: 0.75,
          importance: 0.65,
          sourceKind: isExplicitMemoryStatement(text) ? 'explicit_tool' : 'conversation',
          sourceMessageIds: [message.id],
        });
        if ('rejected' in result) this.noteRejected(`slot_${result.rejected}`);
        else this.metrics.captured += 1;
      }
      return;
    }
    const signature = preferenceSignature(text);
    if (signature) {
      const conflict = this.getFacts({ status: 'active' }).find(fact =>
        fact.kind === 'preference' && preferenceSignature(fact.text)?.topic === signature.topic
          && preferenceSignature(fact.text)?.polarity !== signature.polarity,
      );
      const result = conflict
        ? this.replaceFact(conflict.id, text, [message.id])
        : this.addFact({ scope: 'user', kind: 'preference', text, confidence: 0.75, importance: 0.65, sourceMessageIds: [message.id] });
      if (result && 'rejected' in result) this.noteRejected(result.rejected);
      else if (result) this.metrics.captured += 1;
      return;
    }
    if (!/^(?:我喜欢|我不喜欢|请不要|我叫|我的名字是|我希望)/.test(text)) return;
    const result = this.addFact({ scope: 'user', kind: inferKind(text), text, confidence: 0.75, importance: 0.65, sourceMessageIds: [message.id] });
    if ('rejected' in result) this.noteRejected(result.rejected);
    else this.metrics.captured += 1;
  }
}

function rowToFact(row: FactRow): MemoryFact {
  return { id: row.id, profileId: row.profile_id, scope: row.scope as 'user' | 'agent', kind: row.kind as FactKind, text: row.text,
    status: row.status, confidence: row.confidence, importance: row.importance, sourceMessageIds: JSON.parse(row.source_ids_json),
    supersedesId: row.supersedes_id ?? undefined, createdAt: row.created_at, updatedAt: row.updated_at };
}

export interface LegacyFactSlotMigrationPreview {
  factId: string;
  text: string;
  outcome: 'official_slot' | 'dynamic_candidate' | 'rejected';
  slotKey?: string;
  value?: unknown;
  reason?: string;
}
function emptyConsolidationResult(): MemoryConsolidationCommitResult {
  return { processed: 0, added: 0, reinforced: 0, replaced: 0, candidates: 0, ignored: 0 };
}
function clamp(value: number): number { return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0)); }
function formatSlotValue(value: unknown): string {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}
function isFactCoveredByOfficialSlot(fact: MemoryFact, officialSlotKeys: ReadonlySet<string>): boolean {
  const route = routeDeterministicMemorySlot(fact.text);
  return Boolean(route && officialSlotKeys.has(route.slotKey));
}

function normalizedTokens(text: string): string[] {
  const normalized = text.toLowerCase()
    .replace(/咖啡|coffee/g, 'coffee')
    .replace(/甜食|甜点|sweets?/g, 'sweet')
    .replace(/老板|boss/g, 'boss')
    .replace(/[^\p{L}\p{N}]+/gu, ' ');
  const semanticNormalized = normalized
    .replace(/\u5496\u5561/g, 'coffee')
    .replace(/\u751c\u98df|\u751c\u70b9/g, 'sweet')
    .replace(/\u8001\u677f/g, 'boss');
  const words = semanticNormalized.split(/\s+/).filter(word => word.length >= 2);
  // CJK 无空格文本按相邻双字切片，补足 unicode61 的分词缺口。
  for (const segment of semanticNormalized.match(/[\u3400-\u9fff]{2,}/g) ?? []) {
    for (let i = 0; i < segment.length - 1; i += 1) words.push(segment.slice(i, i + 2));
  }
  return [...new Set(words)];
}

function buildFtsQuery(query: string): string {
  const terms = query.match(/[\p{L}\p{N}]{2,}/gu) ?? [];
  const useful = terms.filter(term => !ENGLISH_STOPWORDS.has(term.toLowerCase()));
  // 自然语言问句含有的功能词不应让相关候选整体落选；FTS5 的 BM25 仍会把命中更多关键词的消息排在前面。
  return (useful.length > 0 ? useful : terms).map(term => `"${term.replace(/"/g, '')}"`).join(' OR ') || query;
}

const ENGLISH_STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'at', 'be', 'by', 'did', 'do', 'does', 'for', 'from', 'how', 'in', 'is', 'it', 'of', 'on', 'or', 'that', 'the', 'to', 'was', 'were', 'what', 'when', 'where', 'which', 'who', 'why', 'with', 'would', 'you', 'your',
]);

function isGenericPreferenceQuery(query: string): boolean {
  return /\b(?:prefer(?:ence)?|like|dislike|boundary|identity)\b/i.test(query)
    || /\u559c\u6b22|\u504f\u597d|\u600e\u4e48\u559d|\u8bb0\u4f4f/.test(query);
}

function overlapScore(query: string[], candidate: string[]): number {
  return query.filter(token => candidate.some(value => value === token || value.startsWith(token) || token.startsWith(value))).length / query.length;
}

function stableTokenHash(token: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < token.length; index += 1) {
    hash ^= token.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash | 0;
}

function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  if (left.length === 0 || left.length !== right.length) return 0;
  let dot = 0, leftNorm = 0, rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index]!, b = right[index]!;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  return leftNorm > 0 && rightNorm > 0 ? dot / Math.sqrt(leftNorm * rightNorm) : 0;
}

function mmrSelectMessages<T extends ChatMessage>(ranked: T[], query: string, limit: number): T[] {
  if (ranked.length <= limit) return ranked;
  const selected: T[] = [];
  const remaining = ranked.map((message, index) => ({ message, relevance: 1 / (index + 1), tokens: normalizedTokens(message.content) }));
  const queryTokens = normalizedTokens(query);
  while (selected.length < limit && remaining.length > 0) {
    let bestIndex = 0;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < remaining.length; index += 1) {
      const candidate = remaining[index]!;
      const queryRelevance = queryTokens.length > 0 ? overlapScore(queryTokens, candidate.tokens) : 0;
      const redundancy = selected.reduce((highest, chosen) => Math.max(highest, tokenJaccard(candidate.tokens, normalizedTokens(chosen.content))), 0);
      const score = 0.75 * (candidate.relevance + queryRelevance) - 0.25 * redundancy;
      if (score > bestScore) { bestScore = score; bestIndex = index; }
    }
    selected.push(remaining.splice(bestIndex, 1)[0]!.message);
  }
  return selected;
}

function tokenJaccard(left: string[], right: string[]): number {
  const a = new Set(left), b = new Set(right);
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

function hasRelevantTokens(query: string, candidate: string): boolean {
  const queryTokens = normalizedTokens(query);
  const candidateTokens = normalizedTokens(candidate);
  if (queryTokens.length === 0) return false;
  const distinctive = queryTokens.filter(token => !GENERIC_RELATION_TERMS.has(token) && !ENGLISH_STOPWORDS.has(token));
  const required = distinctive.length > 0 ? distinctive : queryTokens;
  return required.some(token => candidateTokens.some(value => value === token || value.startsWith(token) || token.startsWith(value)));
}

const GENERIC_RELATION_TERMS = new Set([
  'author', 'spouse', 'married', 'citizen', 'citizenship', 'country', 'city', 'continent', 'location', 'located',
  'sport', 'associated', 'position', 'birthplace', 'born', 'died', 'director', 'capital', 'headquarters',
  'what', 'which', 'where', 'when', 'person', 'name', 'current',
  '作者', '配偶', '国籍', '国家', '城市', '地点', '运动', '位置', '出生', '去世', '首都', '什么', '哪个',
]);

const EVIDENCE_QUERY_FILLERS = new Set([
  ...ENGLISH_STOPWORDS,
  ...GENERIC_RELATION_TERMS,
  'me', 'my', 'mine', 'please', 'tell', 'remember', 'recall', 'know', 'answer', 'information',
]);

const HIGH_RISK_EVIDENCE_QUALIFIERS = new Set([
  'undergrad', 'undergraduate', 'graduate', 'postgraduate', 'bachelor', 'master', 'phd', 'thesis', 'dissertation', 'course', 'class',
  'senior', 'junior', 'lead', 'manager', 'director', 'current', 'former', 'first', 'last', 'latest', 'previous', 'earlier', 'later',
  'personal', 'professional', 'internal', 'external', 'temporary', 'permanent',
]);

/**
 * BUG-MEM-18：量化问题限定词与 user/owner 权威证据之间的词面缺口。
 * 这里只生成保守提示，不替模型回答；bot/agent/summary 不得证明用户经历。
 */
function evidenceQualifierGaps(query: string, authoritativeEvidence: readonly string[]): string[] {
  if (!query.trim() || authoritativeEvidence.length === 0) return [];
  const queryTokens = normalizedTokens(normalizeEvidenceGapQuery(query)).filter(token => !EVIDENCE_QUERY_FILLERS.has(token));
  const evidenceTokens = normalizedTokens(authoritativeEvidence.join('\n'));
  const matches = (token: string, candidate: string): boolean =>
    token === candidate || (Math.min(token.length, candidate.length) >= 4 && (token.startsWith(candidate) || candidate.startsWith(token)));
  const missing = queryTokens.filter(token => !evidenceTokens.some(candidate => matches(token, candidate)));
  if (missing.length < 2 && !missing.some(token => HIGH_RISK_EVIDENCE_QUALIFIERS.has(token))) return [];
  return missing.slice(0, 8);
}

/**
 * 已命中的官方槽位由“目录语义 + 活跃值”共同构成权威证据。
 * 目录语义只证明问句主题与槽位匹配，最终回答内容仍只能来自活跃值。
 */
function officialSlotEvidence(slotValues: readonly MemorySlotValue[]): string[] {
  return slotValues.flatMap(value => {
    const definition = getMemorySlotDefinition(value.slotKey);
    if (!definition) return [formatSlotValue(value.value)];
    return [
      definition.slotKey,
      definition.group,
      definition.title,
      definition.description,
      ...definition.recallAliases,
      formatSlotValue(value.value),
    ];
  });
}

/**
 * 仅为证据缺口比较移除中文回忆问句的交互脚手架；原始 query 仍用于槽位和历史检索。
 * 限定为偏好问法与回忆提示，避免吞掉“本科、当前、职业”等真实限定词。
 */
function normalizeEvidenceGapQuery(query: string): string {
  return query
    .replace(/(?:你)?(?:知道|还知道|还记得)/gu, ' ')
    .replace(/(?:我说)?你(?:再)?(?:回想|想想|回忆|记得)(?:一下|下)?/gu, ' ')
    .replace(/我(?:最)?喜欢(?:的)?(?:是)?(?:什么|哪(?:个|些|部|种|类)?)/gu, ' ')
    .replace(/[呢吗呀啊嘛不]+$/gu, ' ')
    .trim();
}

function looksLikeRelationChainQuery(query: string): boolean {
  return /\b(?:spouse|author|citizen|citizenship|country of origin|place of birth|birthplace|capital of the country|continent (?:was|is)|headquarters|director|chairperson|creator|created|founded by|educated|sport|position|religion|language|fluent|founder|location of work)\b/i.test(query)
    || /\bof\b[^?]{0,80}\bof\b/i.test(query);
}

export function parseFactTriple(text: string): { key: string; subject: string; relation: string; object: string } | null {
  const clean = text.replace(/^\s*\d+\.\s*/, '').replace(/[.。]\s*$/, '').trim();
  const patterns: Array<{ relation: string; pattern: RegExp; subject: number; object: number }> = [
    { relation: 'current_head_of_state', pattern: /^The name of the current head of state in (.+?) is (.+)$/i, subject: 1, object: 2 },
    { relation: 'current_head_of_government', pattern: /^The name of the current head of the (.+?) government is (.+)$/i, subject: 1, object: 2 },
    { relation: 'current_head_of_government', pattern: /^The name of the current head of (.+?) government is (.+)$/i, subject: 1, object: 2 },
    { relation: 'educated_at', pattern: /^The univer(?:sity|isty) where (.+?) was educated is (.+)$/i, subject: 1, object: 2 },
    { relation: 'headquarters_city', pattern: /^The headquarters of (.+?) is located in the city of (.+)$/i, subject: 1, object: 2 },
    { relation: 'possessive_attribute', pattern: /^(.+?)[’']s (.+?) is (.+)$/i, subject: 1, object: 3 },
    { relation: 'attribute', pattern: /^The (.+?) of (.+?) is (.+)$/i, subject: 2, object: 3 },
    { relation: 'married_to', pattern: /^(.+?) is married to (.+)$/i, subject: 1, object: 2 },
    { relation: 'citizen_of', pattern: /^(.+?) is a citizen of (.+)$/i, subject: 1, object: 2 },
    { relation: 'founded_by', pattern: /^(.+?) was founded by (.+)$/i, subject: 1, object: 2 },
    { relation: 'developed_by', pattern: /^(.+?) was developed by (.+)$/i, subject: 1, object: 2 },
    { relation: 'performed_by', pattern: /^(.+?) was performed by (.+)$/i, subject: 1, object: 2 },
    { relation: 'created_by', pattern: /^(.+?) was created by (.+)$/i, subject: 1, object: 2 },
    { relation: 'employed_by', pattern: /^(.+?) is employed by (.+)$/i, subject: 1, object: 2 },
    { relation: 'famous_for', pattern: /^(.+?) is famous for (.+)$/i, subject: 1, object: 2 },
    { relation: 'religion', pattern: /^(.+?) is affiliated with the religion of (.+)$/i, subject: 1, object: 2 },
    { relation: 'language', pattern: /^(.+?) speaks the language of (.+)$/i, subject: 1, object: 2 },
    { relation: 'written_language', pattern: /^(.+?) was written in the language of (.+)$/i, subject: 1, object: 2 },
    { relation: 'occupation', pattern: /^(.+?) works in the field of (.+)$/i, subject: 1, object: 2 },
    { relation: 'sport', pattern: /^(.+?) is associated with the sport of (.+)$/i, subject: 1, object: 2 },
    { relation: 'position', pattern: /^(.+?) plays the position of (.+)$/i, subject: 1, object: 2 },
    { relation: 'created_in', pattern: /^(.+?) was created in the country of (.+)$/i, subject: 1, object: 2 },
    { relation: 'founded_in', pattern: /^(.+?) was founded in the city of (.+)$/i, subject: 1, object: 2 },
    { relation: 'born_in', pattern: /^(.+?) was born in the city of (.+)$/i, subject: 1, object: 2 },
    { relation: 'died_in', pattern: /^(.+?) died in the city of (.+)$/i, subject: 1, object: 2 },
    { relation: 'worked_in', pattern: /^(.+?) worked in the city of (.+)$/i, subject: 1, object: 2 },
    { relation: 'located_in', pattern: /^(.+?) is located in the (?:continent|country|city) of (.+)$/i, subject: 1, object: 2 },
  ];
  for (const entry of patterns) {
    const match = clean.match(entry.pattern);
    if (!match) continue;
    const subject = match[entry.subject]!.trim();
    const relationLabel = entry.relation === 'attribute' ? match[1] : entry.relation === 'possessive_attribute' ? match[2] : undefined;
    const relation = relationLabel ? relationLabel.trim().toLocaleLowerCase().replace(/\s+/g, '_') : entry.relation;
    return { key: `${normalizeRelationEntity(subject)}|${relation}`, subject, relation, object: match[entry.object]!.trim() };
  }
  return null;
}

function normalizeRelationEntity(value: string): string {
  return value.toLocaleLowerCase().replace(/^["'“”‘’]+|["'“”‘’.。]+$/g, '').replace(/\s+/g, ' ').trim();
}

function relationCandidatePriority(message: ChatMessage, queryOrEntity: string): number {
  const triple = parseFactTriple(message.content);
  if (!triple) return 0;
  const current = normalizeRelationEntity(queryOrEntity);
  const subject = normalizeRelationEntity(triple.subject);
  if (current === subject) return 4;
  if (subject.length >= 3 && current.includes(subject)) return 3;
  const object = normalizeRelationEntity(triple.object);
  if (object.length >= 3 && current.includes(object)) return 1;
  return 0;
}

export function extractRetrievalAnchors(text: string, includePredicateTail = true): string[] {
  const anchors: string[] = [];
  const add = (value: string | undefined) => {
    const clean = value?.replace(/^\d+\.\s*/, '').replace(/[\s,;:]+$/g, '').trim();
    if (!clean || clean.length < 2 || clean.length > 80) return;
    const tokens = normalizedTokens(clean);
    if (tokens.length === 0 || tokens.every(token => ENGLISH_STOPWORDS.has(token))) return;
    anchors.push(clean);
  };

  for (const match of text.matchAll(/["“《]([^"”》]{2,80})["”》]/gu)) add(match[1]);
  for (const match of text.matchAll(/[A-Z][A-Za-zÀ-ÖØ-öø-ÿ'’-]*(?:\s+(?:(?:of|the|and|de|da|von|van)\s+)?[A-Z][A-Za-zÀ-ÖØ-öø-ÿ'’-]*){0,5}/g)) add(match[0]);
  if (includePredicateTail) {
    for (const match of text.matchAll(/(?:\bis\b|\bwas\b|\bare\b|\bwere\b|\bby\b|\bto\b|是|为|叫)\s+([^\n.。!?？]{2,80})/giu)) add(match[1]);
  }
  return [...new Set(anchors)].slice(0, 16);
}

function preferenceSignature(text: string): { topic: string; polarity: 'like' | 'dislike' } | null {
  const normalized = text.trim().toLowerCase()
    .replace(/^\u6211\u4e0d\u559c\u6b22/, 'i dislike ')
    .replace(/^\u6211\u559c\u6b22/, 'i like ');
  const match = normalized.match(/^(?:i\s+)?(do not like|don't like|dislike|like)\s+(.+)$/i);
  if (!match) return null;
  const topic = normalizedTokens(match[2]!).filter(token => token.length >= 2).sort().join('|');
  if (!topic) return null;
  return { topic, polarity: match[1]!.toLowerCase() === 'like' ? 'like' : 'dislike' };
}
function cleanIntentTarget(text: string): string {
  return text.trim().replace(/(?:这件事|这个事情|这一点)[。！!?？]*$/u, '').trim();
}
function inferKind(text: string): FactKind {
  if (/(?:我叫|我的名字|名字是)/.test(text)) return 'identity';
  if (/(?:不要|边界|称呼|别叫|叫我|被叫|可以.*叫)/.test(text)) return 'boundary';
  return 'preference';
}
