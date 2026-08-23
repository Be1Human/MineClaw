/**
 * NavFailureFeedback · 单元测试（FEAT-L5-01）
 *
 * 覆盖测试用例文档（寻路失败感知反馈）T1~T8。
 * T9 是冒烟实跑，不在单测范畴。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { EventBusV2 } from '../../../../../../apps/minecraft-companion/src/bot/v2/infra/eventBus.js';
import { NavFailureFeedback } from '../../../../../../apps/minecraft-companion/src/bot/v2/strategy/navFailureFeedback.js';
import type { GameAdapter } from '../../../../../../apps/minecraft-companion/src/bot/adapter/GameAdapter.js';

// 最小 game mock：只实现 chat（其他方法不会被调用）
function makeMockGame(bus?: EventBusV2): { game: GameAdapter; chatCalls: string[] } {
  const chatCalls: string[] = [];
  bus?.on('brain.notice', ev => {
    const detail = (ev.payload as { detail?: string }).detail;
    if (detail) chatCalls.push(detail);
  });
  const game = {
    username: 'mock',
    chat: () => { throw new Error('NavFailureFeedback must not call game.chat'); },
  } as unknown as GameAdapter;
  return { game, chatCalls };
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

describe('NavFailureFeedback · FEAT-L5-01', () => {

  // T1 · noPath → "过不去"
  it('T1 · reason=noPath → game.chat 一次 · 消息含"过不去"', () => {
    const bus = new EventBusV2();
    const { game, chatCalls } = makeMockGame(bus);
    const fb = new NavFailureFeedback(bus, game);
    fb.start();
    bus.publish('atomic.move_to.end', 'info', { ok: false, reason: 'noPath' });
    assert.equal(chatCalls.length, 1);
    assert.ok(chatCalls[0].includes('过不去'), `chat="${chatCalls[0]}"`);
  });

  // T2 · door 相关失败 → "门"
  it('T2 · reason 含 "door" → 消息含"门"', () => {
    const bus = new EventBusV2();
    const { game, chatCalls } = makeMockGame(bus);
    const fb = new NavFailureFeedback(bus, game);
    fb.start();
    bus.publish('atomic.move_to.end', 'info', { ok: false, reason: 'door_blocked' });
    assert.equal(chatCalls.length, 1);
    assert.ok(chatCalls[0].includes('门'), `chat="${chatCalls[0]}"`);
  });

  // T3 · timeout 只陈述超时，不臆测“太远”
  it('T3 · reason=timeout → 消息含"超时"且不含"太远"', () => {
    const bus = new EventBusV2();
    const { game, chatCalls } = makeMockGame(bus);
    const fb = new NavFailureFeedback(bus, game);
    fb.start();
    bus.publish('atomic.move_to.end', 'info', { ok: false, reason: 'nav_timeout' });
    assert.equal(chatCalls.length, 1);
    assert.ok(chatCalls[0].includes('超时'), `chat="${chatCalls[0]}"`);
    assert.ok(!chatCalls[0].includes('太远'), `chat="${chatCalls[0]}"`);
  });

  // T4 · cancelled 静默
  it('T4 · reason=cancelled → 不发 chat', () => {
    const bus = new EventBusV2();
    const { game, chatCalls } = makeMockGame(bus);
    const fb = new NavFailureFeedback(bus, game);
    fb.start();
    bus.publish('atomic.move_to.end', 'info', { ok: false, reason: 'cancelled' });
    assert.equal(chatCalls.length, 0);
  });

  it('T4b · reason=preempted/motor_busy → 控制流终止保持静默', () => {
    const bus = new EventBusV2();
    const { game, chatCalls } = makeMockGame(bus);
    const fb = new NavFailureFeedback(bus, game);
    fb.start();
    bus.publish('atomic.move_to.end', 'info', { ok: false, reason: 'preempted' });
    bus.publish('atomic.move_to.end', 'info', { ok: false, reason: 'motor_busy' });
    assert.equal(chatCalls.length, 0);
  });

  // T5 · ok=true 不触发
  it('T5 · ok=true → 不发 chat', () => {
    const bus = new EventBusV2();
    const { game, chatCalls } = makeMockGame(bus);
    const fb = new NavFailureFeedback(bus, game);
    fb.start();
    bus.publish('atomic.move_to.end', 'info', { ok: true });
    assert.equal(chatCalls.length, 0);
  });

  // T6 · 同类失败 30s 冷却内只说一次
  it('T6 · 连续 3 次同类失败 → 只 chat 1 次（默认 30s 冷却）', () => {
    const bus = new EventBusV2();
    const { game, chatCalls } = makeMockGame(bus);
    const fb = new NavFailureFeedback(bus, game);
    fb.start();
    for (let i = 0; i < 3; i++) {
      bus.publish('atomic.move_to.end', 'info', { ok: false, reason: 'noPath' });
    }
    assert.equal(chatCalls.length, 1);
  });

  // T7 · 冷却过期后可再次触发
  it('T7 · cooldown=100ms · 等 150ms 后再触发 → chat 调用 2 次', async () => {
    const bus = new EventBusV2();
    const { game, chatCalls } = makeMockGame(bus);
    const fb = new NavFailureFeedback(bus, game, { cooldownMs: 100 });
    fb.start();
    bus.publish('atomic.move_to.end', 'info', { ok: false, reason: 'noPath' });
    await sleep(150);
    bus.publish('atomic.move_to.end', 'info', { ok: false, reason: 'noPath' });
    assert.equal(chatCalls.length, 2);
  });

  // T8 · stop() 后不再触发
  it('T8 · stop() 后再发事件 → 不再 chat', () => {
    const bus = new EventBusV2();
    const { game, chatCalls } = makeMockGame(bus);
    const fb = new NavFailureFeedback(bus, game);
    fb.start();
    fb.stop();
    bus.publish('atomic.move_to.end', 'info', { ok: false, reason: 'noPath' });
    assert.equal(chatCalls.length, 0);
  });

  // 补充：follow.end 也应触发
  it('额外 · atomic.follow.end 失败 → 同样触发 chat', () => {
    const bus = new EventBusV2();
    const { game, chatCalls } = makeMockGame(bus);
    const fb = new NavFailureFeedback(bus, game);
    fb.start();
    bus.publish('atomic.follow.end', 'info', { ok: false, reason: 'unreachable' });
    assert.equal(chatCalls.length, 1);
    assert.ok(chatCalls[0].includes('过不去'), `chat="${chatCalls[0]}"`);
  });

  it('错误映射 · 卡死保留卡死语义，不误报目标过远', () => {
    const bus = new EventBusV2();
    const { game, chatCalls } = makeMockGame(bus);
    const fb = new NavFailureFeedback(bus, game);
    fb.start();
    bus.publish('atomic.move_to.end', 'info', { ok: false, reason: 'stall_no_progress' });
    assert.equal(chatCalls.length, 1);
    assert.ok(chatCalls[0].includes('卡住'), `chat="${chatCalls[0]}"`);
    assert.ok(!chatCalls[0].includes('太远'), `chat="${chatCalls[0]}"`);
  });
});
