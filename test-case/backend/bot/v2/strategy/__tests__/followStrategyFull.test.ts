/**
 * FollowStrategy · FSM 完整状态转移测试（BUG-L5-01 重构版）
 *
 * 新模型：动态跟随（nav.startFollow）· following 每 tick 发幂等 follow_entity ·
 * 离开跟随态发 stop_follow · 无 in_range/滞回/stuck-detector。
 *
 * 覆盖：
 *   1. idle → following（owner 可见）
 *   2. idle → lost（owner 在场但不可见，无位置缓存）
 *   3. following：dist ≤ 3 → 仍 following，emit follow_entity（动态目标到位自停）
 *   4. following：owner 不可见（有缓存）→ 连续 N 帧才转 seeking，转出发 stop_follow
 *   5. following：dist > 3 → emit follow_entity P40
 *   6. following：owner 持续可见移动 → 持续 following 维持跟随
 *   7. lost → following（owner 重新可见）
 *   8. 任务失活（从 following）→ stop_follow + idle
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { FollowStrategy } from '../../../../../../apps/minecraft-companion/src/bot/v2/strategy/followStrategy.js';
import type { StrategyContext } from '../../../../../../apps/minecraft-companion/src/bot/v2/strategy/types.js';
import type { WorldStateView, OwnerView } from '../../../../../../apps/minecraft-companion/src/bot/v2/types.js';

function makeWorld(overrides: Partial<WorldStateView> = {}): WorldStateView {
  return {
    tick: 0,
    timestamp: Date.now(),
    self: { position: { x: 0, y: 64, z: 0 }, yaw: 0, pitch: 0, health: 20, maxHealth: 20, food: 20, isOnGround: true },
    owner: null,
    environment: { dimension: 'overworld', timeOfDay: 6000, isDay: true, isRaining: false },
    inventory: { items: [], held: null, freeSlots: 36 },
    entities: [],
    taskContext: null,
    ...overrides,
  };
}

function makeOwner(distance: number, isVisible = true): OwnerView {
  return {
    username: 'testOwner',
    position: isVisible ? { x: distance, y: 64, z: 0 } : null,
    distance,
    entityId: 42,
    isVisible,
  };
}

function makeCtx(world: WorldStateView, tick = 1, kind: string | null = 'follow_owner'): StrategyContext {
  return { world, tick, activeTaskId: kind ? 'task-1' : null, activeTaskKind: kind };
}

describe('FollowStrategy · FSM 完整转移（动态跟随重构版）', () => {
  let strategy: FollowStrategy;
  beforeEach(() => { strategy = new FollowStrategy(); });

  const getState = () => (strategy.inspect().view as { state: string }).state;

  it('1. idle + owner 可见 → following', () => {
    strategy.tick(makeCtx(makeWorld({ owner: makeOwner(8) }), 1));
    assert.equal(getState(), 'following');
  });

  it('2. idle + owner 不可见（无缓存）→ lost', () => {
    strategy.tick(makeCtx(makeWorld({ owner: makeOwner(Infinity, false) }), 1));
    assert.equal(getState(), 'lost');
  });

  it('3. following + dist ≤ 3 → 仍 following，emit follow_entity（无 in_range 态）', () => {
    strategy.tick(makeCtx(makeWorld({ owner: makeOwner(8) }), 1));
    const reqs = strategy.tick(makeCtx(makeWorld({ owner: makeOwner(2) }), 2));
    assert.equal(getState(), 'following');
    assert.ok(reqs.some(r => r.type === 'follow_entity'), '动态目标 atomic 幂等到位自停，仍维持 follow_entity');
  });

  it('4. following + owner 不可见 → 连续 4 帧才进 seeking，转出发 stop_follow', () => {
    strategy.tick(makeCtx(makeWorld({ owner: makeOwner(8) }), 1)); // → following，缓存坐标
    for (let i = 0; i < 3; i++) {
      strategy.tick(makeCtx(makeWorld({ owner: makeOwner(Infinity, false) }), 2 + i));
      assert.equal(getState(), 'following', `第 ${i + 1} 帧不可见不该转 seeking`);
    }
    const reqs = strategy.tick(makeCtx(makeWorld({ owner: makeOwner(Infinity, false) }), 5));
    assert.equal(getState(), 'seeking');
    assert.ok(reqs.some(r => r.type === 'stop_follow'), '转出 following 应发 stop_follow 清动态目标');
  });

  it('5. following + dist > 3 → emit follow_entity P40', () => {
    strategy.tick(makeCtx(makeWorld({ owner: makeOwner(8) }), 1));
    const reqs = strategy.tick(makeCtx(makeWorld({ owner: makeOwner(8) }), 2));
    assert.equal(getState(), 'following');
    const req = reqs.find(r => r.type === 'follow_entity');
    assert.ok(req, '应有 follow_entity 请求');
    assert.equal(req!.target?.entityId, 42);
    assert.equal(req!.priority, 40);
  });

  it('6. owner 持续可见移动 → 持续 following 维持跟随（每 tick follow_entity）', () => {
    for (let d = 8; d >= 3; d--) {
      const reqs = strategy.tick(makeCtx(makeWorld({ owner: makeOwner(d) }), 10 - d));
      if (d < 8) { // 首 tick 是 idle→following 无 emit，之后维持
        assert.equal(getState(), 'following');
        assert.ok(reqs.some(r => r.type === 'follow_entity'));
      }
    }
  });

  it('7. lost + owner 重新可见 → 回 following', () => {
    strategy.tick(makeCtx(makeWorld({ owner: makeOwner(Infinity, false) }), 1));
    assert.equal(getState(), 'lost');
    strategy.tick(makeCtx(makeWorld({ owner: makeOwner(5) }), 2));
    assert.equal(getState(), 'following');
  });

  it('8. 跟随中任务失活 → stop_follow + idle（防取消后仍跟）', () => {
    strategy.tick(makeCtx(makeWorld({ owner: makeOwner(8) }), 1));
    strategy.tick(makeCtx(makeWorld({ owner: makeOwner(8) }), 2));
    const reqs = strategy.tick(makeCtx(makeWorld(), 3, null)); // 任务失活
    assert.equal(getState(), 'idle');
    assert.ok(reqs.some(r => r.type === 'stop_follow'));
  });
});
