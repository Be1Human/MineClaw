/**
 * FollowStrategy · FSM 状态转移测试（BUG-L5-01 重构版）
 *
 * 新模型：跟随 = 动态目标（nav.startFollow），following 每 tick 发幂等 follow_entity，
 * 离开跟随态发 stop_follow。无 in_range/滞回/stuck-detector。
 *
 * 测什么：
 *   1. 任务未激活 → idle，零请求
 *   2. 激活 + owner 可见 → following，emit follow_entity P40
 *   3. dist ≤ 3 → 仍 following，emit follow_entity（动态目标到位自停，无 in_range 态）
 *   4. owner 从未可见 → lost，emit follow_lost
 *   5. owner 可见后消失 → 连续 N 帧不可见才转 seeking，转出发 stop_follow
 *   6. lost 后 owner 再可见 → following
 *   7. 任务失活（从 following）→ stop_follow（防取消后仍跟）
 *   8. reset → idle
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { FollowStrategy } from '../../../../../../apps/minecraft-companion/src/bot/v2/strategy/followStrategy.js';
import type { StrategyContext } from '../../../../../../apps/minecraft-companion/src/bot/v2/strategy/types.js';
import type { WorldStateView, OwnerView } from '../../../../../../apps/minecraft-companion/src/bot/v2/types.js';

function makeCtx(owner: Partial<OwnerView> | null, tick = 1): StrategyContext {
  return {
    tick,
    activeTaskId: owner !== null ? 'task-1' : null,
    activeTaskKind: owner !== null ? 'follow_owner' : null,
    world: {
      tick,
      timestamp: Date.now(),
      owner: owner === null ? null : {
        username: 'player1',
        position: { x: 10, y: 64, z: 10 },
        distance: 5,
        entityId: 42,
        isVisible: true,
        ...owner,
      } as OwnerView,
      self: { position: { x: 0, y: 64, z: 0 }, yaw: 0, pitch: 0, health: 20, maxHealth: 20, food: 20, isOnGround: true },
      entities: [],
      inventory: { items: [], held: null, freeSlots: 27 },
      environment: { dimension: 'overworld', timeOfDay: 6000, isDay: true, isRaining: false },
      taskContext: null,
    } as WorldStateView,
  };
}

const stateOf = (s: FollowStrategy) => (s.inspect().view as { state: string }).state;

describe('FollowStrategy · FSM（动态跟随重构版）', () => {
  let strategy: FollowStrategy;
  beforeEach(() => { strategy = new FollowStrategy(); });

  it('任务未激活 → idle，零请求', () => {
    const reqs = strategy.tick(makeCtx(null));
    assert.equal(reqs.length, 0);
    assert.equal(stateOf(strategy), 'idle');
  });

  it('激活 + owner 可见 dist>3 → following，emit follow_entity P40', () => {
    strategy.tick(makeCtx({ distance: 8, isVisible: true }, 1)); // idle → following（无 emit）
    const reqs = strategy.tick(makeCtx({ distance: 8, isVisible: true }, 2));
    assert.equal(stateOf(strategy), 'following');
    assert.ok(reqs.length >= 1);
    assert.equal(reqs[0].type, 'follow_entity');
    assert.equal(reqs[0].target?.entityId, 42);
    assert.equal(reqs[0].priority, 40);
  });

  it('dist>12 仍发 follow_entity P40（距离由 pathfinder 动态目标处理）', () => {
    strategy.tick(makeCtx({ distance: 15, isVisible: true }, 1));
    const reqs = strategy.tick(makeCtx({ distance: 15, isVisible: true }, 2));
    assert.equal(reqs[0].type, 'follow_entity');
    assert.equal(reqs[0].priority, 40);
  });

  it('dist ≤ 3 → 仍 following，emit follow_entity（无 in_range 态，atomic 幂等到位自停）', () => {
    strategy.tick(makeCtx({ distance: 8, isVisible: true }));
    const reqs = strategy.tick(makeCtx({ distance: 2, isVisible: true }));
    assert.equal(stateOf(strategy), 'following');
    assert.ok(reqs.some(r => r.type === 'follow_entity'));
  });

  it('owner 从未可见（无位置缓存）→ idle→lost，emit follow_lost', () => {
    strategy.tick(makeCtx({ isVisible: false, position: null, distance: Infinity }));
    assert.equal(stateOf(strategy), 'lost');
    const ctx2 = makeCtx({ isVisible: false, position: null, distance: Infinity });
    const notices: Array<{ topic: string }> = [];
    ctx2.narrate = (i) => notices.push(i as { topic: string });
    strategy.tick(ctx2);
    assert.ok(notices.some(n => n.topic === 'follow_lost'), '应上报 follow_lost 中性通知');
  });

  it('owner 可见后消失 → 连续 N 帧不可见才转 seeking，期间维持跟随；转出发 stop_follow', () => {
    strategy.tick(makeCtx({ distance: 8, isVisible: true })); // → following，缓存坐标
    // streak < 4：仍 following，维持 follow_entity（短暂遮挡不放弃）
    for (let i = 0; i < 3; i++) {
      const reqs = strategy.tick(makeCtx({ isVisible: false, position: null, distance: Infinity }));
      assert.equal(stateOf(strategy), 'following', `第 ${i + 1} 帧不可见不该转 seeking`);
      assert.ok(reqs.some(r => r.type === 'follow_entity'), '遮挡期维持跟随');
    }
    // 第 4 帧达阈值 → 真失联，转 seeking，发 stop_follow 清动态目标
    const reqs = strategy.tick(makeCtx({ isVisible: false, position: null, distance: Infinity }));
    assert.equal(stateOf(strategy), 'seeking');
    assert.ok(reqs.some(r => r.type === 'stop_follow'), '转出 following 应发 stop_follow');
  });

  it('lost 后 owner 重新可见 → 回 following', () => {
    strategy.tick(makeCtx({ isVisible: false, position: null, distance: Infinity }));
    assert.equal(stateOf(strategy), 'lost');
    strategy.tick(makeCtx({ distance: 5, isVisible: true }));
    assert.equal(stateOf(strategy), 'following');
  });

  it('跟随中任务失活 → stop_follow（防任务取消后仍跟着主人跑）', () => {
    strategy.tick(makeCtx({ distance: 8, isVisible: true }));      // → following
    strategy.tick(makeCtx({ distance: 8, isVisible: true }, 2));   // following emit
    const reqs = strategy.tick(makeCtx(null, 3));                  // 任务失活
    assert.equal(stateOf(strategy), 'idle');
    assert.ok(reqs.some(r => r.type === 'stop_follow'), '失活时应 stop_follow 清动态目标');
  });

  it('reset() → 回 idle', () => {
    strategy.tick(makeCtx({ distance: 8 }));
    strategy.reset?.();
    assert.equal(stateOf(strategy), 'idle');
  });

  it('inspect() 返回 kind=fsm 和 state', () => {
    const s = strategy.inspect();
    assert.equal(s.kind, 'fsm');
    assert.ok('state' in (s.view as object));
  });
});
