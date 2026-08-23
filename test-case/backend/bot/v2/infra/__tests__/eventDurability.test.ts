import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { NON_DURABLE_EVENT_TYPES, isDurableEventType } from '../../../../../../apps/minecraft-companion/src/bot/v2/infra/eventDurability.js';
import { MemoryV2 } from '../../../../../../apps/minecraft-companion/src/bot/v2/infra/memory.js';

test('BUG-CROSS-36 · 高频 Heartbeat telemetry 非耐久，业务事件保持耐久', () => {
  for (const type of NON_DURABLE_EVENT_TYPES) assert.equal(isDurableEventType(type), false, type);
  for (const type of ['chat.from_owner', 'task.completed', 'l7.tool_call', 'exec.fail']) {
    assert.equal(isDurableEventType(type), true, type);
  }
});

test('BUG-CROSS-36 · 既有事件迁移只清理精确瞬时类型且幂等', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mineclaw-event-durability-'));
  const dbPath = join(dir, 'memory.db');
  try {
    const memory = new MemoryV2(dbPath);
    const now = Date.now();
    memory.record('event', { id: 'tick', type: 'heartbeat.tick_done', level: 'info', timestamp: now });
    memory.record('event', { id: 'commit', type: 'memory.commit', level: 'info', timestamp: now + 1 });
    memory.record('event', { id: 'business', type: 'task.completed', level: 'info', timestamp: now + 2 });

    assert.equal(memory.pruneEventsByType(NON_DURABLE_EVENT_TYPES), 2);
    assert.equal(memory.pruneEventsByType(NON_DURABLE_EVENT_TYPES), 0);
    assert.deepEqual(memory.query('event').map(event => event.type), ['task.completed']);
    memory.close();

    const db = new Database(dbPath, { readonly: true });
    try {
      assert.deepEqual(db.prepare('SELECT type FROM events ORDER BY ts').all(), [{ type: 'task.completed' }]);
    } finally { db.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
