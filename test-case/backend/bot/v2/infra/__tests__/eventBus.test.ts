/**
 * EventBusV2 单元测试 · US-G6
 *
 * 6 个用例覆盖：
 *   ① publish → 事件立即出现在 drain 队列
 *   ② drain  → 返回全部 pending 事件，随后清空
 *   ③ onLevel → 只收到对应 level 的事件
 *   ④ onAny  → 收到所有事件，不区分 level
 *   ⑤ unsubscribe（on 返回的函数）→ 退订后不再收到
 *   ⑥ handler 抛异常 → 不影响其他 handler 执行
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { EventBusV2 } from '../../../../../../apps/minecraft-companion/src/bot/v2/infra/eventBus.js';

describe('EventBusV2', () => {
  // ① publish → 事件立即出现在 drain 队列
  it('① publish → 事件立即出现在 drain 结果', () => {
    const bus = new EventBusV2();
    bus.publish('test.event', 'info', { value: 42 });
    const events = bus.drain();
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'test.event');
    assert.equal(events[0].level, 'info');
    assert.deepEqual(events[0].payload, { value: 42 });
  });

  // ② drain → 返回全部 pending 事件，随后清空
  it('② drain → 返回全部事件后清空队列', () => {
    const bus = new EventBusV2();
    bus.publish('ev.a', 'info', 1);
    bus.publish('ev.b', 'critical', 2);
    bus.publish('ev.c', 'recoverable', 3);

    const first = bus.drain();
    assert.equal(first.length, 3);

    // 再次 drain → 空
    const second = bus.drain();
    assert.equal(second.length, 0);
  });

  // ③ onLevel → 只收到对应 level 的事件
  it('③ onLevel → 只收对应 level 的事件', () => {
    const bus = new EventBusV2();
    const received: string[] = [];

    bus.onLevel('critical', ev => received.push(ev.type));

    bus.publish('info.event', 'info', null);
    bus.publish('crit.event', 'critical', null);
    bus.publish('recovery.event', 'recoverable', null);
    bus.publish('another.crit', 'critical', null);

    assert.deepEqual(received, ['crit.event', 'another.crit']);
  });

  // ④ onAny → 收到所有事件，不区分 level
  it('④ onAny → 收到所有事件不限 level', () => {
    const bus = new EventBusV2();
    const received: string[] = [];

    bus.onAny(ev => received.push(ev.type));

    bus.publish('ev.critical', 'critical', null);
    bus.publish('ev.info', 'info', null);
    bus.publish('ev.suggestion', 'suggestion', null);
    bus.publish('ev.recoverable', 'recoverable', null);

    assert.equal(received.length, 4);
    assert.ok(received.includes('ev.critical'));
    assert.ok(received.includes('ev.info'));
    assert.ok(received.includes('ev.suggestion'));
    assert.ok(received.includes('ev.recoverable'));
  });

  // ⑤ unsubscribe → 退订后不再收到事件
  it('⑤ unsubscribe → 退订后不再收到事件', () => {
    const bus = new EventBusV2();
    const received: string[] = [];

    const unsub = bus.on('target.event', ev => received.push(ev.type));

    bus.publish('target.event', 'info', null);
    assert.equal(received.length, 1);

    unsub(); // 退订

    bus.publish('target.event', 'info', null);
    assert.equal(received.length, 1); // 退订后不再增加
  });

  // ⑥ handler 抛异常 → 不影响其他 handler 执行
  it('⑥ handler 抛异常 → 不影响其他 handler 执行', () => {
    const bus = new EventBusV2();
    const results: string[] = [];

    bus.onAny(() => {
      results.push('before-throw');
      throw new Error('deliberate handler error');
    });

    bus.onAny(() => {
      results.push('after-throw');
    });

    // publish 不应抛出
    assert.doesNotThrow(() => bus.publish('some.event', 'info', null));

    // 两个 handler 都被调用（第二个在异常被安全捕获后继续）
    assert.ok(results.includes('before-throw'));
    assert.ok(results.includes('after-throw'));
  });

  // ⑦ TC-EB-08: on + onLevel + onAny 同时订阅同一事件 → 三个 handler 都收到
  it('⑦ on + onLevel + onAny 同时订阅同一 critical 事件 → 三个 handler 全收到', () => {
    const bus = new EventBusV2();
    const onReceived: string[] = [];
    const onLevelReceived: string[] = [];
    const onAnyReceived: string[] = [];

    bus.on('x.event', ev => onReceived.push(ev.type));
    bus.onLevel('critical', ev => onLevelReceived.push(ev.type));
    bus.onAny(ev => onAnyReceived.push(ev.type));

    bus.publish('x.event', 'critical', null);

    assert.equal(onReceived.length, 1, 'on handler 应收到 1 个事件');
    assert.equal(onLevelReceived.length, 1, 'onLevel handler 应收到 1 个事件');
    assert.equal(onAnyReceived.length, 1, 'onAny handler 应收到 1 个事件');

    assert.equal(onReceived[0], 'x.event');
    assert.equal(onLevelReceived[0], 'x.event');
    assert.equal(onAnyReceived[0], 'x.event');
  });

  // ⑧ TC-EB-09: 多次 publish 不同 type · drain 按顺序返回（FIFO）
  it('⑧ 多次 publish 不同 type · drain 按 FIFO 顺序返回', () => {
    const bus = new EventBusV2();

    bus.publish('ev.a', 'info', 1);
    bus.publish('ev.b', 'critical', 2);
    bus.publish('ev.c', 'recoverable', 3);

    const events = bus.drain();

    assert.equal(events.length, 3);
    assert.equal(events[0].type, 'ev.a');
    assert.equal(events[1].type, 'ev.b');
    assert.equal(events[2].type, 'ev.c');

    // payload 也应按顺序
    assert.equal(events[0].payload, 1);
    assert.equal(events[1].payload, 2);
    assert.equal(events[2].payload, 3);

    // drain 后队列清空
    const second = bus.drain();
    assert.equal(second.length, 0);
  });
});
