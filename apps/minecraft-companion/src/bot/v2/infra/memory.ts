/**
 * 🧠 基础设施 #4 · Memory（v2 · 双层）
 *
 * 设计原则：纯被动数据仓库，只暴露 query() / record() 两个接口，不依赖任何模块。
 *
 * 双层：
 *   ⚡ RuntimeState（内存态 · 每 tick 刷）—— 当前 tick 临时变量、上下文
 *   💾 持久态（SQLite · better-sqlite3 同步 API）
 *
 * 5 个持久子系统（暂只实现 Task 和 Spatial 两个，其它先占位）。
 *
 * US-C1: SQLite 接入
 *   - MemoryV2 constructor 接受 dbPath?: string（默认 'data/v2-memory.db'）
 *   - 3 张表：tasks / spatial / events
 *   - record() → INSERT OR REPLACE 到 SQLite + 更新内存 Map
 *   - query() → 从内存 Map 读取（write-through cache，内存为权威）
 *   - 构造时：init schema + 加载已有 paused/running 任务到内存
 *   - commitTick() → flush pending → 调用 record()（已写 DB）
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Vec3 } from '../../adapter/types.js';
import {
  openSqliteDatabase,
  type SqliteDatabase,
} from './sqliteDatabase.js';

export type MemoryType = 'task' | 'spatial' | 'object' | 'event' | 'user' | 'conversation' | 'trajectory';

export interface TaskSnapshot {
  taskId: string;
  kind: string; // 'follow_owner' / 'farm' / ...
  state: 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
  /** 暂停时的断点上下文 · ResumeManager 用 */
  resumePoint?: Record<string, unknown>;
  /** 父任务（恢复时用） */
  parentId?: string;
  /** 只有 user_visible 任务的终态才允许唤醒 MainBrain 决定是否告知用户。 */
  feedbackPolicy?: 'user_visible' | 'internal' | 'silent';
  feedbackRootId?: string;
  feedbackGeneration?: number;
  createdAt: number;
  updatedAt: number;
}

export interface SpatialEntry {
  // FEAT-MEM-02: 新增 'landmark'（命名地标，meta.name 存语义名，如"矿洞口"/"村庄"）
  kind: 'home' | 'path_waypoint' | 'danger_zone' | 'resource' | 'chest' | 'landmark';
  position: Vec3;
  /**
   * meta 字段约定（schema 不变 · 各写入方按约定挂字段）：
   * - WorldScanCapability  (kind='chest'/'resource'/'landmark') : { blockName?, scannedAt?, items?, name? }
   * - MineralProbeCapability (kind='resource', FEAT-L2-02)      : { mineralType, blockName, scannedAt }
   *   · meta.mineralType 是矿物条目的判别标志，缺失即非矿物
   *   · dispatcher.find_mineral 按 mineralType 过滤
   */
  meta?: Record<string, unknown>;
  timestamp: number;
}

export interface ObjectEntry {
  kind: string;
  name: string;
  position: Vec3;
  meta?: Record<string, unknown>;
  timestamp: number;
}

export interface EventEntry {
  id: string;
  type: string;
  level: string;
  payload: unknown;
  timestamp: number;
}

export interface UserEntry {
  username: string;
  preferences: Record<string, unknown>;
  historySummary: string;
  updatedAt: number;
}

export interface ToolCallSummary {
  tool: string;
  input: Record<string, unknown>;
  result: 'ok' | 'error';
  brief?: string;
}

/**
 * FEAT-MEM-05 · 位置轨迹时序点
 *
 * 每 30s 由 v2Runtime 写一行；同 ts 去重以防节流抖动重复写。
 */
export interface TrajectoryEntry {
  timestamp: number;
  x: number;
  y: number;
  z: number;
  /** mineflayer game.dimension（'overworld' / 'the_nether' / 'the_end'） */
  dimension: string;
  /** 生物群系名 · 暂不接（mineflayer block.biome 需 chunk 加载），先存 'unknown' 占位 */
  biome?: string;
}

export interface ConversationEntry {
  id: string;                    // 'conv-{timestamp}-{seq}'
  turnId: string;                // 关联 MainBrain turn 的唯一 ID
  role: 'owner' | 'bot' | 'system';
  content: string;
  toolCalls?: ToolCallSummary[];
  timestamp: number;
  meta?: {
    source?: 'game_chat' | 'web_ui';
    isPending?: boolean;         // ask_master 挂起状态
    taskContext?: string;
  };
}

interface PendingRecord {
  type: MemoryType;
  entry: unknown;
}

// ── SQLite row shapes ────────────────────────────────────────────────────────

interface TaskRow {
  id: string;
  kind: string;
  state: string;
  params_json: string | null;
  progress_json: string | null;
  resume_point_json: string | null;
  parent_id: string | null;
  created_at: number;
  updated_at: number;
}

interface SpatialRow {
  id: string;
  kind: string;
  x: number;
  y: number;
  z: number;
  meta_json: string | null;
  ts: number;
}

interface ObjectRow {
  id: string;
  kind: string;
  name: string;
  pos_x: number;
  pos_y: number;
  pos_z: number;
  meta_json: string | null;
  ts: number;
}

interface UserRow {
  username: string;
  preferences_json: string | null;
  history_summary: string | null;
  updated_at: number;
}

interface TrajectoryRow {
  ts: number;
  x: number;
  y: number;
  z: number;
  dimension: string;
  biome: string | null;
}

interface ConversationRow {
  id: string;
  turn_id: string;
  role: string;
  content: string;
  tool_calls_json: string | null;
  source: string | null;
  is_pending: number;
  task_context: string | null;
  ts: number;
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** Generate a stable id for a SpatialEntry (kind + position) */
function spatialId(e: SpatialEntry): string {
  return `${e.kind}:${e.position.x}:${e.position.y}:${e.position.z}`;
}

function taskRowToSnapshot(row: TaskRow): TaskSnapshot {
  return {
    taskId: row.id,
    kind: row.kind,
    state: row.state as TaskSnapshot['state'],
    resumePoint: row.resume_point_json ? (JSON.parse(row.resume_point_json) as Record<string, unknown>) : undefined,
    parentId: row.parent_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class MemoryV2 {
  // 持久态（write-through cache + SQLite）
  private tasks = new Map<string, TaskSnapshot>();
  private spatial: SpatialEntry[] = [];
  private objects: ObjectEntry[] = [];
  private events: EventEntry[] = [];
  private users = new Map<string, UserEntry>();
  private conversations: ConversationEntry[] = [];  // ring buffer, 上限 MAX_CONV_ENTRIES

  /** FEAT-MEM-05 · 轨迹 ring buffer · 内存上限 MAX_TRAJECTORY_ENTRIES（约 30s × 5760 = 48 小时） */
  private trajectory: TrajectoryEntry[] = [];
  private static readonly MAX_TRAJECTORY_ENTRIES = 5760;

  private static readonly MAX_CONV_ENTRIES = 50;

  // Event auto-archive counter
  private eventArchivedCount = 0;

  // SQLite（better-sqlite3 · 同步 API）
  private db: SqliteDatabase | null = null;

  // RuntimeState（每 tick 重置或长存看键）
  private runtime = new Map<string, unknown>();

  // 待提交队列（⑩ MemoryCommit 一次性落盘）
  private pending: PendingRecord[] = [];

  // ─────────────────────────────────────────────────────────────────────────
  constructor(dbPath: string = 'data/v2-memory.db') {
    this._initDb(dbPath);
  }

  // ── 内部：初始化 DB ────────────────────────────────────────────────────────

  private _initDb(dbPath: string): void {
    try {
      // 确保父目录存在
      const dir = path.dirname(dbPath);
      fs.mkdirSync(dir, { recursive: true });

      this.db = openSqliteDatabase(dbPath);

      // 创建表（idempotent）
      this.db.prepare(`
        CREATE TABLE IF NOT EXISTS tasks (
          id               TEXT PRIMARY KEY,
          kind             TEXT NOT NULL,
          state            TEXT NOT NULL,
          params_json      TEXT,
          progress_json    TEXT,
          resume_point_json TEXT,
          parent_id        TEXT,
          created_at       INTEGER NOT NULL,
          updated_at       INTEGER NOT NULL
        )
      `).run();

      this.db.prepare(`
        CREATE TABLE IF NOT EXISTS spatial (
          id       TEXT PRIMARY KEY,
          kind     TEXT NOT NULL,
          x        REAL NOT NULL,
          y        REAL NOT NULL,
          z        REAL NOT NULL,
          meta_json TEXT,
          ts       INTEGER NOT NULL
        )
      `).run();

      this.db.prepare(`
        CREATE TABLE IF NOT EXISTS events (
          id          TEXT PRIMARY KEY,
          type        TEXT NOT NULL,
          level       TEXT NOT NULL,
          payload_json TEXT,
          ts          INTEGER NOT NULL
        )
      `).run();

      this.db.prepare(`
        CREATE TABLE IF NOT EXISTS objects (
          id       TEXT PRIMARY KEY,
          kind     TEXT NOT NULL,
          name     TEXT NOT NULL,
          pos_x    REAL NOT NULL,
          pos_y    REAL NOT NULL,
          pos_z    REAL NOT NULL,
          meta_json TEXT,
          ts       INTEGER NOT NULL
        )
      `).run();

      this.db.prepare(`
        CREATE TABLE IF NOT EXISTS users (
          username         TEXT PRIMARY KEY,
          preferences_json TEXT,
          history_summary  TEXT,
          updated_at       INTEGER NOT NULL
        )
      `).run();

      this.db.prepare(`
        CREATE TABLE IF NOT EXISTS conversations (
          id              TEXT PRIMARY KEY,
          turn_id         TEXT NOT NULL,
          role            TEXT NOT NULL,
          content         TEXT NOT NULL,
          tool_calls_json TEXT,
          source          TEXT DEFAULT 'game_chat',
          is_pending      INTEGER DEFAULT 0,
          task_context    TEXT,
          ts              INTEGER NOT NULL
        )
      `).run();

      // FEAT-MEM-05 · 位置轨迹时序表
      this.db.prepare(`
        CREATE TABLE IF NOT EXISTS trajectory (
          ts        INTEGER PRIMARY KEY,
          x         REAL NOT NULL,
          y         REAL NOT NULL,
          z         REAL NOT NULL,
          dimension TEXT NOT NULL,
          biome     TEXT
        )
      `).run();

      this.db.prepare(`
        CREATE INDEX IF NOT EXISTS idx_trajectory_ts ON trajectory(ts)
      `).run();

      this.db.prepare(`
        CREATE INDEX IF NOT EXISTS idx_conv_ts ON conversations(ts)
      `).run();

      this.db.prepare(`
        CREATE INDEX IF NOT EXISTS idx_conv_pending ON conversations(is_pending) WHERE is_pending = 1
      `).run();

      // 启动时加载 paused / running 任务到内存
      const rows = this.db
        .prepare(`SELECT * FROM tasks WHERE state IN ('running','paused')`)
        .all() as TaskRow[];

      for (const row of rows) {
        this.tasks.set(row.id, taskRowToSnapshot(row));
      }

      // FEAT-MEM-05 · 启动时加载最近 MAX_TRAJECTORY_ENTRIES 行轨迹到内存
      const trajRows = this.db
        .prepare(`SELECT * FROM trajectory ORDER BY ts DESC LIMIT ?`)
        .all(MemoryV2.MAX_TRAJECTORY_ENTRIES) as TrajectoryRow[];

      for (const row of trajRows.reverse()) {
        this.trajectory.push({
          timestamp: row.ts,
          x: row.x,
          y: row.y,
          z: row.z,
          dimension: row.dimension,
          biome: row.biome ?? undefined,
        });
      }

      // 启动时加载最近对话到内存
      const convRows = this.db
        .prepare(`SELECT * FROM conversations ORDER BY ts DESC LIMIT ?`)
        .all(MemoryV2.MAX_CONV_ENTRIES) as ConversationRow[];

      for (const row of convRows.reverse()) {
        this.conversations.push(this._convRowToEntry(row));
      }
    } catch (err) {
      // SQLite 初始化失败时降级为纯内存模式（保证向后兼容）
      console.error('[MemoryV2] SQLite init failed, falling back to in-memory only:', err);
      this.db = null;
    }
  }

  // ──────────────────── query ────────────────────

  query(type: 'task', filter?: { id?: string; state?: TaskSnapshot['state'] }): TaskSnapshot[];
  query(type: 'spatial', filter?: { kind?: SpatialEntry['kind'] }): SpatialEntry[];
  query(type: 'object', filter?: { kind?: string; name?: string }): ObjectEntry[];
  query(type: 'event', filter?: { type?: string; level?: string }): EventEntry[];
  query(type: 'user', filter?: { username?: string }): UserEntry[];
  query(type: 'conversation', filter?: { isPending?: boolean; turnId?: string }): ConversationEntry[];
  query(type: 'trajectory', filter?: { sinceMs?: number; untilMs?: number; limit?: number }): TrajectoryEntry[];
  query(type: MemoryType, filter?: Record<string, unknown>): unknown[];
  query(type: MemoryType, filter?: Record<string, unknown>): unknown[] {
    if (type === 'task') {
      // 从内存 Map 读取（write-through cache，内存为权威）
      let list = Array.from(this.tasks.values());
      if (filter?.id) list = list.filter(t => t.taskId === filter['id']);
      if (filter?.state) list = list.filter(t => t.state === filter['state']);
      return list;
    }
    if (type === 'spatial') {
      let list = this.spatial;
      if (filter?.kind) list = list.filter(s => s.kind === filter['kind']);
      return list;
    }
    if (type === 'object') {
      let list = this.objects;
      if (filter?.kind) list = list.filter(o => o.kind === filter['kind']);
      if (filter?.name) list = list.filter(o => o.name === filter['name']);
      return list;
    }
    if (type === 'event') {
      let list = this.events;
      if (filter?.type) list = list.filter(e => e.type === filter['type']);
      if (filter?.level) list = list.filter(e => e.level === filter['level']);
      return list;
    }
    if (type === 'user') {
      let list = Array.from(this.users.values());
      if (filter?.username) list = list.filter(u => u.username === filter['username']);
      return list;
    }
    if (type === 'conversation') {
      let list = this.conversations;
      if (filter?.isPending !== undefined) {
        list = list.filter(c => (c.meta?.isPending ?? false) === filter['isPending']);
      }
      if (filter?.turnId) {
        list = list.filter(c => c.turnId === filter['turnId']);
      }
      return list;
    }
    if (type === 'trajectory') {
      let list = this.trajectory;
      const since = filter?.sinceMs as number | undefined;
      const until = filter?.untilMs as number | undefined;
      const limit = filter?.limit as number | undefined;
      if (since !== undefined) list = list.filter(t => t.timestamp >= since);
      if (until !== undefined) list = list.filter(t => t.timestamp <= until);
      if (limit !== undefined && list.length > limit) list = list.slice(-limit);
      return list;
    }
    return [];
  }

  // ──────────────────── FEAT-MEM-05 · 轨迹专用 API ────────────────────

  /**
   * 返回最近 timestamp 附近的轨迹点（≤ ts 的最后一行）· 用于"1 小时前我在哪"。
   * 找不到时返回 null。
   */
  recallTrajectoryAt(timestampMs: number): TrajectoryEntry | null {
    // ring buffer 时间单调递增 · 倒序找第一条 ≤ ts
    for (let i = this.trajectory.length - 1; i >= 0; i--) {
      if (this.trajectory[i].timestamp <= timestampMs) return this.trajectory[i];
    }
    return null;
  }

  /**
   * 统计某段时间内去过的维度/biome 集合。
   */
  trajectoryDimensions(sinceMs?: number): string[] {
    const since = sinceMs ?? 0;
    const set = new Set<string>();
    for (const t of this.trajectory) {
      if (t.timestamp >= since) set.add(t.dimension);
    }
    return Array.from(set);
  }

  // ──────────────────── FEAT-MEM-06 · 箱子内容索引 ────────────────────

  /**
   * 把箱子的内容（一组物品名）写进 spatial.meta.items · 后续 ChestMemoryProvider 与
   * find_chest_with 工具读取。
   */
  indexChest(pos: Vec3, itemNames: string[]): void {
    // 用 'chest' kind + 同坐标定位现有条目（spatialId 用 kind:x:y:z 当主键）
    const id = `chest:${pos.x}:${pos.y}:${pos.z}`;
    const existing = this.spatial.find(e => spatialId(e) === id);
    const meta: Record<string, unknown> = {
      ...(existing?.meta ?? {}),
      items: Array.from(new Set(itemNames)),  // 去重
      itemsScannedAt: Date.now(),
    };
    const entry: SpatialEntry = {
      kind: 'chest',
      position: { x: pos.x, y: pos.y, z: pos.z },
      meta,
      timestamp: Date.now(),
    };
    this.record('spatial', entry);
  }

  /**
   * 查询「哪个箱子里有 itemName」· 按距离排序由调用方做（这里只筛选）。
   * 返回所有 kind=chest 且 meta.items 含目标的 spatial 条目。
   */
  findChestsWith(itemName: string): SpatialEntry[] {
    const out: SpatialEntry[] = [];
    for (const e of this.spatial) {
      if (e.kind !== 'chest') continue;
      const items = e.meta?.items as string[] | undefined;
      if (items && items.includes(itemName)) out.push(e);
    }
    return out;
  }

  // ──────────────────── record（同步 · 立即生效） ────────────────────

  /** 立即生效的 record（任务状态变更必须立即可见，不能等 commit） */
  record(type: 'task', entry: TaskSnapshot): void;
  record(type: 'spatial', entry: SpatialEntry): void;
  record(type: 'object', entry: ObjectEntry): void;
  record(type: 'event', entry: EventEntry): void;
  record(type: 'user', entry: UserEntry): void;
  record(type: 'conversation', entry: ConversationEntry): void;
  record(type: 'trajectory', entry: TrajectoryEntry): void;
  record(type: MemoryType, entry: unknown): void;
  record(type: MemoryType, entry: unknown): void {
    if (type === 'task') {
      const t = entry as TaskSnapshot;
      // 更新内存 Map
      this.tasks.set(t.taskId, t);
      // 写入 SQLite
      this._upsertTask(t);
      return;
    }
    if (type === 'spatial') {
      const s = entry as SpatialEntry;
      // 去重：先移除同 id 的旧条目
      const id = spatialId(s);
      this.spatial = this.spatial.filter(e => spatialId(e) !== id);
      this.spatial.push(s);
      // 写入 SQLite
      this._upsertSpatial(id, s);
      return;
    }
    if (type === 'object') {
      const o = entry as ObjectEntry;
      const id = `${o.kind}:${o.name}:${o.position.x}:${o.position.y}:${o.position.z}`;
      this.objects = this.objects.filter(e =>
        `${e.kind}:${e.name}:${e.position.x}:${e.position.y}:${e.position.z}` !== id,
      );
      this.objects.push(o);
      this._upsertObject(id, o);
      return;
    }
    if (type === 'event') {
      const e = entry as EventEntry;
      // Events are append-only (no dedup by id); cap in-memory list to last 1000
      this.events.push(e);
      if (this.events.length > 1000) this.events = this.events.slice(-1000);
      this._upsertEvent(e);
      return;
    }
    if (type === 'user') {
      const u = entry as UserEntry;
      this.users.set(u.username, u);
      this._upsertUser(u);
      return;
    }
    if (type === 'conversation') {
      const c = entry as ConversationEntry;
      this.conversations.push(c);
      if (this.conversations.length > MemoryV2.MAX_CONV_ENTRIES) {
        this.conversations = this.conversations.slice(-MemoryV2.MAX_CONV_ENTRIES);
      }
      this._upsertConversation(c);
      return;
    }
    if (type === 'trajectory') {
      const t = entry as TrajectoryEntry;
      // 同 ts 去重（节流抖动防重复）
      if (this.trajectory.length > 0 && this.trajectory[this.trajectory.length - 1].timestamp === t.timestamp) {
        return;
      }
      this.trajectory.push(t);
      if (this.trajectory.length > MemoryV2.MAX_TRAJECTORY_ENTRIES) {
        this.trajectory = this.trajectory.slice(-MemoryV2.MAX_TRAJECTORY_ENTRIES);
      }
      this._upsertTrajectory(t);
      return;
    }
  }

  // ── SQLite 写入辅助 ────────────────────────────────────────────────────────

  private _upsertTask(t: TaskSnapshot): void {
    if (!this.db) return;
    try {
      this.db.prepare(`
        INSERT OR REPLACE INTO tasks
          (id, kind, state, params_json, progress_json, resume_point_json, parent_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        t.taskId,
        t.kind,
        t.state,
        null,                                                    // params_json（暂无）
        null,                                                    // progress_json（暂无）
        t.resumePoint ? JSON.stringify(t.resumePoint) : null,
        t.parentId ?? null,
        t.createdAt,
        t.updatedAt,
      );
    } catch (err) {
      console.error('[MemoryV2] _upsertTask failed:', err);
    }
  }

  private _upsertSpatial(id: string, s: SpatialEntry): void {
    if (!this.db) return;
    try {
      this.db.prepare(`
        INSERT OR REPLACE INTO spatial (id, kind, x, y, z, meta_json, ts)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        s.kind,
        s.position.x,
        s.position.y,
        s.position.z,
        s.meta ? JSON.stringify(s.meta) : null,
        s.timestamp,
      );
    } catch (err) {
      console.error('[MemoryV2] _upsertSpatial failed:', err);
    }
  }

  private _upsertObject(id: string, o: ObjectEntry): void {
    if (!this.db) return;
    try {
      this.db.prepare(`
        INSERT OR REPLACE INTO objects (id, kind, name, pos_x, pos_y, pos_z, meta_json, ts)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        o.kind,
        o.name,
        o.position.x,
        o.position.y,
        o.position.z,
        o.meta ? JSON.stringify(o.meta) : null,
        o.timestamp,
      );
    } catch (err) {
      console.error('[MemoryV2] _upsertObject failed:', err);
    }
  }

  private _upsertEvent(e: EventEntry): void {
    if (!this.db) return;
    try {
      this.db.prepare(`
        INSERT OR REPLACE INTO events (id, type, level, payload_json, ts)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        e.id,
        e.type,
        e.level,
        e.payload !== undefined ? JSON.stringify(e.payload) : null,
        e.timestamp,
      );
    } catch (err) {
      console.error('[MemoryV2] _upsertEvent failed:', err);
    }
  }

  private _upsertUser(u: UserEntry): void {
    if (!this.db) return;
    try {
      this.db.prepare(`
        INSERT OR REPLACE INTO users (username, preferences_json, history_summary, updated_at)
        VALUES (?, ?, ?, ?)
      `).run(
        u.username,
        JSON.stringify(u.preferences),
        u.historySummary,
        u.updatedAt,
      );
    } catch (err) {
      console.error('[MemoryV2] _upsertUser failed:', err);
    }
  }

  private _upsertConversation(c: ConversationEntry): void {
    if (!this.db) return;
    try {
      this.db.prepare(`
        INSERT OR REPLACE INTO conversations
          (id, turn_id, role, content, tool_calls_json, source, is_pending, task_context, ts)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        c.id,
        c.turnId,
        c.role,
        c.content,
        c.toolCalls ? JSON.stringify(c.toolCalls) : null,
        c.meta?.source ?? 'game_chat',
        c.meta?.isPending ? 1 : 0,
        c.meta?.taskContext ?? null,
        c.timestamp,
      );
    } catch (err) {
      console.error('[MemoryV2] _upsertConversation failed:', err);
    }
  }

  private _upsertTrajectory(t: TrajectoryEntry): void {
    if (!this.db) return;
    try {
      this.db.prepare(`
        INSERT OR REPLACE INTO trajectory (ts, x, y, z, dimension, biome)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        t.timestamp,
        t.x,
        t.y,
        t.z,
        t.dimension,
        t.biome ?? null,
      );
    } catch (err) {
      console.error('[MemoryV2] _upsertTrajectory failed:', err);
    }
  }

  private _convRowToEntry(row: ConversationRow): ConversationEntry {
    return {
      id: row.id,
      turnId: row.turn_id,
      role: row.role as ConversationEntry['role'],
      content: row.content,
      toolCalls: row.tool_calls_json ? (JSON.parse(row.tool_calls_json) as ToolCallSummary[]) : undefined,
      timestamp: row.ts,
      meta: {
        source: (row.source as 'game_chat' | 'web_ui') ?? 'game_chat',
        isPending: row.is_pending === 1,
        taskContext: row.task_context ?? undefined,
      },
    };
  }

  // ──────────────────── RuntimeState（每 tick 内可写读，不落盘） ────────────────────

  setRuntime(key: string, value: unknown): void {
    this.runtime.set(key, value);
  }

  getRuntime<T = unknown>(key: string): T | undefined {
    return this.runtime.get(key) as T | undefined;
  }

  /** 在 tick 开始处可调用，丢掉本 tick 的临时变量（如有需要） */
  clearRuntime(prefix?: string): void {
    if (!prefix) {
      this.runtime.clear();
      return;
    }
    for (const k of Array.from(this.runtime.keys())) {
      if (k.startsWith(prefix)) this.runtime.delete(k);
    }
  }

  // ──────────────────── MemoryCommit（⑩ 步骤） ────────────────────

  /** 提交一条记录到 pending，由 ⑩ MemoryCommit 统一落盘 */
  scheduleCommit(type: MemoryType, entry: unknown): void {
    this.pending.push({ type, entry });
  }

  /** Heartbeat ⑩ MemoryCommit · 一次性落盘所有 pending */
  commitTick(): number {
    const count = this.pending.length;
    for (const p of this.pending) {
      this.record(p.type as MemoryType, p.entry as TaskSnapshot);
      if (p.type === 'event') this.eventArchivedCount++;
    }
    this.pending = [];
    return count;
  }

  /**
   * BUG-CROSS-36 · 幂等清理误入业务事件库的瞬时 telemetry。
   * 只接受调用方给出的精确 type 白名单，不做模糊匹配，也不自动 VACUUM。
   */
  pruneEventsByType(types: readonly string[]): number {
    const uniqueTypes = [...new Set(types.filter(Boolean))];
    if (uniqueTypes.length === 0) return 0;
    const selected = new Set(uniqueTypes);
    this.events = this.events.filter(event => !selected.has(event.type));
    this.pending = this.pending.filter(pending => {
      if (pending.type !== 'event') return true;
      const event = pending.entry as Partial<EventEntry>;
      return !event.type || !selected.has(event.type);
    });
    if (!this.db) return 0;
    const placeholders = uniqueTypes.map(() => '?').join(',');
    return this.db.prepare(`DELETE FROM events WHERE type IN (${placeholders})`).run(...uniqueTypes).changes;
  }

  // ──────────────────── 调试 ────────────────────

  snapshot() {
    return {
      tasks: Array.from(this.tasks.values()),
      spatialCount: this.spatial.length,
      objectCount: this.objects.length,
      eventCount: this.events.length,
      userCount: this.users.size,
      conversationCount: this.conversations.length,
      trajectoryCount: this.trajectory.length,
      runtimeKeys: Array.from(this.runtime.keys()),
      pendingCount: this.pending.length,
      dbConnected: this.db !== null,
      eventArchivedCount: this.eventArchivedCount,
    };
  }

  /** 结构化调试信息（含 eventArchivedCount） */
  inspect() {
    return {
      taskCount: this.tasks.size,
      spatialCount: this.spatial.length,
      objectCount: this.objects.length,
      eventCount: this.events.length,
      userCount: this.users.size,
      conversationCount: this.conversations.length,
      trajectoryCount: this.trajectory.length,
      pendingCount: this.pending.length,
      dbConnected: this.db !== null,
      eventArchivedCount: this.eventArchivedCount,
    };
  }

  /** 关闭 SQLite 连接（进程退出前调用） */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}
