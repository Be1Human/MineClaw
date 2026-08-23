/**
 * 🗺 WorldMapStore — 方块级地形持久化（SQLite + LRU 缓存）
 *
 * FEAT-L1-01 Phase 1
 *
 * 职责：把 Bot 走过的方块数据存进独立 SQLite 数据库，供 patchedBlockAt 在
 * chunk 未加载时回退查询，也供后续 GlobalVoxelPlanner 做远距离 A*。
 *
 * 设计要点：
 * - 独立 DB 文件（world_map.db），不与 MemoryV2 事务竞争
 * - WAL 模式 + prepared statements 保证写入性能
 * - 10k 条 LRU 缓存减少重复 IO
 * - 只存对 pathfinder 有意义的信息（blockId / name / boundingBox properties）
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  openSqliteDatabase,
  type SqliteDatabase,
} from './sqliteDatabase.js';

export interface StoredBlock {
  x: number;
  y: number;
  z: number;
  blockName: string;
  /** 'block' | 'empty' — 对应 mineflayer Block.boundingBox */
  boundingBox: string;
  /** JSON 序列化的状态属性（如门的 open/facing） */
  properties?: string;
  updatedAt: number;
  /**
   * FEAT-L1-05 · 记忆置信度（默认 1.0，记忆与实地不符 → decay，到 0 时 forget）
   * 仅当 stored.confidence > 0 时 patchedBlockAt 才会用它做回退。
   */
  confidence?: number;
}

export interface WorldMapStats {
  totalBlocks: number;
  chunksWithData: number;
}

export interface WorldMapStore {
  /** BUG-CROSS-07 · O(1) 判断坐标是否有持久记忆，供体积扫描避开同步 SQLite 点查。 */
  hasBlock?(x: number, y: number, z: number): boolean;
  getBlock(x: number, y: number, z: number): StoredBlock | null;
  upsertBatch(blocks: StoredBlock[]): void;
  getRegion(minX: number, maxX: number, minZ: number, maxZ: number): StoredBlock[];
  chunkHasData(chunkX: number, chunkZ: number): boolean;
  getStats(): WorldMapStats;
  close(): void;

  // ── FEAT-L1-05 · 记忆过期纠错 ─────────────────────────────────────────
  /**
   * 把 (x,y,z) 的记忆 confidence 降低 delta（默认 0.1）。
   * confidence 降到 ≤ 0 时自动 forget。
   * 返回剩余 confidence；若该坐标本来就没有记忆，返回 null。
   */
  decayConfidence(x: number, y: number, z: number, delta?: number): number | null;
  /** 立刻删除 (x,y,z) 的记忆 */
  forgetBlock(x: number, y: number, z: number): void;
  /**
   * 用最新值覆盖记忆（confidence 重置为 1.0）。
   * 用于 patchedBlockAt 反写真实值。
   */
  updateBlock(block: StoredBlock): void;
}

// ─── LRU Cache ────────────────────────────────────────────

class LRUCache<K, V> {
  private map = new Map<K, V>();
  constructor(private readonly capacity: number) {}

  get(key: K): V | undefined {
    const val = this.map.get(key);
    if (val !== undefined) {
      // move to end (most recently used)
      this.map.delete(key);
      this.map.set(key, val);
    }
    return val;
  }

  set(key: K, val: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, val);
    if (this.map.size > this.capacity) {
      // delete oldest (first entry)
      const first = this.map.keys().next().value;
      if (first !== undefined) this.map.delete(first);
    }
  }

  delete(key: K): void {
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }
}

/**
 * BUG-CROSS-11 · 稠密 voxel 存在性索引。
 *
 * 两级空间分片：chunk(16×16) → vertical section(16 高) → 4096 bit。
 * 任意 Y 都能编码；每个实际出现的 section 只占 512 bytes，避免每方块一个
 * string/Set entry，也避免对自定义世界高度做硬编码。
 */
class BlockPresenceIndex {
  private readonly chunks = new Map<string, Map<number, Uint32Array>>();

  has(x: number, y: number, z: number): boolean {
    const section = this.chunks.get(this.chunkKey(x, z))?.get(Math.floor(y / 16));
    if (!section) return false;
    const bit = this.bitIndex(x, y, z);
    return (section[bit >>> 5] & (1 << (bit & 31))) !== 0;
  }

  add(x: number, y: number, z: number): void {
    const chunkKey = this.chunkKey(x, z);
    let chunk = this.chunks.get(chunkKey);
    if (!chunk) {
      chunk = new Map();
      this.chunks.set(chunkKey, chunk);
    }
    const sectionY = Math.floor(y / 16);
    let section = chunk.get(sectionY);
    if (!section) {
      section = new Uint32Array(128); // 16×16×16 / 32
      chunk.set(sectionY, section);
    }
    const bit = this.bitIndex(x, y, z);
    section[bit >>> 5] |= 1 << (bit & 31);
  }

  delete(x: number, y: number, z: number): void {
    const section = this.chunks.get(this.chunkKey(x, z))?.get(Math.floor(y / 16));
    if (!section) return;
    const bit = this.bitIndex(x, y, z);
    section[bit >>> 5] &= ~(1 << (bit & 31));
  }

  clear(): void {
    this.chunks.clear();
  }

  private chunkKey(x: number, z: number): string {
    return `${Math.floor(x / 16)}:${Math.floor(z / 16)}`;
  }

  private bitIndex(x: number, y: number, z: number): number {
    const localX = ((x % 16) + 16) % 16;
    const localY = ((y % 16) + 16) % 16;
    const localZ = ((z % 16) + 16) % 16;
    return (localY << 8) | (localZ << 4) | localX;
  }
}

// ─── Implementation ───────────────────────────────────────

export class WorldMapStoreImpl implements WorldMapStore {
  private db: SqliteDatabase;
  private cache = new LRUCache<string, StoredBlock | null>(10_000);
  /** BUG-CROSS-11 · 按 chunk/section 压缩的精确 bitset 索引。 */
  private knownBlocks = new BlockPresenceIndex();

  // Prepared statements (typed as any to avoid better-sqlite3 generic variance issues)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private stmtGet!: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private stmtUpsert!: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private stmtChunkHas!: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private stmtRegion!: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private stmtCount!: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private stmtChunkCount!: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private txnUpsertBatch!: any;

  constructor(dbPath: string) {
    // Ensure directory exists
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    this.db = openSqliteDatabase(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');

    this.initSchema();
    this.prepareStatements();
    const known = this.db.prepare('SELECT x, y, z FROM blocks');
    for (const row of known.iterate() as IterableIterator<{ x: number; y: number; z: number }>) {
      this.knownBlocks.add(row.x, row.y, row.z);
    }
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS blocks (
        x INTEGER NOT NULL,
        y INTEGER NOT NULL,
        z INTEGER NOT NULL,
        block_name TEXT NOT NULL,
        bounding_box TEXT NOT NULL DEFAULT 'block',
        properties TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (x, y, z)
      );
      CREATE INDEX IF NOT EXISTS idx_blocks_chunk
        ON blocks ((x >> 4), (z >> 4));
    `);

    // FEAT-L1-05 · idempotent 增加 confidence 列（已有库可能没有此列）
    try {
      const cols = this.db.prepare(`PRAGMA table_info(blocks)`).all() as Array<{ name: string }>;
      if (!cols.some(c => c.name === 'confidence')) {
        this.db.exec(`ALTER TABLE blocks ADD COLUMN confidence REAL NOT NULL DEFAULT 1.0`);
      }
    } catch (err) {
      console.error('[WorldMapStore] confidence column migration failed:', err);
    }
  }

  // FEAT-L1-05 · 额外 statements（懒声明，初始化时一并 prepare）
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private stmtDelete!: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private stmtDecay!: any;

  private prepareStatements(): void {
    this.stmtGet = this.db.prepare(
      'SELECT x, y, z, block_name, bounding_box, properties, updated_at, confidence FROM blocks WHERE x = ? AND y = ? AND z = ?',
    );
    this.stmtUpsert = this.db.prepare(`
      INSERT OR REPLACE INTO blocks (x, y, z, block_name, bounding_box, properties, updated_at, confidence)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.stmtChunkHas = this.db.prepare(
      'SELECT 1 FROM blocks WHERE (x >> 4) = ? AND (z >> 4) = ? LIMIT 1',
    );
    this.stmtRegion = this.db.prepare(
      'SELECT x, y, z, block_name, bounding_box, properties, updated_at, confidence FROM blocks WHERE x >= ? AND x <= ? AND z >= ? AND z <= ?',
    );
    this.stmtCount = this.db.prepare('SELECT COUNT(*) as cnt FROM blocks');
    this.stmtChunkCount = this.db.prepare(
      'SELECT COUNT(DISTINCT ((x >> 4) || \':\' || (z >> 4))) as cnt FROM blocks',
    );
    // FEAT-L1-05
    this.stmtDelete = this.db.prepare('DELETE FROM blocks WHERE x = ? AND y = ? AND z = ?');
    this.stmtDecay = this.db.prepare('UPDATE blocks SET confidence = ? WHERE x = ? AND y = ? AND z = ?');

    this.txnUpsertBatch = this.db.transaction((blocks: StoredBlock[]) => {
      for (const b of blocks) {
        this.stmtUpsert.run(
          b.x, b.y, b.z, b.blockName, b.boundingBox, b.properties ?? null, b.updatedAt, b.confidence ?? 1.0,
        );
      }
    });
  }

  private cacheKey(x: number, y: number, z: number): string {
    return `${x}:${y}:${z}`;
  }

  hasBlock(x: number, y: number, z: number): boolean {
    return this.knownBlocks.has(x, y, z);
  }

  getBlock(x: number, y: number, z: number): StoredBlock | null {
    const key = this.cacheKey(x, y, z);
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;

    const row = this.stmtGet.get(x, y, z) as {
      x: number; y: number; z: number;
      block_name: string; bounding_box: string;
      properties: string | null; updated_at: number;
      confidence: number | null;
    } | undefined;

    if (!row) {
      this.cache.set(key, null);
      return null;
    }

    const block: StoredBlock = {
      x: row.x, y: row.y, z: row.z,
      blockName: row.block_name,
      boundingBox: row.bounding_box,
      properties: row.properties ?? undefined,
      updatedAt: row.updated_at,
      confidence: row.confidence ?? 1.0,
    };
    this.cache.set(key, block);
    return block;
  }

  upsertBatch(blocks: StoredBlock[]): void {
    if (blocks.length === 0) return;
    this.txnUpsertBatch(blocks);
    // Update cache
    for (const b of blocks) {
      this.knownBlocks.add(b.x, b.y, b.z);
      this.cache.set(this.cacheKey(b.x, b.y, b.z), b);
    }
  }

  getRegion(minX: number, maxX: number, minZ: number, maxZ: number): StoredBlock[] {
    const rows = this.stmtRegion.all(minX, maxX, minZ, maxZ) as Array<{
      x: number; y: number; z: number;
      block_name: string; bounding_box: string;
      properties: string | null; updated_at: number;
      confidence: number | null;
    }>;
    return rows.map(row => ({
      x: row.x, y: row.y, z: row.z,
      blockName: row.block_name,
      boundingBox: row.bounding_box,
      properties: row.properties ?? undefined,
      updatedAt: row.updated_at,
      confidence: row.confidence ?? 1.0,
    }));
  }

  chunkHasData(chunkX: number, chunkZ: number): boolean {
    return this.stmtChunkHas.get(chunkX, chunkZ) !== undefined;
  }

  getStats(): WorldMapStats {
    const total = (this.stmtCount.get() as { cnt: number }).cnt;
    const chunks = (this.stmtChunkCount.get() as { cnt: number }).cnt;
    return { totalBlocks: total, chunksWithData: chunks };
  }

  // ── FEAT-L1-05 · 记忆过期纠错 ───────────────────────────────────────────

  decayConfidence(x: number, y: number, z: number, delta = 0.1): number | null {
    const cur = this.getBlock(x, y, z);
    if (!cur) return null;
    const next = Math.max(0, (cur.confidence ?? 1.0) - delta);
    if (next <= 0) {
      this.forgetBlock(x, y, z);
      return 0;
    }
    try {
      this.stmtDecay.run(next, x, y, z);
    } catch (err) {
      console.error('[WorldMapStore] decayConfidence failed:', err);
    }
    // 同步缓存
    this.cache.set(this.cacheKey(x, y, z), { ...cur, confidence: next });
    return next;
  }

  forgetBlock(x: number, y: number, z: number): void {
    let deleted = false;
    try {
      this.stmtDelete.run(x, y, z);
      deleted = true;
    } catch (err) {
      console.error('[WorldMapStore] forgetBlock failed:', err);
    }
    if (!deleted) return;
    this.knownBlocks.delete(x, y, z);
    this.cache.set(this.cacheKey(x, y, z), null);
  }

  updateBlock(block: StoredBlock): void {
    const confidence = block.confidence ?? 1.0;
    let updated = false;
    try {
      this.stmtUpsert.run(
        block.x, block.y, block.z,
        block.blockName, block.boundingBox,
        block.properties ?? null,
        block.updatedAt,
        confidence,
      );
      updated = true;
    } catch (err) {
      console.error('[WorldMapStore] updateBlock failed:', err);
    }
    if (!updated) return;
    this.knownBlocks.add(block.x, block.y, block.z);
    this.cache.set(this.cacheKey(block.x, block.y, block.z), { ...block, confidence });
  }

  close(): void {
    this.cache.clear();
    this.knownBlocks.clear();
    this.db.close();
  }
}
