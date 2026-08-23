/**
 * US-I2 · 持久化重启验证（集成测试）
 *
 * Phase 1: 启动 RuntimeA，注入 follow_owner 任务，commitTick 落盘，停止。
 * Phase 2: 用同一 dbPath 启动 RuntimeB，验证 supervisor.hydrated 事件触发
 *          且恢复了 Phase 1 中持久化的 running/paused 任务。
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { V2Runtime } from '../../../../../../apps/minecraft-companion/src/bot/v2/v2Runtime.js';
import { createMockBot } from '../mocks/index.js';
import type { BusEvent } from '../../../../../../apps/minecraft-companion/src/bot/v2/types.js';

describe('US-I2 · Persistence restart validation', () => {
  let tmpDir: string;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'minefriend-test-'));
  });

  after(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test('phase 1: follow task persists after shutdown; phase 2: hydrated on restart', async () => {
    const dbPath = join(tmpDir, 'test-memory.db');

    // ── Phase 1: Start RuntimeA, inject follow task, commit, stop ──
    {
      const bot = createMockBot();
      bot.world.setOwner('testOwner', 1, { x: 5, y: 64, z: 0 });

      const rtA = new V2Runtime({
        game: bot.game,
        nav: bot.nav,
        ownerName: 'testOwner',
        tickMs: 50,
        dbPath,
        worldMapDbPath: ':memory:',
        chatMemoryDbPath: ':memory:',
      });

      rtA.start();

      // Wait briefly for perception to warm up
      await new Promise(r => setTimeout(r, 150));

      // Inject follow_owner task directly (simulates what MainBrain does after "跟着我")
      const followTaskObj = rtA.tasks.createFollowOwnerTask({ ownerName: 'testOwner' });

      // Explicitly start the task (bypassing preflight, just push to stack like Supervisor would)
      rtA.tasks.pushToStack(followTaskObj.id);

      // Commit pending scheduleCommit calls (createFollowOwnerTask + pushToStack both call persist())
      rtA.memory.commitTick();

      // Verify task is now running
      const tasksA = rtA.tasks.list();
      const followTask = tasksA.find((t) => t.kind === 'follow_owner');
      assert.ok(followTask, 'Phase 1: Should have follow_owner task in TaskRuntime');
      assert.equal(followTask.state, 'running', 'Phase 1: follow_owner task should be running');

      // Pause the task to simulate interrupted state (this is what Supervisor does on shutdown)
      rtA.tasks.pause(followTask.id, { checkpoint: 'pre_restart' }, 'automatic');

      // Commit the paused state to SQLite
      rtA.memory.commitTick();

      rtA.stop();
      // Close DB connection to release the file lock before Phase 2 opens it
      rtA.memory.close();

      // Verify the DB file was created
      assert.ok(existsSync(dbPath), 'Phase 1: SQLite DB file should exist after shutdown');
    }

    // Brief pause between shutdown and restart
    await new Promise(r => setTimeout(r, 100));

    // ── Phase 2: Start RuntimeB with same dbPath, verify hydration ──
    {
      const bot2 = createMockBot();
      bot2.world.setOwner('testOwner', 1, { x: 5, y: 64, z: 0 });

      let hydratedEvent: BusEvent | null = null;
      const collectedEvents: BusEvent[] = [];

      const rtB = new V2Runtime({
        game: bot2.game,
        nav: bot2.nav,
        ownerName: 'testOwner',
        tickMs: 50,
        dbPath, // same DB → memory loaded from Phase 1
        worldMapDbPath: ':memory:',
        chatMemoryDbPath: ':memory:',
        onEvent: (ev) => {
          collectedEvents.push(ev);
          if (ev.type === 'supervisor.hydrated') {
            hydratedEvent = ev;
          }
        },
      });

      rtB.start(); // calls supervisor.hydrate() internally

      await new Promise(r => setTimeout(r, 300));

      rtB.stop();
      rtB.memory.close();

      // The supervisor.hydrated event must always fire on start (even with no paused tasks)
      assert.ok(hydratedEvent !== null, 'Phase 2: supervisor.hydrated event should be emitted on start');

      // Check restoredTaskIds — should include the follow task paused in Phase 1
      const payload = (hydratedEvent as BusEvent<{ restoredTaskIds: string[] }>).payload;
      assert.ok(
        Array.isArray(payload.restoredTaskIds),
        'Phase 2: hydrated payload should have restoredTaskIds array',
      );
      assert.ok(
        payload.restoredTaskIds.length >= 1,
        `Phase 2: expected at least 1 restored task, got ${payload.restoredTaskIds.length}`,
      );
    }
  });

  test('supervisor.hydrated fires even with empty DB (no paused tasks)', async () => {
    const emptyDbPath = join(tmpDir, 'empty-memory.db');

    const bot = createMockBot();
    bot.world.setOwner('testOwner', 2, { x: 0, y: 64, z: 0 });

    let hydratedFired = false;

    const rt = new V2Runtime({
      game: bot.game,
      nav: bot.nav,
      ownerName: 'testOwner',
      tickMs: 50,
      dbPath: emptyDbPath,
      worldMapDbPath: ':memory:',
      chatMemoryDbPath: ':memory:',
      onEvent: (ev) => {
        if (ev.type === 'supervisor.hydrated') {
          hydratedFired = true;
        }
      },
    });

    rt.start();
    await new Promise(r => setTimeout(r, 200));
    rt.stop();
    rt.memory.close();

    assert.ok(hydratedFired, 'supervisor.hydrated should fire even with empty DB');
  });
});
