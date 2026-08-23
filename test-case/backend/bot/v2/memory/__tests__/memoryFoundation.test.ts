import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BotMemoryStore } from '../../../../../../apps/minecraft-companion/src/bot/v2/infra/botMemory.js';
import { openSqliteDatabase } from '../../../../../../apps/minecraft-companion/src/bot/v2/infra/sqliteDatabase.js';
import {
  ArrayMemorySourceAdapter,
  BotMemorySourceAdapter,
  ChatMemorySourceAdapter,
  MemoryBackfill,
  MemoryCatalog,
  MemoryRegistry,
  MemoryV2SourceAdapter,
  PlannerEpisodeSourceAdapter,
  canonicalMemoryId,
  type MemoryRecord,
} from '../../../../../../apps/minecraft-companion/src/bot/v2/memory/index.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('unified memory foundation', () => {
  test('canonical ID is stable and registry rejects accidental replacement', () => {
    assert.equal(
      canonicalMemoryId('profile-a', 'chat-memory', 'message:1'),
      canonicalMemoryId('profile-a', 'chat-memory', 'message:1'),
    );
    assert.notEqual(
      canonicalMemoryId('profile-a', 'chat-memory', 'message:1'),
      canonicalMemoryId('profile-b', 'chat-memory', 'message:1'),
    );

    const adapter = new ArrayMemorySourceAdapter('fixture', () => []);
    const registry = new MemoryRegistry().registerSource(adapter);
    assert.equal(registry.source('fixture'), adapter);
    assert.throws(() => registry.registerSource(adapter), /duplicate source/);
    assert.throws(() => registry.source('missing'), /unknown source/);
  });

  test('shadow backfill resumes from watermark, is idempotent, and rebuilds from authority', async () => {
    const dir = tempDir();
    const records = [1, 2, 3].map(index => fixtureRecord('profile-a', index));
    const adapter = new ArrayMemorySourceAdapter('fixture', profileId =>
      records.filter(record => record.profileId === profileId),
    );
    const registry = new MemoryRegistry().registerSource(adapter);
    const catalog = new MemoryCatalog(join(dir, 'catalog.db'));
    const backfill = new MemoryBackfill(catalog, registry);

    const interrupted = await backfill.run({ profileId: 'profile-a', batchSize: 1, maxBatchesPerSource: 1 });
    assert.equal(interrupted.sources[0]?.watermark.completed, false);
    assert.equal(interrupted.sources[0]?.watermark.scanned, 1);
    assert.equal(catalog.count('profile-a'), 1);

    const resumed = await backfill.run({ profileId: 'profile-a', batchSize: 1 });
    assert.equal(resumed.externalLlmRequests, 0);
    assert.equal(resumed.sources[0]?.watermark.completed, true);
    assert.equal(resumed.sources[0]?.watermark.sourceCount, 3);
    assert.equal(resumed.sources[0]?.watermark.indexed, 3);
    assert.equal(resumed.sources[0]?.reconciled, true);
    assert.equal(catalog.count('profile-a'), 3);

    const repeated = await backfill.run({ profileId: 'profile-a', batchSize: 2 });
    assert.equal(repeated.sources[0]?.batches, 0);
    assert.equal(repeated.sources[0]?.scannedThisRun, 0);
    assert.equal(catalog.count('profile-a'), 3);

    catalog.resetProfile('profile-a');
    assert.equal(catalog.count('profile-a'), 0);
    const rebuilt = await backfill.run({ profileId: 'profile-a', batchSize: 2 });
    assert.equal(rebuilt.sources[0]?.reconciled, true);
    assert.deepEqual(catalog.query({ profileId: 'profile-a' }).map(item => item.id).sort(), records.map(item => item.id).sort());
    catalog.close();
  });

  test('four authority adapters reconcile without mutating source stores or leaking profiles', async () => {
    const dir = tempDir();
    const chatPath = join(dir, 'chat.db');
    const memoryPath = join(dir, 'memory-v2.db');
    const plannerPath = join(dir, 'planner.db');
    seedChatDb(chatPath);
    seedMemoryV2Db(memoryPath);
    seedPlannerDb(plannerPath);

    const botStore = new BotMemoryStore({ dir: join(dir, 'markdown') }, () => undefined);
    botStore.append('主人偏好简洁回复', 'user');
    botStore.append('上次在村庄遇到僵尸', 'memory');

    const registry = new MemoryRegistry()
      .registerSource(new ChatMemorySourceAdapter(chatPath))
      .registerSource(new MemoryV2SourceAdapter(memoryPath))
      .registerSource(new PlannerEpisodeSourceAdapter(plannerPath))
      .registerSource(new BotMemorySourceAdapter(botStore));
    const catalog = new MemoryCatalog(join(dir, 'catalog.db'));
    const report = await new MemoryBackfill(catalog, registry).run({ profileId: 'profile-a', batchSize: 2 });

    assert.equal(report.externalLlmRequests, 0);
    assert.equal(report.sources.length, 4);
    assert.equal(report.sources.every(item => item.reconciled), true);
    assert.deepEqual(
      Object.fromEntries(report.sources.map(item => [item.adapterId, item.watermark.sourceCount])),
      { 'chat-memory': 3, 'memory-v2': 1, 'planner-episode-ledger': 1, 'bot-memory': 2 },
    );
    assert.equal(catalog.count('profile-a'), 7);
    assert.equal(catalog.count('profile-b'), 0);
    assert.equal(catalog.query({ profileId: 'profile-a' }).every(item => item.sourceRefs.length > 0), true);

    // Authority rows remain present and unchanged after the read-only shadow scan.
    assert.equal(countRows(chatPath, 'chat_messages'), 1);
    assert.equal(countRows(memoryPath, 'conversations'), 1);
    assert.equal(countRows(plannerPath, 'planner_execution_facts'), 1);
    assert.deepEqual(botStore.read('user'), ['主人偏好简洁回复']);
    catalog.close();
  });
});

function fixtureRecord(profileId: string, index: number): MemoryRecord {
  const sourceId = `row:${index}`;
  return {
    id: canonicalMemoryId(profileId, 'fixture', sourceId),
    profileId,
    kind: 'conversation',
    status: 'active',
    summary: `memory ${index}`,
    occurredAt: index,
    createdAt: index,
    updatedAt: index,
    importance: 0.5,
    confidence: 1,
    entities: [],
    locationRefs: [],
    sourceRefs: [{ store: 'fixture', id: sourceId }],
    evidenceRefs: [],
    metadata: {},
  };
}

function seedChatDb(path: string): void {
  const db = openSqliteDatabase(path);
  db.exec(`
    CREATE TABLE chat_messages (id TEXT PRIMARY KEY,profile_id TEXT,session_id TEXT,role TEXT,content TEXT,ts INTEGER);
    CREATE TABLE memory_facts (id TEXT PRIMARY KEY,profile_id TEXT,scope TEXT,kind TEXT,text TEXT,status TEXT,confidence REAL,importance REAL,source_ids_json TEXT,supersedes_id TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE conversation_summaries (id TEXT PRIMARY KEY,profile_id TEXT,session_id TEXT,covered_ids_json TEXT,summary TEXT,open_loops_json TEXT,commitments_json TEXT,created_at INTEGER);
  `);
  db.prepare('INSERT INTO chat_messages VALUES (?,?,?,?,?,?)').run('m1', 'profile-a', 's1', 'owner', '我喜欢蓝色', 10);
  db.prepare('INSERT INTO memory_facts VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
    .run('f1', 'profile-a', 'user', 'preference', '主人喜欢蓝色', 'active', 1, 0.8, '["m1"]', null, 10, 11);
  db.prepare('INSERT INTO conversation_summaries VALUES (?,?,?,?,?,?,?,?)')
    .run('s1', 'profile-a', 's1', '["m1"]', '主人表达了颜色偏好', '[]', '[]', 12);
  db.close();
}

function seedMemoryV2Db(path: string): void {
  const db = openSqliteDatabase(path);
  db.exec('CREATE TABLE conversations (id TEXT PRIMARY KEY,turn_id TEXT,role TEXT,content TEXT,tool_calls_json TEXT,source TEXT,is_pending INTEGER,task_context TEXT,ts INTEGER)');
  db.prepare('INSERT INTO conversations VALUES (?,?,?,?,?,?,?,?,?)')
    .run('c1', 'turn-1', 'owner', '十天前聊过的事', null, 'web_ui', 0, null, 20);
  db.close();
}

function seedPlannerDb(path: string): void {
  const db = openSqliteDatabase(path);
  db.exec(`
    CREATE TABLE planner_episode_sessions (session_id TEXT PRIMARY KEY,run_id TEXT,plan_run_id TEXT,plan_revision INTEGER,node_id TEXT,state TEXT,first_sequence INTEGER,last_contiguous_sequence INTEGER,max_sequence INTEGER,terminal_sequence INTEGER,terminal_event_id TEXT,outcome TEXT,updated_at TEXT);
    CREATE TABLE planner_execution_facts (event_id TEXT PRIMARY KEY,session_id TEXT,sequence INTEGER,event_type TEXT,occurred_at TEXT);
  `);
  db.prepare('INSERT INTO planner_episode_sessions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run('session-1', 'run-1', 'plan-1', 1, 'node-1', 'finalized', 1, 1, 1, 1, 'event-1', 'succeeded', '2026-08-02T00:00:01.000Z');
  db.prepare('INSERT INTO planner_execution_facts VALUES (?,?,?,?,?)')
    .run('event-1', 'session-1', 1, 'execution.session.terminal', '2026-08-02T00:00:00.000Z');
  db.close();
}

function countRows(path: string, table: string): number {
  const db = openSqliteDatabase(path, { readonly: true, fileMustExist: true });
  try { return (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count; }
  finally { db.close(); }
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'unified-memory-'));
  tempDirs.push(dir);
  return dir;
}
