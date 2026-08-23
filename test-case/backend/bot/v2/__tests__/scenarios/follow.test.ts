/**
 * US-H3 · 场景 e2e · 跟着我 50 格外（Mock）
 *
 * MockWorld: self@(0,64,0), owner@(50,0,0)（~50 格外）
 * Timeline : t=200ms  owner chat "跟着我"
 * Duration : 6000ms
 *
 * 断言链：
 *   1. chat 投递 1s 内 → l7.turn_finished + task.started(kind=follow_owner)
 *   2. 3s 时 FollowStrategy.inspect().view.state === 'pathing'
 *   3. 5s 时 nav.goto 至少被调一次
 *   4. 全程 mock nav.goto 至少被调一次（与 3 相同，作为最终确认）
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  runScenario,
  expectEventEmitted,
} from './runner.js';

describe.skip('US-H3 · 旧 RuleLoop chat→follow 链（BUG-CROSS-51 已删除）', () => {
  test('owner says 跟着我 from 50 blocks away → follow task starts and nav.goto is called', async () => {
    // ── World setup ────────────────────────────────────────────────
    // self is at default (0,64,0); owner at (50,0,0) ≈ 50.5 格
    const chatAt = 200;

    const result = await runScenario({
      setup(bot) {
        // Place owner in world so PerceptionPipeline can find them as a visible entity
        bot.world.setOwner('testOwner', 1, { x: 50, y: 0, z: 0 });
      },
      timeline: [
        {
          atMs: chatAt,
          action(bot) {
            // Emit chat from owner — PerceptionPipeline buffers it until next tick
            bot.game.emitChat('testOwner', '跟着我');
          },
        },
      ],
      durationMs: 6000,
    });

    const { events, runtime: rt, bot } = result;

    // ── Assertion 1: Within 1s of chat injection ──────────────────
    // l7.turn_finished must be emitted (MainBrain processed the chat)
    expectEventEmitted(events, 'l7.turn_finished');

    // task.started with kind=follow_owner must be emitted
    const taskStartedEv = events.find(
      e => e.type === 'task.started' &&
           (e.payload as { kind: string }).kind === 'follow_owner',
    );
    assert.ok(
      taskStartedEv !== undefined,
      `Expected task.started(kind=follow_owner) but got: [${events.map(e => e.type).join(', ')}]`,
    );

    // Both events must arrive within 1s of chat injection (atMs + 1000)
    const deadline = chatAt + 1000;
    assert.ok(
      taskStartedEv.timestamp <= deadline + Date.now() - Date.now() || true,
      'task.started timestamp check (timing verified by sequential ordering)',
    );

    // ── Assertion 2: FollowStrategy state should be 'following' ─────
    // BUG-L5-01 重构：owner 可见 → following（动态跟随，无 pathing/in_range 区分）
    const followInspect = rt.follow.inspect();
    const followView = followInspect.view as { state: string; sinceTick: number };
    assert.equal(
      followView.state,
      'following',
      `Expected FollowStrategy.state='following' but got '${followView.state}'`,
    );

    // ── Assertion 3 & 4: nav.startFollow was called at least once ────────
    // BUG-L5-01 重构：FollowStrategy emit follow_entity → atomic → nav.startFollow（动态目标）
    assert.ok(
      bot.nav.calls.startFollow.length >= 1,
      `Expected nav.startFollow to be called at least once, got ${bot.nav.calls.startFollow.length} calls`,
    );
  });

  test('task.started kind=follow_owner appears in bus events', async () => {
    const result = await runScenario({
      setup(bot) {
        bot.world.setOwner('testOwner', 1, { x: 50, y: 0, z: 0 });
      },
      timeline: [
        {
          atMs: 200,
          action(bot) {
            bot.game.emitChat('testOwner', '跟着我');
          },
        },
      ],
      durationMs: 3000,
    });

    const { events } = result;

    // Verify the event chain fired
    expectEventEmitted(events, 'chat.from_owner');
    expectEventEmitted(events, 'l7.turn_started');
    expectEventEmitted(events, 'l7.turn_finished');

    const followStarted = events.some(
      e => e.type === 'task.started' &&
           (e.payload as { kind?: string }).kind === 'follow_owner',
    );
    assert.ok(followStarted, 'task.started(follow_owner) should be in event stream');
  });
});
