/**
 * US-H7 · 场景 e2e · 守卫 BT 走位
 *
 * 两部分：
 *   Part A — ScenarioRunner e2e
 *     t=0  : owner 说 "守着我"
 *     断言  : task.started(kind=guard) 出现在事件流
 *
 *   Part B — GuardStrategy BT 直驱（因 V2Runtime 暂未将 GuardStrategy 挂入
 *             Heartbeat taskStrategies，故直接实例化驱动，验证 BT 跳转逻辑）
 *     1. 无敌对 + 在 zone 外 → activeActions 含 'patrol_move'
 *     2. 新增 zombie 6 格 → activeActions 含 'attack_hostile'
 *     3. 删除 zombie → activeActions 回到 'patrol_move'（或空，视 zone 距离）
 *
 * 断言使用 node:assert/strict；导入使用 .js 扩展。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  runScenario,
  expectEventEmitted,
} from './runner.js';
import { GuardStrategy } from '../../../../../../apps/minecraft-companion/src/bot/v2/strategy/guard/GuardStrategy.js';
import type { StrategyContext } from '../../../../../../apps/minecraft-companion/src/bot/v2/strategy/types.js';
import type { WorldStateView, EntityView } from '../../../../../../apps/minecraft-companion/src/bot/v2/types.js';

// ──────────────────────────────────────────────────────────────────
// 辅助工厂
// ──────────────────────────────────────────────────────────────────

const CENTER = { x: 0, y: 64, z: 0 };

/** 构造一个最小 WorldStateView */
function makeWorld(opts: {
  selfPos?: { x: number; y: number; z: number };
  health?: number;
  entities?: EntityView[];
}): WorldStateView {
  return {
    tick: 1,
    timestamp: Date.now(),
    owner: null,
    self: {
      position: opts.selfPos ?? CENTER,
      yaw: 0,
      pitch: 0,
      health: opts.health ?? 20,
      maxHealth: 20,
      food: 20,
      isOnGround: true,
    },
    entities: opts.entities ?? [],
    inventory: { items: [], held: null, freeSlots: 27 },
    environment: {
      dimension: 'overworld',
      timeOfDay: 6000,
      isDay: true,
      isRaining: false,
    },
    taskContext: null,
  };
}

/** 构造一个守卫激活的 StrategyContext */
function makeCtx(world: WorldStateView, tick = 1): StrategyContext {
  return {
    tick,
    activeTaskId: 'guard-test',
    activeTaskKind: 'guard',
    world,
  };
}

/** 构造一个敌对实体 */
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
// Part A · ScenarioRunner e2e
// ──────────────────────────────────────────────────────────────────

describe.skip('US-H7 · 旧 RuleLoop chat→guard 链（BUG-CROSS-51 已删除）', () => {
  test('owner says 守着我 → task.started(kind=guard) appears in event stream', async () => {
    const result = await runScenario({
      setup(bot) {
        // owner 必须在世界里才能通过 detectAddress；位置紧邻自身
        bot.world.setOwner('testOwner', 1, { x: 5, y: 64, z: 0 });
      },
      timeline: [
        {
          atMs: 200,
          action(bot) {
            bot.game.emitChat('testOwner', '守着我');
          },
        },
      ],
      durationMs: 4000,
    });

    const { events } = result;

    // L7 必须处理完 turn
    expectEventEmitted(events, 'l7.turn_finished');

    // task.started 且 kind=guard
    const guardStarted = events.find(
      e =>
        e.type === 'task.started' &&
        (e.payload as { kind?: string }).kind === 'guard',
    );
    assert.ok(
      guardStarted !== undefined,
      `Expected task.started(kind=guard) — got event types: [${events
        .filter(e => e.type.startsWith('task.'))
        .map(e => `${e.type}:${(e.payload as { kind?: string }).kind ?? ''}`)
        .join(', ')}]`,
    );
  });
});

// ──────────────────────────────────────────────────────────────────
// Part B · GuardStrategy BT 直驱（带时间轴语义）
// ──────────────────────────────────────────────────────────────────

describe('US-H7 · GuardStrategy BT transitions (direct drive)', () => {
  /**
   * t=1000ms: 无敌对 + 在 zone 外 → patrol 分支激活
   * t=2000ms: 注入 zombie 6 格 → combat/attack 分支激活
   * t=3500ms: 断言 activeActions 含 attack_hostile
   * t=4500ms: 删除 zombie → 回到 patrol（或空）
   */
  test('BT patrol → combat → patrol transitions match zone/hostile state', async () => {
    // 构造 GuardStrategy：关闭冷却，确保每 tick 都能执行
    const guard = new GuardStrategy({
      center: CENTER,
      radius: 10,
      combatRange: 8,
      kiteRange: 2.5,
      attackCooldownMs: 0,
      patrolCooldownMs: 0,
    });

    // ── t=1000ms: 自身在 zone 外（dist=8 > radius*0.6=6），无敌对 → patrol ─────
    await new Promise(r => setTimeout(r, 1000));

    const worldPatrol = makeWorld({ selfPos: { x: 8, y: 64, z: 0 }, entities: [] });
    const reqs1 = guard.tick(makeCtx(worldPatrol, 1));
    const inspect1 = guard.inspect();
    const view1 = inspect1.view as { activeActions: string[] };

    assert.equal(inspect1.kind, 'bt', 'inspect().kind should be bt');
    assert.ok(
      reqs1.some(r => r.type === 'move_to' && r.source.includes('patrol')),
      `Expected patrol move_to request — got: [${reqs1.map(r => `${r.type}/${r.source}`).join(', ')}]`,
    );
    assert.ok(
      view1.activeActions.includes('patrol_move'),
      `Expected activeActions to include 'patrol_move' after patrol tick — got: [${view1.activeActions.join(', ')}]`,
    );

    // ── t=2000ms: 注入 zombie 6 格 → combat 分支 ──────────────────────────────
    await new Promise(r => setTimeout(r, 1000));

    const zombieId = 42;
    const zombieEntities: EntityView[] = [hostile(zombieId, 6)];
    const worldCombat = makeWorld({ selfPos: { x: 8, y: 64, z: 0 }, entities: zombieEntities });

    // reset 确保 selector 从头遍历（清除 seq 里的 runningIdx 记忆）
    guard.reset?.();
    const reqs2 = guard.tick(makeCtx(worldCombat, 2));
    const inspect2 = guard.inspect();
    const view2 = inspect2.view as { activeActions: string[] };

    assert.ok(
      reqs2.some(r => r.type === 'invoke_behavior' && r.target?.behavior === 'combat'),
      `Expected combat invoke_behavior — got: [${reqs2.map(r => `${r.type}/${r.source}`).join(', ')}]`,
    );

    // ── t=3500ms: 再 tick 一次确认 activeActions 含 attack_hostile ──────────────
    await new Promise(r => setTimeout(r, 1500));

    guard.reset?.();
    guard.tick(makeCtx(worldCombat, 3));
    const inspect35 = guard.inspect();
    const view35 = inspect35.view as { activeActions: string[] };

    assert.ok(
      view35.activeActions.includes('attack_hostile'),
      `t=3500ms: expected activeActions to include 'attack_hostile' — got: [${view35.activeActions.join(', ')}]`,
    );

    // bus events check（直驱模式下通过 ActionRequest 源字符串验证攻击意图）
    assert.ok(
      reqs2.some(r => r.source.includes('attack') || (r.type === 'invoke_behavior' && r.target?.behavior === 'combat')),
      'Expected attack-related request when zombie present',
    );

    // ── t=4500ms: 移除 zombie → 回到 patrol ──────────────────────────────────
    await new Promise(r => setTimeout(r, 1000));

    const worldAfterKill = makeWorld({ selfPos: { x: 8, y: 64, z: 0 }, entities: [] });
    guard.reset?.();
    const reqs3 = guard.tick(makeCtx(worldAfterKill, 4));
    const inspect3 = guard.inspect();
    const view3 = inspect3.view as { activeActions: string[] };

    // 无敌对 → combat 分支跳过，回到 patrol
    assert.ok(
      !reqs3.some(r => r.type === 'invoke_behavior' && r.target?.behavior === 'combat'),
      'After zombie removed: should NOT emit combat request',
    );
    // 在 zone 外 → patrol 分支激活
    assert.ok(
      reqs3.some(r => r.type === 'move_to' && r.source.includes('patrol')) ||
      view3.activeActions.includes('patrol_move'),
      `After zombie removed: expected patrol active — actions=[${view3.activeActions.join(', ')}]`,
    );

    // ── 总 run 6000ms 完成 ───────────────────────────────────────────────────
    await new Promise(r => setTimeout(r, 500));
  });

  test('task not active → zero requests', () => {
    const guard = new GuardStrategy({ center: CENTER, radius: 10 });
    const world = makeWorld({});
    const ctx: StrategyContext = {
      tick: 1,
      activeTaskId: null,
      activeTaskKind: 'other',
      world,
    };
    const reqs = guard.tick(ctx);
    assert.equal(reqs.length, 0, 'inactive guard should emit no requests');
  });

  test('inspect() returns bt kind with activeActions array', () => {
    const guard = new GuardStrategy({
      center: CENTER,
      radius: 10,
      attackCooldownMs: 0,
    });
    // tick with hostile present → activeActions populated
    guard.tick(makeCtx(makeWorld({ entities: [hostile(1, 5)] })));
    const s = guard.inspect();
    assert.equal(s.kind, 'bt');
    const view = s.view as { activeActions: string[] };
    assert.ok(Array.isArray(view.activeActions), 'activeActions should be array');
    assert.ok(view.activeActions.length > 0, 'activeActions should be non-empty after combat tick');
  });
});
