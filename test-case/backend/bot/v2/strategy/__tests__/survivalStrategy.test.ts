/**
 * SurvivalStrategy · 单元测试
 *
 * 覆盖：
 *   ① 白天遇怪保持旧行为（flee/fight）
 *   ② FEAT-L5-02 夜晚自保 · 围 4 块
 *   ③ FEAT-L5-02 · 没方块 → fallback flee + say
 *   ④ 围完后下一 tick · 静默蹲守
 *   ⑤ 天亮重置自保状态
 *   ⑥ 濒死优先于围块（health ≤ 8）
 *   ⑦ cobblestone 优先于 dirt
 *   ⑧ count<4 不触发围块
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { SurvivalStrategy } from '../../../../../../apps/minecraft-companion/src/bot/v2/strategy/survivalStrategy.js';
import type { StrategyContext } from '../../../../../../apps/minecraft-companion/src/bot/v2/strategy/types.js';
import type { WorldStateView, EntityView, InventoryView } from '../../../../../../apps/minecraft-companion/src/bot/v2/types.js';

// ──────────────────────────────────────────────────────────────────
// 辅助工厂
// ──────────────────────────────────────────────────────────────────

function makeWorld(overrides: Partial<WorldStateView> = {}): WorldStateView {
  return {
    tick: 0,
    timestamp: Date.now(),
    self: {
      position: { x: 100, y: 64, z: 200 },
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

function makeHostile(name: string, distance: number, id = 1): EntityView {
  return {
    id,
    name,
    type: 'mob',
    position: { x: 110, y: 64, z: 200 },
    distance,
    category: 'hostile',
  };
}

function makeInv(items: Array<{ name: string; count: number }>): InventoryView {
  return {
    items: items.map(it => ({ ...it, slot: 0 })) as InventoryView['items'],
    held: null,
    freeSlots: 36 - items.length,
  };
}

function makeCtx(
  world: WorldStateView,
  tick = 1,
  activeTaskKind: string | null = null,
  activeTaskParams?: Record<string, unknown>,
): StrategyContext {
  return {
    world,
    tick,
    activeTaskId: activeTaskKind ? 'task-1' : null,
    activeTaskKind,
    activeTaskParams,
  };
}

// ──────────────────────────────────────────────────────────────────
// 测试
// ──────────────────────────────────────────────────────────────────

describe('SurvivalStrategy · 夜晚自保 (FEAT-L5-02)', () => {
  let surv: SurvivalStrategy;

  beforeEach(() => {
    // FEAT-CROSS-05 · survive 紧急任务 mock（只需让 tick 包装层不报错）
    let seq = 0;
    const tasks = {
      createTask: () => ({ id: `s${++seq}` }),
      startEmergency: () => ({ ok: true }),
      complete: () => {},
      isRunning: () => true,
    } as never;
    surv = new SurvivalStrategy(tasks);
  });

  // ── ① 白天回归 ───────────────────────────────────────────────
  it('UT1 · 白天遇怪 → 不围块（走 flee）', () => {
    const world = makeWorld({
      environment: { dimension: 'overworld', timeOfDay: 6000, isDay: true, isRaining: false },
      entities: [makeHostile('zombie', 10)],
      inventory: makeInv([{ name: 'dirt', count: 8 }]),
    });
    const out = surv.tick(makeCtx(world));
    const placeCount = out.filter(r => r.type === 'place_block').length;
    assert.equal(placeCount, 0, '白天不应发 place_block');
    assert.equal(surv.inspect().view && (surv.inspect().view as { mode: string }).mode, 'flee');
  });

  // ── ② 夜晚 + 有方块 → 围 4 块 ───────────────────────────────
  it('UT2 · 夜晚遇怪 + dirt×8 → 发 4 个 place_block', () => {
    const world = makeWorld({
      environment: { dimension: 'overworld', timeOfDay: 14000, isDay: false, isRaining: false },
      entities: [makeHostile('zombie', 10)],
      inventory: makeInv([{ name: 'dirt', count: 8 }]),
    });
    const out = surv.tick(makeCtx(world, 100));
    const placeBlocks = out.filter(r => r.type === 'place_block');
    assert.equal(placeBlocks.length, 4, '应发 4 个 place_block');
    for (const p of placeBlocks) {
      assert.equal(p.target?.itemName, 'dirt');
      assert.equal(p.priority, 95);
      assert.equal(p.timeout_ms, 2000);
      assert.ok(p.target?.referencePosition);
      assert.deepEqual(p.target?.faceVector, { x: 0, y: 1, z: 0 });
    }
    assert.equal((surv.inspect().view as { mode: string }).mode, 'night_shelter');
  });

  // ── ③ 夜晚无方块 → fallback flee ────────────────────────────
  it('UT3 · 夜晚遇怪 + 背包无方块 → flee + say"没方块"', () => {
    const world = makeWorld({
      environment: { dimension: 'overworld', timeOfDay: 14000, isDay: false, isRaining: false },
      entities: [makeHostile('zombie', 10)],
      inventory: makeInv([]),
    });
    const ctx = makeCtx(world);
    const notices: Array<{ topic: string }> = [];
    ctx.narrate = (i) => notices.push(i as { topic: string });
    const out = surv.tick(ctx);
    const placeBlocks = out.filter(r => r.type === 'place_block');
    assert.equal(placeBlocks.length, 0);
    // FEAT-NARR-01：不再发情绪化 say，改为中性事件通知 intent（danger_flee）
    assert.ok(notices.some(n => n.topic === 'danger_flee'), '应上报 danger_flee 中性通知');
    // 应有 invoke_behavior(flee)
    const invokeFlee = out.find(r => r.type === 'invoke_behavior' && (r.target as { behavior?: string })?.behavior === 'flee');
    assert.ok(invokeFlee, '应发 flee invoke_behavior');
  });

  // ── ④ 围完后下一 tick · 静默蹲守 ─────────────────────────────
  it('UT4 · 已围完 · 下一 tick 返回 [] (night_sheltered_idle)', () => {
    const world = makeWorld({
      environment: { dimension: 'overworld', timeOfDay: 14000, isDay: false, isRaining: false },
      entities: [makeHostile('zombie', 10)],
      inventory: makeInv([{ name: 'dirt', count: 8 }]),
    });
    // tick 100 围
    surv.tick(makeCtx(world, 100));
    // tick 101 应静默
    const out = surv.tick(makeCtx(world, 101));
    assert.equal(out.length, 0);
    assert.equal((surv.inspect().view as { mode: string }).mode, 'night_sheltered_idle');
  });

  // ── ⑤ 天亮重置 ────────────────────────────────────────────
  it('UT5 · 天亮 → 重置 nightShelter 状态', () => {
    const nightWorld = makeWorld({
      environment: { dimension: 'overworld', timeOfDay: 14000, isDay: false, isRaining: false },
      entities: [makeHostile('zombie', 10)],
      inventory: makeInv([{ name: 'dirt', count: 8 }]),
    });
    surv.tick(makeCtx(nightWorld, 100)); // 围一次
    const dayWorld = makeWorld({
      environment: { dimension: 'overworld', timeOfDay: 6000, isDay: true, isRaining: false },
      entities: [],
      inventory: makeInv([{ name: 'dirt', count: 8 }]),
    });
    surv.tick(makeCtx(dayWorld, 200));
    // 再回到夜晚遇怪 → 应该重新围（说明状态已重置）
    const out = surv.tick(makeCtx(nightWorld, 300));
    const placeBlocks = out.filter(r => r.type === 'place_block');
    assert.equal(placeBlocks.length, 4, '天亮后再夜晚遇怪应能再次围块');
  });

  // ── ⑥ 濒死优先 flee 不围 ──────────────────────────────────
  it('UT6 · 夜晚 + 濒死(health≤8) → flee_critical 不围', () => {
    const world = makeWorld({
      environment: { dimension: 'overworld', timeOfDay: 14000, isDay: false, isRaining: false },
      entities: [makeHostile('zombie', 10)],
      inventory: makeInv([{ name: 'dirt', count: 8 }]),
      self: {
        position: { x: 100, y: 64, z: 200 },
        yaw: 0,
        pitch: 0,
        health: 4,
        maxHealth: 20,
        food: 20,
        isOnGround: true,
      },
    });
    const out = surv.tick(makeCtx(world));
    const placeBlocks = out.filter(r => r.type === 'place_block');
    assert.equal(placeBlocks.length, 0, '濒死不应围块');
    assert.equal((surv.inspect().view as { mode: string }).mode, 'flee_critical');
  });

  // ── ⑦ cobblestone 优先 dirt ─────────────────────────────
  it('UT7 · cobblestone 优先于 dirt', () => {
    const world = makeWorld({
      environment: { dimension: 'overworld', timeOfDay: 14000, isDay: false, isRaining: false },
      entities: [makeHostile('zombie', 10)],
      inventory: makeInv([
        { name: 'dirt', count: 8 },
        { name: 'cobblestone', count: 8 },
      ]),
    });
    const out = surv.tick(makeCtx(world));
    const places = out.filter(r => r.type === 'place_block');
    assert.equal(places.length, 4);
    for (const p of places) {
      assert.equal(p.target?.itemName, 'cobblestone', 'cobblestone 应优先于 dirt');
    }
  });

  // ── ⑧ count<4 不触发围块 ──────────────────────────────────
  it('UT8 · dirt 只有 3 个 → 不围块（走 flee）', () => {
    const world = makeWorld({
      environment: { dimension: 'overworld', timeOfDay: 14000, isDay: false, isRaining: false },
      entities: [makeHostile('zombie', 10)],
      inventory: makeInv([{ name: 'dirt', count: 3 }]),
    });
    const out = surv.tick(makeCtx(world));
    const places = out.filter(r => r.type === 'place_block');
    assert.equal(places.length, 0, 'count<4 不应围块');
    // 应走 flee 分支
    const fleeReq = out.find(r => r.type === 'invoke_behavior' && (r.target as { behavior?: string })?.behavior === 'flee');
    assert.ok(fleeReq);
  });

  it('FEAT-CROSS-15 · 健康主动战斗不触发通用 flee', () => {
    const world = makeWorld({
      entities: [makeHostile('zombie', 5)],
      inventory: makeInv([{ name: 'stone_sword', count: 1 }]),
    });
    const out = surv.tick(makeCtx(world, 1, 'goal_exec', { combatIntent: true }));
    assert.deepEqual(out, []);
    assert.equal((surv.inspect().view as { mode: string }).mode, 'combat_managed');
  });

  it('FEAT-CROSS-15 · 低血已拉开且有食物时优先 eat', () => {
    const world = makeWorld({
      self: { position: { x: 100, y: 64, z: 200 }, yaw: 0, pitch: 0, health: 6, maxHealth: 20, food: 10, isOnGround: true },
      entities: [makeHostile('zombie', 10)],
      inventory: makeInv([{ name: 'bread', count: 3 }]),
    });
    const out = surv.tick(makeCtx(world, 1, 'goal_exec', { combatIntent: true }));
    assert.equal(out.length, 1);
    assert.equal(out[0].type, 'eat');
    assert.equal(out[0].target?.itemName, 'bread');
  });
});
