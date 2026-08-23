/**
 * ReflexStrategy · 事件驱动 · 单元测试（US-G9）
 *
 * 覆盖：
 *   1.  ingestCritical + tick → 处理 pending 事件，输出请求
 *   2.  under_attack + attacker → emit attack(invoke_behavior combat)
 *   3.  health ≤ 6 → 只 emit flee
 *   4.  同一 tick：under_attack + health≤6 → 单一撤离意图
 *   5.  同一 tick 只 emit 1 个 say（不重复）
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { ReflexStrategy } from '../../../../../../apps/minecraft-companion/src/bot/v2/strategy/reflexStrategy.js';
import type { StrategyContext } from '../../../../../../apps/minecraft-companion/src/bot/v2/strategy/types.js';
import type { WorldStateView, BusEvent, EntityView } from '../../../../../../apps/minecraft-companion/src/bot/v2/types.js';
import type { SpeechIntent } from '../../../../../../apps/minecraft-companion/src/bot/v2/narration/types.js';

// ──────────────────────────────────────────────────────────────────
// 辅助工厂
// ──────────────────────────────────────────────────────────────────

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

function makeCtx(
  world: WorldStateView,
  tick = 1,
  intents?: SpeechIntent[],
  activeTaskKind: string | null = null,
  activeTaskParams?: Record<string, unknown>,
): StrategyContext {
  return {
    world,
    tick,
    activeTaskId: activeTaskKind ? 'task-1' : null,
    activeTaskKind,
    activeTaskParams,
    // FEAT-NARR-01：危险/逃跑改走 narrate（不再 emit say ActionRequest）
    narrate: intents ? (i) => { intents.push(i); } : undefined,
  };
}

function makeCriticalEvent(type: string, payload: unknown = {}): BusEvent {
  return {
    id: `critical-${Date.now()}`,
    type,
    level: 'critical',
    timestamp: Date.now(),
    payload,
  };
}

function makeHostileEntity(id: number, name: string, distance: number): EntityView {
  return {
    id,
    name,
    type: 'mob',
    position: { x: distance, y: 64, z: 0 },
    distance,
    category: 'hostile',
  };
}

// ──────────────────────────────────────────────────────────────────
// 测试
// ──────────────────────────────────────────────────────────────────

describe('ReflexStrategy · 事件驱动（US-G9）', () => {
  let reflex: ReflexStrategy;

  beforeEach(() => {
    reflex = new ReflexStrategy({ createTask: () => ({ id: "r" }), startEmergency: () => ({ ok: true }), complete: () => {}, isRunning: () => true } as never);
  });

  // ── 1. ingestCritical + tick → 处理 pending 事件
  it('ingestCritical + tick → 消费 pending 事件，输出请求', () => {
    const zombie = makeHostileEntity(1, 'zombie', 5);
    const world = makeWorld({ entities: [zombie] });
    const ctx = makeCtx(world);

    reflex.ingestCritical([makeCriticalEvent('under_attack', { attackerId: 1 })]);
    assert.equal(reflex.isActive(ctx), true, 'ingestCritical 后 isActive 应为 true');

    const reqs = reflex.tick(ctx);
    assert.ok(reqs.length > 0, '应输出至少 1 个请求');
  });

  // ── 2. under_attack + attacker → emit invoke_behavior(combat)
  it('under_attack + 有 hostile 实体 → emit invoke_behavior(combat) P99', () => {
    const zombie = makeHostileEntity(10, 'zombie', 5);
    const world = makeWorld({ entities: [zombie] });
    const ctx = makeCtx(world, 1, undefined, 'guard');  // 战斗任务下才反击（非战斗→逃跑）

    reflex.ingestCritical([makeCriticalEvent('under_attack')]);
    const reqs = reflex.tick(ctx);

    const attack = reqs.find(r => r.type === 'invoke_behavior' && r.target?.behavior === 'combat');
    assert.ok(attack, '应有 invoke_behavior(combat) 请求');
    assert.equal(attack!.priority, 99);
    assert.equal(attack!.interrupt_level, 'hard');
    assert.equal((attack!.target?.behaviorParams as { targetEntityId: number })?.targetEntityId, 10);
  });

  // ── 3. health ≤ 6 → 只撤离
  it('health ≤ 6 → 只 emit flee，不攻击也不 stop', () => {
    const world = makeWorld({ self: { position: { x: 0, y: 64, z: 0 }, yaw: 0, pitch: 0, health: 5, maxHealth: 20, food: 20, isOnGround: true } });
    const ctx = makeCtx(world, 1, undefined, 'guard');  // 战斗任务下血危才紧急停

    reflex.ingestCritical([makeCriticalEvent('under_attack')]);
    const reqs = reflex.tick(ctx);

    assert.equal(reqs.length, 1);
    assert.equal(reqs[0].type, 'invoke_behavior');
    assert.equal(reqs[0].target?.behavior, 'flee');
    assert.equal(reqs[0].priority, 97);
  });

  // ── 4. under_attack + health≤6 → 单一撤离意图 + 危险通知
  it('同一 tick：under_attack + health≤6 → 仅 flee + 危险通知(narrate)', () => {
    const zombie = makeHostileEntity(20, 'zombie', 4);
    const world = makeWorld({
      entities: [zombie],
      self: { position: { x: 0, y: 64, z: 0 }, yaw: 0, pitch: 0, health: 4, maxHealth: 20, food: 20, isOnGround: true },
    });
    const intents: SpeechIntent[] = [];
    const ctx = makeCtx(world, 1, intents, 'guard');

    reflex.ingestCritical([makeCriticalEvent('under_attack')]);
    const reqs = reflex.tick(ctx);

    const hasFlee = reqs.some(r => r.type === 'invoke_behavior' && r.target?.behavior === 'flee');
    const hasAttack = reqs.some(r => r.type === 'invoke_behavior' && r.target?.behavior === 'combat');
    const hasStop   = reqs.some(r => r.type === 'stop');

    assert.ok(hasFlee, '应有 flee 请求');
    assert.equal(hasAttack, false, '低血不得同时攻击');
    assert.equal(hasStop, false, '低血不得用 stop 原地等死');
    assert.ok(reqs.every(r => r.type !== 'say'), '不再 emit 硬编码 say');
    assert.ok(intents.length >= 1, '危险应经 narrate 上报');
    assert.equal(intents[0].topic, 'low_health', 'health≤6 → low_health topic');
  });

  it('goal_exec.combatIntent=true 被识别为主动战斗任务', () => {
    const zombie = makeHostileEntity(25, 'zombie', 4);
    const world = makeWorld({ entities: [zombie] });
    const ctx = makeCtx(world, 1, undefined, 'goal_exec', { combatIntent: true });
    reflex.ingestCritical([makeCriticalEvent('under_attack')]);
    const reqs = reflex.tick(ctx);
    assert.ok(reqs.some(request => request.target?.behavior === 'combat'));
    assert.ok(reqs.every(request => request.target?.behavior !== 'flee'));
  });

  // ── 5. 同一 tick 多个 under_attack → narrate 只一次（不重复）
  it('同一 tick 多个 under_attack 事件 → narrate 只一次', () => {
    const zombie = makeHostileEntity(30, 'zombie', 6);
    const world = makeWorld({ entities: [zombie] });
    const intents: SpeechIntent[] = [];
    const ctx = makeCtx(world, 1, intents, 'guard');

    // 注入 2 个 under_attack critical 事件
    reflex.ingestCritical([
      makeCriticalEvent('under_attack'),
      makeCriticalEvent('under_attack'),
    ]);
    const reqs = reflex.tick(ctx);

    assert.ok(reqs.every(r => r.type !== 'say'), '不再 emit say');
    assert.equal(intents.length, 1, '同一 tick 只应 narrate 1 次');
    assert.equal(intents[0].topic, 'danger_fight', 'health>6 战斗 → danger_fight');
  });
});
