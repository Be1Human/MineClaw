/**
 * US-H4 · Scene e2e: 跟着我 + 苦力怕来袭 + 自动恢复
 *
 * Timeline:
 *   t=0      Inject follow_owner task directly (deterministic, bypasses LLM path)
 *   t=100ms  chat from owner "跟着我" → chat.from_owner event
 *   t=2000ms spawn creeper (id=999) 8 blocks away
 *   t=2500ms health drop 20→14 → under_attack via PerceptionPipeline on next tick
 *   t=2800ms publish atomic.attack on bus → tryClearDanger called in 300ms
 *   t=3500ms remove creeper → tryClearDanger sees no hostile → danger_cleared
 *
 * Note on event ordering (synchronous EventBus dispatch):
 *   When bus.publish('under_attack') fires, the Supervisor's level-handler runs
 *   synchronously and publishes task.paused + supervisor.task_suspended_by_danger
 *   BEFORE the under_attack event's global handler (collectedEvents.push) runs.
 *   So in collectedEvents: [...task.paused, supervisor.task_suspended_by_danger, under_attack].
 *   We assert all events are PRESENT — not their relative order within the same tick.
 *
 * Each test uses its own temp SQLite DB to avoid SQLITE_BUSY contention.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runScenario, expectEventEmitted } from './runner.js';

const CREEPER_ID = 999;

describe('US-H4 · Follow + Creeper attack + Auto recovery', () => {
  let tmpDir: string;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'minefriend-h4-'));
  });

  after(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test('full attack chain: follow → under_attack → suspended → danger_cleared', async () => {
    const dbPath = join(tmpDir, 'h4-main.db');

    const { events, runtime, bot } = await runScenario({
      runtimeConfig: { dbPath },
      setup(b) {
        // Owner visible 20 blocks away so FollowStrategy keeps calling nav.goto
        b.world.setOwner('testOwner', 1, { x: 20, y: 64, z: 0 });
        // Explicitly set health to 20 so PerceptionPipeline prev.health starts at 20
        b.world.setHealth(20);
      },

      timeline: [
        // t=0: inject follow_owner task directly so it's running before the attack
        {
          atMs: 0,
          action(_b, rt) {
            const task = rt.tasks.createFollowOwnerTask({ ownerName: 'testOwner' });
            rt.tasks.pushToStack(task.id);
          },
        },

        // t=100: owner chat → chat.from_owner via PerceptionPipeline next tick
        {
          atMs: 100,
          action(b) {
            b.game.emitChat('testOwner', '跟着我');
          },
        },

        // t=2000: spawn creeper 8 blocks away
        {
          atMs: 2000,
          action(b) {
            b.world.addEntity({
              entityId: CREEPER_ID,
              type: 'mob',
              category: 'hostile',
              name: 'creeper',
              position: { x: 8, y: 64, z: 0 },
              health: 20,
            });
          },
        },

        // t=2500: health drop → PerceptionPipeline detects on next perceive tick → under_attack
        {
          atMs: 2500,
          action(b) {
            b.game.emitHealthChange(14, 20);
          },
        },

        // t=3500: kill the creeper first, then publish atomic.attack
        // tryClearDanger runs 300ms later (t≈3800ms) with no creeper in world → danger_cleared
        {
          atMs: 3500,
          action(b) {
            b.world.removeEntity(CREEPER_ID);
          },
        },

        // t=3600: publish atomic.attack → tryClearDanger fires at t≈3900ms (before scenario end)
        {
          atMs: 3600,
          action(_b, rt) {
            rt.bus.publish('atomic.attack', 'info', { entityId: CREEPER_ID, success: true });
          },
        },
      ],

      durationMs: 5000,
    });

    const eventTypes = events.map(e => e.type);

    // ── Assertion 1a: chat.from_owner ────────────────────────────────
    expectEventEmitted(events, 'chat.from_owner');

    // ── Assertion 1b: follow task was started ─────────────────────────
    const taskStartedEv = events.find(
      e => e.type === 'task.started' &&
           (e.payload as { kind?: string }).kind === 'follow_owner',
    );
    assert.ok(
      taskStartedEv != null,
      `Expected task.started(kind=follow_owner) but got: [${eventTypes.join(', ')}]`,
    );

    // ── Assertion 1c: under_attack ────────────────────────────────────
    expectEventEmitted(events, 'under_attack');

    // ── Assertion 1d: Supervisor suspended the task ───────────────────
    const suspendedEvent = events.find(
      e =>
        e.type === 'supervisor.task_suspended_by_danger' ||
        e.type === 'supervisor.suspended',
    );
    assert.ok(
      suspendedEvent != null,
      `Expected supervisor suspension event in events.\nGot: [${eventTypes.join(', ')}]`,
    );

    // ── Assertion 1e: ordering — task.started before suspension ───────
    // Note: under_attack and supervisor.task_suspended_by_danger occur in the same
    // synchronous publish chain (supervisor reacts during dispatch of under_attack),
    // so we only check task.started < suspension event.
    const idxTaskStarted = eventTypes.indexOf('task.started');
    const idxSuspended = eventTypes.indexOf(suspendedEvent.type);
    assert.ok(
      idxTaskStarted < idxSuspended,
      `task.started (idx=${idxTaskStarted}) should come before ${suspendedEvent.type} (idx=${idxSuspended})`,
    );

    // ── Assertion 2: danger_cleared was emitted ───────────────────────
    const hasDangerCleared = events.some(e => e.type === 'danger_cleared');
    assert.ok(
      hasDangerCleared,
      `Expected 'danger_cleared' to be emitted.\nGot: [${eventTypes.join(', ')}]`,
    );

    // ── Assertion 3: suspendedByDanger is empty at end of scenario ────
    const inspect = runtime.supervisor.inspect();
    assert.deepEqual(
      inspect.suspendedByDanger,
      [],
      `Expected suspendedByDanger to be empty at end but got: ${JSON.stringify(inspect.suspendedByDanger)}`,
    );

    // ── Assertion 4: nav.goto was called at least once ────────────────
    assert.ok(
      bot.nav.calls.goto.length >= 1,
      `Expected nav.goto called at least once, got ${bot.nav.calls.goto.length} calls`,
    );
  });

  test('under_attack event emitted when health drops (isolated)', async () => {
    const dbPath = join(tmpDir, 'h4-isolated.db');

    const { events } = await runScenario({
      runtimeConfig: { dbPath },
      setup(b) {
        b.world.setOwner('testOwner', 1, { x: 5, y: 64, z: 0 });
        b.world.setHealth(20);
      },

      timeline: [
        // t=200ms: allow perception to tick once at health=20, then drop
        {
          atMs: 200,
          action(b) {
            b.game.emitHealthChange(14, 20);
          },
        },
      ],

      durationMs: 1000,
    });

    expectEventEmitted(events, 'under_attack');
  });

  test('supervisor suspends task on under_attack and resumes after danger_cleared', async () => {
    const dbPath = join(tmpDir, 'h4-supervisor.db');

    const { events, runtime } = await runScenario({
      runtimeConfig: { dbPath },
      setup(b) {
        b.world.setOwner('testOwner', 1, { x: 5, y: 64, z: 0 });
        b.world.setHealth(20);
      },

      timeline: [
        // Inject follow task so supervisor has something to suspend
        {
          atMs: 0,
          action(_b, rt) {
            const task = rt.tasks.createFollowOwnerTask({ ownerName: 'testOwner' });
            rt.tasks.pushToStack(task.id);
          },
        },
        // Spawn creeper
        {
          atMs: 300,
          action(b) {
            b.world.addEntity({
              entityId: CREEPER_ID,
              type: 'mob',
              category: 'hostile',
              name: 'creeper',
              position: { x: 6, y: 64, z: 0 },
              health: 20,
            });
          },
        },
        // Health drop → under_attack → supervisor suspends task
        {
          atMs: 700,
          action(b) {
            b.game.emitHealthChange(14, 20);
          },
        },
        // Simulate reflex attack → supervisor.tryClearDanger called in 300ms
        {
          atMs: 1000,
          action(_b, rt) {
            rt.bus.publish('atomic.attack', 'info', { entityId: CREEPER_ID, success: true });
          },
        },
        // Remove creeper — tryClearDanger (at t≈1300ms) sees no hostile → danger_cleared
        {
          atMs: 1200,
          action(b) {
            b.world.removeEntity(CREEPER_ID);
          },
        },
      ],

      durationMs: 2500,
    });

    const eventTypes = events.map(e => e.type);

    // (1) under_attack is detectable
    assert.ok(
      events.some(e => e.type === 'under_attack'),
      `Expected under_attack. Got: [${eventTypes.join(', ')}]`,
    );

    // (2) Supervisor reacts
    assert.ok(
      events.some(
        e =>
          e.type === 'supervisor.task_suspended_by_danger' ||
          e.type === 'supervisor.suspended',
      ),
      `Expected supervisor suspension event. Got: [${eventTypes.join(', ')}]`,
    );

    // (3) danger_cleared fires when threat is removed
    assert.ok(
      events.some(e => e.type === 'danger_cleared'),
      `Expected danger_cleared after creeper removed. Got: [${eventTypes.join(', ')}]`,
    );

    // suspendedByDanger must be empty at end
    const inspect = runtime.supervisor.inspect();
    assert.deepEqual(
      inspect.suspendedByDanger,
      [],
      `Expected suspendedByDanger empty at end, got: ${JSON.stringify(inspect.suspendedByDanger)}`,
    );
  });

});
