/**
 * Regression scenario for the single control-plane hazard migration.
 * Perception still reports damage, but neither Supervisor nor a generic fallback
 * can mint an emergency task or pause the task that currently owns execution.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expectEventEmitted, runScenario } from './runner.js';

const ZOMBIE_ID = 999;

describe('US-H4 · Follow under attack stays under one control plane', () => {
  let tmpDir: string;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'minefriend-h4-'));
  });

  after(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  test('under_attack is observable without pausing the active follow task', async () => {
    let followTaskId = '';
    const { events, runtime } = await runScenario({
      runtimeConfig: { dbPath: join(tmpDir, 'h4-control-plane.db') },
      setup(bot) {
        bot.world.setOwner('testOwner', 1, { x: 20, y: 64, z: 0 });
        bot.world.setHealth(20);
      },
      timeline: [
        {
          atMs: 0,
          action(_bot, rt) {
            const task = rt.tasks.createFollowOwnerTask({ ownerName: 'testOwner' });
            followTaskId = task.id;
            rt.tasks.pushToStack(task.id);
          },
        },
        {
          atMs: 300,
          action(bot) {
            bot.world.addEntity({
              entityId: ZOMBIE_ID,
              type: 'mob',
              category: 'hostile',
              name: 'zombie',
              position: { x: 6, y: 64, z: 0 },
              health: 20,
            });
          },
        },
        {
          atMs: 700,
          action(bot) {
            bot.game.emitHealthChange(14, 20);
          },
        },
      ],
      durationMs: 1800,
    });

    expectEventEmitted(events, 'under_attack');
    // Scenario teardown cancels every live task, so the terminal snapshot cannot
    // distinguish normal shutdown from a runtime pause. The event stream and
    // Supervisor state below are the stable control-plane evidence instead.
    assert.ok(followTaskId.length > 0);
    assert.equal('suspendedByDanger' in runtime.supervisor.inspect(), false);
    assert.equal(events.some(event => event.type === 'task.paused'), false);
    assert.equal(events.some(event => event.type === 'supervisor.task_suspended_by_danger'), false);
    assert.equal(events.some(event => event.type === 'supervisor.flee_from_danger'), false);
    assert.equal(events.some(event => {
      const kind = (event.payload as { kind?: string } | undefined)?.kind;
      return event.type === 'task.started' && (kind === 'survive' || kind === 'reflex_react');
    }), false);
  });

  test('damage perception remains independently observable', async () => {
    const { events } = await runScenario({
      runtimeConfig: { dbPath: join(tmpDir, 'h4-perception.db') },
      setup(bot) {
        bot.world.setOwner('testOwner', 1, { x: 5, y: 64, z: 0 });
        bot.world.setHealth(20);
      },
      timeline: [{ atMs: 200, action(bot) { bot.game.emitHealthChange(14, 20); } }],
      durationMs: 1000,
    });

    expectEventEmitted(events, 'under_attack');
  });
});
