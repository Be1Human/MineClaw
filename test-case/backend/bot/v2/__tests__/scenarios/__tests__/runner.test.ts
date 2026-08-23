import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { runScenario, expectEventEmitted } from '../runner.js';

describe('ScenarioRunner · smoke test', () => {
  test('empty scenario runs without error', async () => {
    const result = await runScenario({ durationMs: 300 });
    assert.ok(Array.isArray(result.events));
    assert.ok(result.events.length > 0, 'should have heartbeat events');
    assert.ok(result.runtime !== null);
  });

  test('timeline action fires at correct time', async () => {
    let fired = false;
    const result = await runScenario({
      durationMs: 500,
      timeline: [
        {
          atMs: 100,
          action: () => { fired = true; },
        },
      ],
    });
    assert.ok(fired, 'timeline action should have fired');
    // heartbeat.tick_done should be emitted
    expectEventEmitted(result.events, 'heartbeat.tick_done');
  });

  test('chat injection via MockGameAdapter emitChat', async () => {
    const result = await runScenario({
      setup: (bot) => {
        bot.world.setOwner('testOwner', 100, { x: 0, y: 64, z: 5 });
      },
      durationMs: 400,
      timeline: [
        {
          atMs: 100,
          action: (bot) => {
            bot.game.emitChat('testOwner', 'hello world');
          },
        },
      ],
    });
    // chat.from_owner should be emitted when owner sends chat
    expectEventEmitted(result.events, 'chat.from_owner');
  });
});
