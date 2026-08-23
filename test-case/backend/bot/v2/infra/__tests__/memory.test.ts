/**
 * MemoryV2 Unit Tests · US-G7 + US-DOC-MEM
 *
 * Framework: node:test + node:assert/strict
 * Uses ':memory:' path to keep SQLite in-memory (better-sqlite3 supports it).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MemoryV2 } from '../../../../../../apps/minecraft-companion/src/bot/v2/infra/memory.js';
import type { TaskSnapshot, SpatialEntry, EventEntry, TrajectoryEntry } from '../../../../../../apps/minecraft-companion/src/bot/v2/infra/memory.js';

// ── helpers ────────────────────────────────────────────────────────────────

function makeTask(overrides: Partial<TaskSnapshot> = {}): TaskSnapshot {
  const now = Date.now();
  return {
    taskId: 'task-001',
    kind: 'follow_owner',
    state: 'running',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeSpatial(overrides: Partial<SpatialEntry> = {}): SpatialEntry {
  return {
    kind: 'home',
    position: { x: 10, y: 64, z: -20 },
    timestamp: Date.now(),
    ...overrides,
  };
}

// ── tests ──────────────────────────────────────────────────────────────────

describe('MemoryV2', () => {

  // ① record('task', ...) + query('task') roundtrip
  test('① record task then query returns it', () => {
    const mem = new MemoryV2(':memory:');
    const snap = makeTask({ taskId: 'task-001', state: 'running' });
    mem.record('task', snap);

    const results = mem.query('task');
    assert.equal(results.length, 1);
    assert.equal(results[0].taskId, 'task-001');
    assert.equal(results[0].state, 'running');
    mem.close();
  });

  // ② scheduleCommit → NOT immediately visible in query / commitTick() → then visible
  test('② scheduleCommit defers visibility; commitTick() flushes it', () => {
    const mem = new MemoryV2(':memory:');
    const snap = makeTask({ taskId: 'task-pending', state: 'paused' });

    // Before commit: not visible (scheduleCommit does NOT call record immediately)
    mem.scheduleCommit('task', snap);
    const beforeCommit = mem.query('task', { id: 'task-pending' });
    assert.equal(beforeCommit.length, 0, 'should not be visible before commitTick');

    // After commit: visible
    const flushed = mem.commitTick();
    assert.equal(flushed, 1, 'commitTick should return count of flushed entries');
    const afterCommit = mem.query('task', { id: 'task-pending' });
    assert.equal(afterCommit.length, 1);
    assert.equal(afterCommit[0].state, 'paused');
    mem.close();
  });

  // ③ runtimeState set/get/clear isolated from task/spatial query
  test('③ runtimeState is isolated from persistent query', () => {
    const mem = new MemoryV2(':memory:');

    mem.setRuntime('currentTarget', { x: 5, y: 64, z: 5 });
    mem.setRuntime('tickPhase', 'attack');

    // Runtime reads
    assert.deepEqual(mem.getRuntime('currentTarget'), { x: 5, y: 64, z: 5 });
    assert.equal(mem.getRuntime('tickPhase'), 'attack');

    // Persistent task query unaffected
    assert.equal(mem.query('task').length, 0);

    // Clear runtime
    mem.clearRuntime();
    assert.equal(mem.getRuntime('tickPhase'), undefined);

    mem.close();
  });

  // ④ Multiple record types (task + spatial) don't interfere
  test('④ task and spatial records do not interfere with each other', () => {
    const mem = new MemoryV2(':memory:');

    const task = makeTask({ taskId: 'task-multi', kind: 'farm', state: 'pending' });
    const spatial = makeSpatial({ kind: 'home', position: { x: 100, y: 64, z: 200 } });

    mem.record('task', task);
    mem.record('spatial', spatial);

    const tasks = mem.query('task');
    const spatials = mem.query('spatial');

    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].taskId, 'task-multi');
    assert.equal(spatials.length, 1);
    assert.equal(spatials[0].kind, 'home');
    assert.equal(spatials[0].position.x, 100);

    // Task query returns no spatial entries
    assert.ok(tasks.every(t => 'taskId' in t), 'all task results have taskId');
    // Spatial query returns no task entries
    assert.ok(spatials.every(s => 'position' in s), 'all spatial results have position');

    mem.close();
  });

  // ⑤ query('task', {state:'paused'}) filters correctly
  test('⑤ query with state filter returns only matching tasks', () => {
    const mem = new MemoryV2(':memory:');
    const now = Date.now();

    mem.record('task', { taskId: 'a', kind: 'follow_owner', state: 'running', createdAt: now, updatedAt: now });
    mem.record('task', { taskId: 'b', kind: 'farm', state: 'paused', createdAt: now, updatedAt: now });
    mem.record('task', { taskId: 'c', kind: 'guard', state: 'paused', createdAt: now, updatedAt: now });
    mem.record('task', { taskId: 'd', kind: 'follow_owner', state: 'completed', createdAt: now, updatedAt: now });

    const paused = mem.query('task', { state: 'paused' });
    assert.equal(paused.length, 2);
    assert.ok(paused.every(t => t.state === 'paused'));

    const running = mem.query('task', { state: 'running' });
    assert.equal(running.length, 1);
    assert.equal(running[0].taskId, 'a');

    const completed = mem.query('task', { state: 'completed' });
    assert.equal(completed.length, 1);
    assert.equal(completed[0].taskId, 'd');

    mem.close();
  });

});

// ── TC-MEM-06 ~ TC-MEM-10 (US-DOC-MEM) ──────────────────────────────────────

describe('MemoryV2 · SQLite persistence & additional types', () => {

  // TC-MEM-06: restart recovery with real SQLite file
  test('TC-MEM-06: restart recovery - data survives new MemoryV2 instance', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mem-test-'));
    const dbPath = join(dir, 'test.db');
    try {
      const m1 = new MemoryV2(dbPath);
      const now = Date.now();
      m1.record('task', {
        taskId: 'persist-task',
        kind: 'follow_owner',
        state: 'running',
        createdAt: now,
        updatedAt: now,
      });
      // record() already writes to SQLite synchronously; commitTick is redundant but harmless
      m1.commitTick();
      m1.close();

      // New instance reads from disk
      const m2 = new MemoryV2(dbPath);
      const results = m2.query('task', { id: 'persist-task' });
      assert.equal(results.length, 1, 'task should be recovered from SQLite');
      assert.equal(results[0].state, 'running');
      assert.equal(results[0].taskId, 'persist-task');
      m2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // TC-MEM-07: events record + query
  test('TC-MEM-07: events record + query returns matching event', () => {
    const mem = new MemoryV2(':memory:');

    const ev: EventEntry = {
      id: 'ev-001',
      type: 'under_attack',
      level: 'critical',
      payload: { attacker: 'zombie' },
      timestamp: Date.now(),
    };
    mem.record('event', ev);

    const all = mem.query('event');
    assert.ok(all.length >= 1, 'at least one event should be present');
    assert.ok(
      all.some(e => e.type === 'under_attack'),
      'under_attack event should be in results',
    );

    // type filter
    const byType = mem.query('event', { type: 'under_attack' });
    assert.equal(byType.length, 1);
    assert.equal(byType[0].id, 'ev-001');

    // different type → empty
    const notFound = mem.query('event', { type: 'task.completed' });
    assert.equal(notFound.length, 0);

    mem.close();
  });

  // TC-MEM-08: spatial record + query with kind filter
  test('TC-MEM-08: spatial record + query - kind filter isolates correctly', () => {
    const mem = new MemoryV2(':memory:');

    mem.record('spatial', {
      kind: 'chest',
      position: { x: 10, y: 64, z: -20 },
      timestamp: Date.now(),
    });
    mem.record('spatial', {
      kind: 'home',
      position: { x: 0, y: 64, z: 0 },
      timestamp: Date.now(),
    });

    const chests = mem.query('spatial', { kind: 'chest' });
    assert.equal(chests.length, 1, 'should find exactly 1 chest');
    assert.equal(chests[0].position.x, 10);

    const homes = mem.query('spatial', { kind: 'home' });
    assert.equal(homes.length, 1);
    assert.equal(homes[0].position.x, 0);

    // kind that doesn't exist → empty
    const waypoints = mem.query('spatial', { kind: 'path_waypoint' });
    assert.equal(waypoints.length, 0);

    mem.close();
  });

  // TC-MEM-09: snapshot() returns correct statistics
  test('TC-MEM-09: snapshot() taskCount reflects recorded tasks', () => {
    const mem = new MemoryV2(':memory:');
    const now = Date.now();

    for (let i = 1; i <= 5; i++) {
      mem.record('task', {
        taskId: `snap-task-${i}`,
        kind: 'follow_owner',
        state: 'running',
        createdAt: now,
        updatedAt: now,
      });
    }

    const snap = mem.snapshot();
    assert.ok(snap.tasks.length >= 5, `expected >= 5 tasks, got ${snap.tasks.length}`);
    assert.equal(snap.dbConnected, true, 'SQLite should be connected');
    assert.equal(snap.pendingCount, 0, 'no pending after record()');

    mem.close();
  });

  // ── FEAT-MEM-05 · 位置轨迹时序表 ──────────────────────────────────

  test('FEAT-MEM-05 ①: record trajectory then query returns it', () => {
    const mem = new MemoryV2(':memory:');
    const now = Date.now();
    const t: TrajectoryEntry = {
      timestamp: now,
      x: 10, y: 64, z: -20,
      dimension: 'overworld',
      biome: 'plains',
    };
    mem.record('trajectory', t);
    const list = mem.query('trajectory');
    assert.equal(list.length, 1);
    assert.equal(list[0].x, 10);
    assert.equal(list[0].dimension, 'overworld');
    assert.equal(list[0].biome, 'plains');
    mem.close();
  });

  test('FEAT-MEM-05 ②: recallTrajectoryAt finds nearest point ≤ ts', () => {
    const mem = new MemoryV2(':memory:');
    const t0 = 1000_000;
    mem.record('trajectory', { timestamp: t0, x: 0, y: 64, z: 0, dimension: 'overworld' });
    mem.record('trajectory', { timestamp: t0 + 30_000, x: 5, y: 64, z: 0, dimension: 'overworld' });
    mem.record('trajectory', { timestamp: t0 + 60_000, x: 10, y: 64, z: 0, dimension: 'overworld' });

    // 查 t0+45s（在第二第三之间）→ 应返回第二个
    const found = mem.recallTrajectoryAt(t0 + 45_000);
    assert.ok(found, 'should find a point');
    assert.equal(found!.x, 5);

    // 查 t0 之前 → null
    const none = mem.recallTrajectoryAt(t0 - 100);
    assert.equal(none, null);
    mem.close();
  });

  test('FEAT-MEM-05 ③: query trajectory with sinceMs filter', () => {
    const mem = new MemoryV2(':memory:');
    const t0 = 2000_000;
    for (let i = 0; i < 5; i++) {
      mem.record('trajectory', {
        timestamp: t0 + i * 30_000,
        x: i, y: 64, z: 0,
        dimension: 'overworld',
      });
    }
    // 取最后 2 个
    const recent = mem.query('trajectory', { sinceMs: t0 + 90_000 });
    assert.equal(recent.length, 2);
    assert.equal(recent[0].x, 3);
    assert.equal(recent[1].x, 4);
    mem.close();
  });

  test('FEAT-MEM-05 ④: same-ts dedup prevents duplicates', () => {
    const mem = new MemoryV2(':memory:');
    const ts = 3_000_000;
    mem.record('trajectory', { timestamp: ts, x: 1, y: 64, z: 0, dimension: 'overworld' });
    mem.record('trajectory', { timestamp: ts, x: 1, y: 64, z: 0, dimension: 'overworld' });
    assert.equal(mem.query('trajectory').length, 1, 'dedup by ts');
    mem.close();
  });

  test('FEAT-MEM-05 ⑤: trajectory persists across restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mem-traj-'));
    const dbPath = join(dir, 'test.db');
    try {
      const m1 = new MemoryV2(dbPath);
      m1.record('trajectory', { timestamp: 4_000_000, x: 7, y: 64, z: 8, dimension: 'overworld', biome: 'forest' });
      m1.close();
      const m2 = new MemoryV2(dbPath);
      const list = m2.query('trajectory');
      assert.equal(list.length, 1);
      assert.equal(list[0].x, 7);
      assert.equal(list[0].biome, 'forest');
      m2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── FEAT-MEM-06 · 箱子内容索引 ──────────────────────────────────

  test('FEAT-MEM-06 ①: indexChest writes items into spatial.meta', () => {
    const mem = new MemoryV2(':memory:');
    mem.indexChest({ x: 100, y: 64, z: 50 }, ['oak_log', 'oak_planks', 'stick']);
    const chests = mem.query('spatial', { kind: 'chest' });
    assert.equal(chests.length, 1);
    const items = chests[0].meta?.items as string[];
    assert.deepEqual(items.sort(), ['oak_log', 'oak_planks', 'stick'].sort());
    mem.close();
  });

  test('FEAT-MEM-06 ②: findChestsWith returns chests containing target item', () => {
    const mem = new MemoryV2(':memory:');
    mem.indexChest({ x: 0, y: 64, z: 0 }, ['oak_log', 'stone']);
    mem.indexChest({ x: 10, y: 64, z: 0 }, ['cobblestone']);
    mem.indexChest({ x: 20, y: 64, z: 0 }, ['oak_log']);
    const withLog = mem.findChestsWith('oak_log');
    assert.equal(withLog.length, 2);
    const withStone = mem.findChestsWith('stone');
    assert.equal(withStone.length, 1);
    const withGold = mem.findChestsWith('gold_ingot');
    assert.equal(withGold.length, 0);
    mem.close();
  });

  test('FEAT-MEM-06 ③: indexChest merges with existing meta (preserves name)', () => {
    const mem = new MemoryV2(':memory:');
    // 先 record_place 风格记下 chest 带 name
    mem.record('spatial', {
      kind: 'chest',
      position: { x: 5, y: 64, z: 5 },
      meta: { name: '工具箱' },
      timestamp: Date.now(),
    });
    // 再 indexChest
    mem.indexChest({ x: 5, y: 64, z: 5 }, ['iron_pickaxe']);
    const chests = mem.query('spatial', { kind: 'chest' });
    assert.equal(chests.length, 1);
    assert.equal(chests[0].meta?.name, '工具箱');
    assert.deepEqual(chests[0].meta?.items, ['iron_pickaxe']);
    mem.close();
  });

  // TC-MEM-10: multi-type isolation - task vs spatial
  test('TC-MEM-10: multi-type isolation - task and spatial never mix', () => {
    const mem = new MemoryV2(':memory:');
    const now = Date.now();

    mem.record('task', {
      taskId: 'isolation-task',
      kind: 'farm',
      state: 'paused',
      createdAt: now,
      updatedAt: now,
    });
    mem.record('spatial', {
      kind: 'resource',
      position: { x: 50, y: 64, z: 50 },
      timestamp: now,
    });

    const tasks = mem.query('task');
    const spatials = mem.query('spatial');

    assert.equal(tasks.length, 1);
    assert.equal(spatials.length, 1);

    // task query must contain only TaskSnapshot entries (have taskId)
    assert.ok(tasks.every(t => 'taskId' in t), 'task results must have taskId');
    // spatial query must contain only SpatialEntry entries (have position)
    assert.ok(spatials.every(s => 'position' in s), 'spatial results must have position');

    // cross-check: taskId should NOT appear in spatial results
    const taskIds = tasks.map(t => t.taskId);
    const spatialHasTaskId = spatials.some(s => taskIds.includes((s as { taskId?: string }).taskId ?? ''));
    assert.equal(spatialHasTaskId, false, 'spatial results must not contain task entries');

    mem.close();
  });

});
