import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { NullGameAdapter } from '../../../../../apps/minecraft-companion/src/bot/adapter/NullGameAdapter.js';
import { NullNavAdapter } from '../../../../../apps/minecraft-companion/src/bot/adapter/NullNavAdapter.js';
import { SwitchableGameAdapter } from '../../../../../apps/minecraft-companion/src/bot/adapter/SwitchableGameAdapter.js';
import { SwitchableNavAdapter } from '../../../../../apps/minecraft-companion/src/bot/adapter/SwitchableNavAdapter.js';
import type { GameAdapter } from '../../../../../apps/minecraft-companion/src/bot/adapter/GameAdapter.js';
import type { Vec3 } from '../../../../../apps/minecraft-companion/src/bot/adapter/types.js';
import { withinBody } from '../../v2/__tests__/mocks/withinBody.js';
import { createMockBot, MockNavigationAdapter } from '../../v2/__tests__/mocks/index.js';

/**
 * 造一个可辨识的假 game 身体：覆盖测试关心的方法，其余从 Null 继承代理不了，
 * 所以直接继承 NullGameAdapter 再覆写。
 */
class FakeGame extends NullGameAdapter {
  private deathHandlers: (() => void)[] = [];
  private pos: Vec3;
  constructor(name: string, pos: Vec3) {
    super(name);
    this.pos = pos;
  }
  override getPosition(): Vec3 { return this.pos; }
  override getHealth(): number { return 7; }
  override onDeath(handler: () => void) {
    this.deathHandlers.push(handler);
    return () => {
      const i = this.deathHandlers.indexOf(handler);
      if (i >= 0) this.deathHandlers.splice(i, 1);
    };
  }
  /** 测试触发死亡事件 · 返回当前挂在本身体上的 handler 数 */
  fireDeath(): void { for (const h of [...this.deathHandlers]) h(); }
  liveHandlerCount(): number { return this.deathHandlers.length; }
}

describe('FEAT-CROSS-08 v2 · SwitchableGameAdapter', () => {
  it('方法委托到当前 target', () => {
    const nul = new NullGameAdapter('Null');
    const proxy = new SwitchableGameAdapter(nul);
    // 初始 = Null 身体
    assert.equal(proxy.username, 'Null');
    assert.deepEqual(proxy.getPosition(), { x: 0, y: 64, z: 0 });

    const real = new FakeGame('Real', { x: 10, y: 70, z: -5 });
    proxy.setTarget(real);
    assert.equal(proxy.username, 'Real');
    assert.deepEqual(proxy.getPosition(), { x: 10, y: 70, z: -5 });
    assert.equal(proxy.getHealth(), 7);
    assert.equal(proxy.getTarget(), real);
  });

  it('setTarget 幂等：切到同一 target 不重挂订阅', () => {
    const real = new FakeGame('Real', { x: 0, y: 64, z: 0 });
    const proxy = new SwitchableGameAdapter(real);
    let fired = 0;
    proxy.onDeath(() => { fired++; });
    assert.equal(real.liveHandlerCount(), 1);
    proxy.setTarget(real); // 同一 target
    assert.equal(real.liveHandlerCount(), 1); // 未重挂
    real.fireDeath();
    assert.equal(fired, 1);
  });

  it('订阅簿记 + 重放：切换后事件仍触发，旧身体解绑', () => {
    const nul = new NullGameAdapter();
    const proxy = new SwitchableGameAdapter(nul);
    let fired = 0;
    // 在 Null 身体上注册（Null.onDeath 是 no-op，永不触发）
    proxy.onDeath(() => { fired++; });

    const bodyA = new FakeGame('A', { x: 0, y: 64, z: 0 });
    proxy.setTarget(bodyA);
    assert.equal(bodyA.liveHandlerCount(), 1, '订阅重挂到新身体');
    bodyA.fireDeath();
    assert.equal(fired, 1, '切换后事件仍触发');

    const bodyB = new FakeGame('B', { x: 1, y: 64, z: 1 });
    proxy.setTarget(bodyB);
    assert.equal(bodyA.liveHandlerCount(), 0, '旧身体已解绑');
    assert.equal(bodyB.liveHandlerCount(), 1, '重挂到 B');
    bodyA.fireDeath(); // 旧身体触发不应再命中
    assert.equal(fired, 1);
    bodyB.fireDeath();
    assert.equal(fired, 2, '新身体触发命中');
  });

  it('unsubscribe 后不再重放到新 target', () => {
    const bodyA = new FakeGame('A', { x: 0, y: 64, z: 0 });
    const proxy = new SwitchableGameAdapter(bodyA);
    let fired = 0;
    const off = proxy.onDeath(() => { fired++; });
    off(); // 注销
    assert.equal(bodyA.liveHandlerCount(), 0);
    const bodyB = new FakeGame('B', { x: 0, y: 64, z: 0 });
    proxy.setTarget(bodyB);
    assert.equal(bodyB.liveHandlerCount(), 0, '已注销的订阅不重放');
    bodyB.fireDeath();
    assert.equal(fired, 0);
  });

  it('detach 回 Null：动作类回落安全失败', async () => {
    const real = new FakeGame('Real', { x: 0, y: 64, z: 0 });
    const proxy: GameAdapter & { setTarget: (t: GameAdapter) => void } =
      new SwitchableGameAdapter(real);
    const nul = new NullGameAdapter('Companion');
    proxy.setTarget(nul);
    assert.equal(proxy.username, 'Companion');
    await withinBody(async scope => {
      assert.throws(() => proxy.bind(scope), /game_body_unavailable/);
      assert.equal('dig' in proxy, false);
    });
  });
});

describe('FEAT-CROSS-08 v2 · SwitchableNavAdapter', () => {
  it('方法委托 + 订阅重放', async () => {
    const nul = new NullNavAdapter();
    const proxy = new SwitchableNavAdapter(nul);
    assert.equal(proxy.isMoving(), false);
    assert.equal(proxy.getTarget(), nul);
    class EventNavigation extends MockNavigationAdapter {
      readonly reached = new Set<() => void>();
      override onGoalReached(handler: () => void) {
        this.reached.add(handler);
        return () => { this.reached.delete(handler); };
      }
      fireReached() { for (const handler of this.reached) handler(); }
    }
    await withinBody(async scope => {
      const game = createMockBot().game.bind(scope);
      const input = { scope, game, maintain: async () => {} };
      try {
        assert.throws(() => proxy.bind(input), /navigation_body_unavailable/);
        let fired = 0;
        const off = proxy.onGoalReached(() => { fired++; });
        const first = new EventNavigation(); first.gotoDelay = 1;
        proxy.setTarget(first);
        const session = proxy.bind(input);
        assert.equal(proxy.getTarget(), first);
        try {
          assert.equal((await session.actions.goto({ type: 'block', position: { x: 1, y: 64, z: 1 } })).ok, true);
          first.fireReached(); assert.equal(fired, 1);
          const next = new EventNavigation();
          proxy.setTarget(next);
          assert.equal(first.reached.size, 0);
          assert.equal(next.reached.size, 1);
          first.fireReached(); assert.equal(fired, 1);
          next.fireReached(); assert.equal(fired, 2);
          await assert.rejects(() => session.actions.goto({ type: 'block', position: { x: 2, y: 64, z: 2 } }), /navigation_generation_changed/);
          assert.equal(next.calls.goto.length, 0, '旧会话不能把动作转发给新身体');
          off(); assert.equal(next.reached.size, 0);
          proxy.setTarget(first); assert.equal(first.reached.size, 0);
        } finally { await session.stop('test_finished'); }
      } finally { await game.stop('test_finished'); }
    });
  });
});
