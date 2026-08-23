/**
 * ReflexStrategy · 补充测试（US-DOC-L5）
 *
 * 覆盖：
 *   1. tick 消费 pending 后 isActive=false
 *   2. onEvent(non-critical) → 不入队，isActive=false
 *   3. reset() → pending 清空，lastTriggered 归零
 *   4. inspect() 格式 · kind=reflex · view 字段
 *   5. 无 hostile 时 under_attack → 仍 emit say（无 attack 请求）
 *   6. ingestCritical 过滤非 critical 事件
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { ReflexStrategy } from '../../../../../../apps/minecraft-companion/src/bot/v2/strategy/reflexStrategy.js';
import type { StrategyContext } from '../../../../../../apps/minecraft-companion/src/bot/v2/strategy/types.js';
import type { WorldStateView, BusEvent } from '../../../../../../apps/minecraft-companion/src/bot/v2/types.js';
import type { SpeechIntent } from '../../../../../../apps/minecraft-companion/src/bot/v2/narration/types.js';

// ──────────────────────────────────────────────────────────────────
// 辅助工厂
// ──────────────────────────────────────────────────────────────────

function makeWorld(overrides: Partial<WorldStateView> = {}): WorldStateView {
  return {
    tick: 0,
    timestamp: Date.now(),
    self: {
      position: { x: 0, y: 64, z: 0 },
      yaw: 0,
      pitch: 0,
      health: 20,
      maxHealth: 20,
      food: 20,
      isOnGround: true,
    },
    owner: null,
    environment: { dimension: 'overworld', timeOfDay: 6000, isDay: true, isRaining: false },
    inventory: { items: [], held: null, freeSlots: 36 },
    entities: [],
    taskContext: null,
    ...overrides,
  };
}

function makeCtx(world: WorldStateView = makeWorld(), tick = 1): StrategyContext {
  return { world, tick, activeTaskId: null, activeTaskKind: null };
}

function makeCritical(type: string, payload: unknown = {}): BusEvent {
  return {
    id: `ev-${Date.now()}`,
    type,
    level: 'critical',
    timestamp: Date.now(),
    payload,
  };
}

function makeInfo(type: string): BusEvent {
  return {
    id: `ev-info-${Date.now()}`,
    type,
    level: 'info',
    timestamp: Date.now(),
    payload: {},
  };
}

// ──────────────────────────────────────────────────────────────────
// 测试
// ──────────────────────────────────────────────────────────────────

describe('ReflexStrategy · 补充测试（US-DOC-L5）', () => {
  let reflex: ReflexStrategy;

  beforeEach(() => {
    reflex = new ReflexStrategy({ createTask: () => ({ id: "r" }), startEmergency: () => ({ ok: true }), complete: () => {}, isRunning: () => true } as never);
  });

  // ── 1. tick 消费 pending 后 isActive=false
  it('tick 消费 pending 后 isActive 回到 false', () => {
    const ctx = makeCtx();
    reflex.ingestCritical([makeCritical('under_attack')]);
    assert.equal(reflex.isActive(ctx), true, 'ingestCritical 后应为 active');
    reflex.tick(ctx);
    assert.equal(reflex.isActive(ctx), false, 'tick 消费后 pending 清空，isActive 应为 false');
  });

  // ── 2. onEvent(non-critical) → 不入队，isActive=false
  it('onEvent(info 级别) → 不入队，isActive=false', () => {
    const ctx = makeCtx();
    const out = reflex.onEvent(makeInfo('some_info'), ctx);
    assert.deepEqual(out, [], 'onEvent 非 critical → 返回空数组');
    assert.equal(reflex.isActive(ctx), false, '非 critical 事件不入队');
  });

  // ── 3. reset() → pending 清空，lastTriggered 归零
  it('reset() 清空 pending 和 lastTriggered', () => {
    const ctx = makeCtx();
    reflex.ingestCritical([makeCritical('under_attack')]);
    reflex.reset();
    assert.equal(reflex.isActive(ctx), false, 'reset 后 isActive 应为 false');
    const s = reflex.inspect();
    const view = s.view as { lastTriggeredAt: number };
    assert.equal(view.lastTriggeredAt, 0, 'reset 后 lastTriggeredAt 应为 0');
  });

  // ── 4. inspect() 格式
  it('inspect() 返回 kind=reflex，view 含 pendingCriticalCount', () => {
    const s = reflex.inspect();
    assert.equal(s.kind, 'reflex');
    const view = s.view as { pendingCriticalCount: number; lastTriggeredAt: number; lastTriggeredType: string };
    assert.equal(typeof view.pendingCriticalCount, 'number');
    assert.equal(typeof view.lastTriggeredAt, 'number');
    assert.equal(typeof view.lastTriggeredType, 'string');
  });

  // ── 5. 无 hostile 时 under_attack → 上报危险通知(narrate)，无 attack（FEAT-NARR-01）
  it('under_attack + 无 hostile 实体 → narrate 上报，不 emit say/attack', () => {
    // 空实体列表，没有 hostile
    const world = makeWorld({ entities: [] });
    const intents: SpeechIntent[] = [];
    const ctx: StrategyContext = { ...makeCtx(world), narrate: (i) => { intents.push(i); } };
    reflex.ingestCritical([makeCritical('under_attack')]);
    const reqs = reflex.tick(ctx);
    const hasAttack = reqs.some(r => r.type === 'invoke_behavior' && r.target?.behavior === 'combat');
    assert.equal(hasAttack, false, '无 hostile 时不应 emit attack');
    assert.ok(reqs.every(r => r.type !== 'say'), '不再 emit 硬编码 say');
    assert.ok(intents.length >= 1, '应经 narrate 上报危险');
  });

  // ── 6. ingestCritical 过滤非 critical 事件
  it('ingestCritical 传入 info 事件 → 不入队，tick 返回空', () => {
    const ctx = makeCtx();
    const infoEvent: BusEvent = {
      id: 'info-1',
      type: 'under_attack',
      level: 'info',       // info 级别，不是 critical
      timestamp: Date.now(),
      payload: {},
    };
    reflex.ingestCritical([infoEvent]);
    assert.equal(reflex.isActive(ctx), false, 'info 级别不应入队');
    const reqs = reflex.tick(ctx);
    assert.equal(reqs.length, 0);
  });

  it('BUG-CROSS-04 · active lava_escape 时忽略持续烧伤 under_attack', () => {
    const world = makeWorld({ entities: [] });
    const ctx = { ...makeCtx(world), activeTaskId: 'lava-1', activeTaskKind: 'lava_escape' } as StrategyContext;
    reflex.ingestCritical([makeCritical('under_attack')]);
    const reqs = reflex.tick(ctx);
    assert.deepEqual(reqs, []);
    assert.equal(reflex.isActive(ctx), false, '事件应被消费，不能下一 tick 再抢占');
  });
});
