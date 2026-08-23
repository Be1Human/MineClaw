/**
 * GuardStrategy · BT 输出测试
 *
 * 测什么：
 *   1. 任务未激活 → 零请求
 *   2. 无敌对实体 + 在巡逻范围内 → 零请求（已在zone内不需移动）
 *   3. 无敌对实体 + 离中心距离 > radius*0.6 → emit move_to (patrol)，P35
 *   4. 有敌对实体（距离正常）→ emit attack，P45
 *   5. 有敌对实体（距离 < kiteRange）→ emit move_to (kite)，P55
 *   6. 血量危急 → emit stop，P90
 *   7. inspect() → kind=bt，含 activeActions
 *   8. reset() 后冷却清零，再次触发 attack
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { GuardStrategy } from '../../../../../../apps/minecraft-companion/src/bot/v2/strategy/guard/GuardStrategy.js';
import type { StrategyContext } from '../../../../../../apps/minecraft-companion/src/bot/v2/strategy/types.js';
import type { WorldStateView, EntityView } from '../../../../../../apps/minecraft-companion/src/bot/v2/types.js';

// ──────────────────────────────────────────────────────────────────
// 常量
// ──────────────────────────────────────────────────────────────────

const CENTER = { x: 0, y: 64, z: 0 };
const RADIUS = 10;

// ──────────────────────────────────────────────────────────────────
// 辅助
// ──────────────────────────────────────────────────────────────────

function makeCtx(opts: {
  selfPos?: { x: number; y: number; z: number };
  health?: number;
  entities?: EntityView[];
  taskKind?: string;
  tick?: number;
}): StrategyContext {
  const tick = opts.tick ?? 1;
  return {
    tick,
    activeTaskId: 'guard-1',
    activeTaskKind: opts.taskKind ?? 'guard',
    world: {
      tick,
      timestamp: Date.now(),
      owner: null,
      self: {
        position: opts.selfPos ?? CENTER,
        yaw: 0, pitch: 0,
        health: opts.health ?? 20,
        maxHealth: 20, food: 20, isOnGround: true,
      },
      entities: opts.entities ?? [],
      inventory: { items: [], held: null, freeSlots: 27 },
      environment: { dimension: 'overworld', timeOfDay: 6000, isDay: true, isRaining: false },
      taskContext: null,
    } as WorldStateView,
  };
}

function hostile(id: number, dist: number): EntityView {
  return {
    id,
    name: 'zombie',
    type: 'mob',
    position: { x: dist, y: 64, z: 0 },
    distance: dist,
    category: 'hostile',
  };
}

// ──────────────────────────────────────────────────────────────────
// 测试
// ──────────────────────────────────────────────────────────────────

describe('GuardStrategy · BT', () => {
  let guard: GuardStrategy;

  beforeEach(() => {
    guard = new GuardStrategy({ center: CENTER, radius: RADIUS, attackCooldownMs: 0, patrolCooldownMs: 0 });
  });

  it('任务未激活 → 零请求', () => {
    const reqs = guard.tick(makeCtx({ taskKind: 'other' }));
    assert.equal(reqs.length, 0);
  });

  it('在巡逻 zone 内（dist < radius*0.6）+ 无敌对 → 零请求', () => {
    const reqs = guard.tick(makeCtx({ selfPos: { x: 3, y: 64, z: 0 } })); // dist=3 < 10*0.6=6
    assert.equal(reqs.length, 0);
  });

  it('离中心 > radius*0.6 + 无敌对 → emit move_to P35 (patrol)', () => {
    const reqs = guard.tick(makeCtx({ selfPos: { x: 8, y: 64, z: 0 } })); // dist=8 > 6
    assert.ok(reqs.length >= 1, '应 emit 巡逻请求');
    const patrol = reqs.find(r => r.type === 'move_to' && r.source.includes('patrol'));
    assert.ok(patrol, '应有 patrol move_to');
    assert.equal(patrol!.priority, 35);
  });

  it('有敌对（dist=5，正常战斗距离）→ emit invoke_behavior(combat) P45', () => {
    const reqs = guard.tick(makeCtx({ entities: [hostile(1, 5)] }));
    const atk = reqs.find(r => r.type === 'invoke_behavior' && r.target?.behavior === 'combat');
    assert.ok(atk, '应有 invoke_behavior combat 请求');
    assert.equal(atk!.priority, 45);
    assert.equal((atk!.target?.behaviorParams as { targetEntityId: number })?.targetEntityId, 1);
  });

  it('有敌对（dist=1，< kiteRange=2.5）→ emit move_to P55 (kite)', () => {
    const reqs = guard.tick(makeCtx({ entities: [hostile(1, 1)] }));
    const kite = reqs.find(r => r.type === 'move_to' && r.priority === 55);
    assert.ok(kite, '应有风筝后退请求');
    assert.equal(kite!.interrupt_level, 'hard');
  });

  it('血量危急（≤4）→ emit stop P90，interrupt=hard', () => {
    const reqs = guard.tick(makeCtx({ health: 3 }));
    const stop = reqs.find(r => r.type === 'stop');
    assert.ok(stop, '应有 stop 请求');
    assert.equal(stop!.priority, 90);
    assert.equal(stop!.interrupt_level, 'hard');
  });

  it('inspect() → kind=bt，有 activeActions 字段', () => {
    guard.tick(makeCtx({ entities: [hostile(1, 5)] }));
    const s = guard.inspect();
    assert.equal(s.kind, 'bt');
    const view = s.view as { activeActions: string[] };
    assert.ok(Array.isArray(view.activeActions));
    assert.ok(view.activeActions.length > 0, 'attack 被执行后 activeActions 不空');
  });

  it('reset() 清空冷却，下一 tick 能再次 emit invoke_behavior(combat)', () => {
    // 默认 attackCooldownMs=0，所以这里换一个有冷却的 guard
    const g2 = new GuardStrategy({ center: CENTER, radius: RADIUS, attackCooldownMs: 60_000 });
    g2.tick(makeCtx({ entities: [hostile(1, 5)] }));       // 第一次触发，冷却启动
    const reqs2 = g2.tick(makeCtx({ entities: [hostile(1, 5)] })); // 冷却中
    assert.equal(
      reqs2.filter(r => r.type === 'invoke_behavior' && r.target?.behavior === 'combat').length,
      0,
      '冷却中不 emit invoke_behavior combat',
    );
    g2.reset?.();
    const reqs3 = g2.tick(makeCtx({ entities: [hostile(1, 5)] })); // reset 后恢复
    assert.ok(
      reqs3.some(r => r.type === 'invoke_behavior' && r.target?.behavior === 'combat'),
      'reset 后应重新 emit invoke_behavior combat',
    );
  });
});
