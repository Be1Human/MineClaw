/**
 * FEAT-L7-03 · IdleTriggers 单元测试
 *
 * 覆盖：
 *   1. 已有 running 任务 → 短路返回 null
 *   2. T-LOW-HP（仅 say · 不 createTask）
 *   3. T-NIGHT-SHELTER
 *   4. T-LOW-FOOD 已禁用 → 即使满足条件也返回 null（走 LLM IDLE turn）
 *   5. T-GATHER-WOOD 已禁用 → 即使满足条件也返回 null（走 LLM IDLE turn）
 *   6. 全 miss → 返回 null（让 LLM IDLE turn 接手）
 *   7. 优先级：HP 满足 → 取 T-LOW-HP（T-LOW-FOOD/T-GATHER-WOOD 已禁用）
 *   8. createTask 相关场景：两 trigger 已禁用，不再调用 createTask
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { evaluateIdleTriggers, type IdleContextSnapshot, type IdleTriggerDeps } from '../../../../../../apps/minecraft-companion/src/bot/v2/decision/idleTriggers.js';
import type { WorldStateView, BusEvent } from '../../../../../../apps/minecraft-companion/src/bot/v2/types.js';
import type { Task } from '../../../../../../apps/minecraft-companion/src/bot/v2/task/taskRuntime.js';

// ──────────────────────────────────────────────────────────────────
// 工厂
// ──────────────────────────────────────────────────────────────────

function makeWorld(): WorldStateView {
  return {
    tick: 0,
    timestamp: Date.now(),
    self: { position: { x: 0, y: 64, z: 0 }, yaw: 0, pitch: 0, health: 20, maxHealth: 20, food: 20, isOnGround: true },
    owner: null,
    environment: { dimension: 'overworld', timeOfDay: 6000, isDay: true, isRaining: false },
    inventory: { items: [], held: null, freeSlots: 36 },
    entities: [],
    taskContext: null,
  };
}

function makeCtx(over: Partial<IdleContextSnapshot> = {}): IdleContextSnapshot {
  return {
    pos: { x: 0, y: 64, z: 0 },
    hp: 20,
    food: 20,
    isDay: true,
    timeOfDay: 6000,
    invBrief: [],
    threats: [],
    ...over,
  };
}

interface BusRec { type: string; payload: unknown }

function makeMockBus(rec: BusRec[]) {
  return {
    publish: (type: string, _level: string, payload: unknown) => { rec.push({ type, payload }); },
    on: () => () => {},
    onLevel: () => () => {},
    onAny: () => () => {},
    drain: () => [] as BusEvent[],
  };
}

interface TaskRec { kind: string; params: Record<string, unknown>; id: string }

function makeMockTasks(opts: {
  startOk?: boolean;
  startReason?: string;
  createThrows?: boolean;
}): { runtime: IdleTriggerDeps['tasks']; created: TaskRec[]; started: string[] } {
  const created: TaskRec[] = [];
  const started: string[] = [];
  let seq = 0;
  const runtime = {
    createTask: (kind: string, params: Record<string, unknown>) => {
      if (opts.createThrows) throw new Error('mock create failed');
      const id = `task-${++seq}`;
      created.push({ kind, params, id });
      return { id, kind, params, state: 'pending' } as unknown as Task;
    },
    start: (id: string) => {
      if (opts.startOk === false) return { ok: false, reason: opts.startReason ?? 'mock_start_failed' };
      started.push(id);
      return { ok: true };
    },
    fail: () => {},
  } as unknown as IdleTriggerDeps['tasks'];
  return { runtime, created, started };
}

function makeDeps(over: {
  runningCount?: number;
  startOk?: boolean;
  createThrows?: boolean;
  busRec?: BusRec[];
} = {}): {
  deps: IdleTriggerDeps;
  busRec: BusRec[];
  created: TaskRec[];
  started: string[];
} {
  const busRec = over.busRec ?? [];
  const tasksMock = makeMockTasks({ startOk: over.startOk, createThrows: over.createThrows });
  const deps: IdleTriggerDeps = {
    bus: makeMockBus(busRec) as unknown as IdleTriggerDeps['bus'],
    tasks: tasksMock.runtime,
    getRunningTaskCount: () => over.runningCount ?? 0,
    getWorldState: () => makeWorld(),
    log: () => {},
  };
  return { deps, busRec, created: tasksMock.created, started: tasksMock.started };
}

// ──────────────────────────────────────────────────────────────────
// 测试
// ──────────────────────────────────────────────────────────────────

describe('IdleTriggers · FEAT-L7-03', () => {

  it('1) 已有 running 任务 → 短路返回 null', () => {
    const { deps, created } = makeDeps({ runningCount: 1 });
    const ctx = makeCtx({
      invBrief: [{ name: 'wheat_seeds', count: 16 }, { name: 'wooden_hoe', count: 1 }],
      food: 0,
    });
    const r = evaluateIdleTriggers(ctx, deps);
    assert.equal(r, null);
    assert.equal(created.length, 0, '不应创建任务');
  });

  it('2) T-LOW-HP：hp<8 且有食物 → say_only · 不 createTask', () => {
    const { deps, busRec, created } = makeDeps();
    const ctx = makeCtx({
      hp: 4,
      invBrief: [{ name: 'bread', count: 2 }],
    });
    const r = evaluateIdleTriggers(ctx, deps);
    assert.ok(r);
    assert.equal(r!.triggerId, 'T-LOW-HP');
    assert.equal(r!.action, 'say_only');
    assert.equal(r!.cooldownMs, 60_000);
    assert.equal(created.length, 0, 'T-LOW-HP 不应 createTask');
    // FEAT-NARR-01：删假话后不再发 atomic.say（hp 低此前仅 say 未真吃）
    assert.ok(!busRec.some(e => e.type === 'atomic.say'), '删假话后不应再发 atomic.say');
  });

  it('3) T-NIGHT-SHELTER：夜里且 timeOfDay>=13000 → say_only', () => {
    const { deps, busRec, created } = makeDeps();
    const ctx = makeCtx({
      isDay: false,
      timeOfDay: 13500,
    });
    const r = evaluateIdleTriggers(ctx, deps);
    assert.ok(r);
    assert.equal(r!.triggerId, 'T-NIGHT-SHELTER');
    assert.equal(r!.action, 'say_only');
    assert.equal(created.length, 0);
    assert.ok(!busRec.some(e => e.type === 'atomic.say'), 'FEAT-NARR-01：删假话后不应再发 atomic.say');
  });

  it('4) T-LOW-FOOD 已禁用：缺粮+有种子+有锄头 → null（走 LLM IDLE turn）', () => {
    const { deps, created } = makeDeps();
    const ctx = makeCtx({
      invBrief: [
        { name: 'wheat_seeds', count: 16 },
        { name: 'stone_hoe', count: 1 },
      ],
    });
    const r = evaluateIdleTriggers(ctx, deps);
    assert.equal(r, null, 'T-LOW-FOOD 已禁用，应回落 LLM IDLE turn');
    assert.equal(created.length, 0);
  });

  it('5) T-GATHER-WOOD 已禁用：木头≤4 且白天 → null（走 LLM IDLE turn）', () => {
    const { deps, created } = makeDeps();
    const ctx = makeCtx({
      invBrief: [
        { name: 'oak_log', count: 2 },
        { name: 'bread', count: 5 },
      ],
    });
    const r = evaluateIdleTriggers(ctx, deps);
    assert.equal(r, null, 'T-GATHER-WOOD 已禁用，应回落 LLM IDLE turn');
    assert.equal(created.length, 0);
  });

  it('6) 全 miss：hp 满 + 食物多 + 木头多 + 白天 → 返回 null', () => {
    const { deps, created } = makeDeps();
    const ctx = makeCtx({
      hp: 20,
      isDay: true,
      timeOfDay: 6000,
      invBrief: [
        { name: 'bread', count: 10 },
        { name: 'oak_log', count: 20 },
      ],
    });
    const r = evaluateIdleTriggers(ctx, deps);
    assert.equal(r, null);
    assert.equal(created.length, 0);
  });

  it('7) 优先级：HP+FOOD+WOOD 同时满足 → 取 T-LOW-HP', () => {
    const { deps, created, busRec } = makeDeps();
    const ctx = makeCtx({
      hp: 3,  // 满足 HP
      invBrief: [
        { name: 'bread', count: 1 },     // 食物 < 3（满足 LOW-FOOD 食物部分）
        { name: 'wheat_seeds', count: 16 },
        { name: 'wooden_hoe', count: 1 },
        // 木头 0 → 满足 WOOD
      ],
    });
    const r = evaluateIdleTriggers(ctx, deps);
    assert.ok(r);
    assert.equal(r!.triggerId, 'T-LOW-HP', '高优先 HP 应胜出');
    assert.equal(created.length, 0, 'HP trigger 不 createTask');
    assert.ok(!busRec.some(e => e.type === 'atomic.say'), 'FEAT-NARR-01：删假话后不应再发 atomic.say');
  });

  it('8) createTask 不会被调用：两 trigger 已禁用 → null', () => {
    const { deps, created } = makeDeps({ createThrows: true });
    const ctx = makeCtx({
      invBrief: [
        { name: 'wheat_seeds', count: 16 },
        { name: 'wooden_hoe', count: 1 },
      ],
    });
    const r = evaluateIdleTriggers(ctx, deps);
    assert.equal(r, null);
    assert.equal(created.length, 0, '禁用后不应调用 createTask');
  });

  it('9) tasks.start 不会被调用：两 trigger 已禁用 → null', () => {
    const { deps, created, started } = makeDeps({ startOk: false, busRec: [] });
    const ctx = makeCtx({
      invBrief: [
        { name: 'wheat_seeds', count: 16 },
        { name: 'wooden_hoe', count: 1 },
      ],
    });
    const r = evaluateIdleTriggers(ctx, deps);
    assert.equal(r, null);
    assert.equal(created.length, 0);
    assert.equal(started.length, 0);
  });

  it('10) hp<8 没食物 → T-LOW-HP 不响应，T-LOW-FOOD 禁用 → null（走 LLM IDLE turn）', () => {
    const { deps } = makeDeps();
    const ctx = makeCtx({
      hp: 3,
      invBrief: [
        { name: 'wheat_seeds', count: 16 },
        { name: 'wooden_hoe', count: 1 },
      ],
    });
    const r = evaluateIdleTriggers(ctx, deps);
    assert.equal(r, null, 'T-LOW-FOOD 禁用，应回落 LLM IDLE turn');
  });

  // ── T-GATHER-WOOD/T-LOW-FOOD 已禁用：以下验证禁用后的行为 ────────────
  it('11) T-GATHER-WOOD 禁用：有威胁也好无威胁也好 → null（不发 trigger_skipped）', () => {
    const { deps, created, busRec } = makeDeps();
    const ctx = makeCtx({
      invBrief: [{ name: 'oak_log', count: 2 }, { name: 'bread', count: 5 }],
      threats: [{ name: 'zombie', distance: 10 }],
    });
    const r = evaluateIdleTriggers(ctx, deps);
    assert.equal(r, null);
    assert.equal(created.length, 0);
    assert.ok(!busRec.some(e => e.type === 'l7.idle_trigger_skipped'), '禁用后不发 trigger_skipped');
  });

  it('12) T-GATHER-WOOD 禁用：无威胁 → 仍然 null', () => {
    const { deps, created } = makeDeps();
    const ctx = makeCtx({
      invBrief: [{ name: 'oak_log', count: 2 }, { name: 'bread', count: 5 }],
      threats: [{ name: 'zombie', distance: 20 }],
    });
    const r = evaluateIdleTriggers(ctx, deps);
    assert.equal(r, null);
    assert.equal(created.length, 0);
  });

  it('13) outcomes 不影响已禁用的 trigger → null', () => {
    const { deps, created, busRec } = makeDeps();
    deps.outcomes = {
      consult: () => ({ allow: true }),
      record: () => {},
      noteTerminal: () => {},
      blockAll: () => {},
    } as unknown as IdleTriggerDeps['outcomes'];
    const ctx = makeCtx({
      invBrief: [{ name: 'oak_log', count: 2 }, { name: 'bread', count: 5 }],
    });
    const r = evaluateIdleTriggers(ctx, deps);
    assert.equal(r, null, '触发器已禁用，outcomes 无效果');
    assert.equal(created.length, 0);
    assert.ok(!busRec.some(e => e.type === 'l7.idle_trigger_fired'));
  });

  it('14) T-GATHER-WOOD 禁用后 outcomes.record 不会被调用', () => {
    const recorded: Array<{ triggerId: string; taskId: string }> = [];
    const { deps } = makeDeps();
    deps.outcomes = {
      consult: () => ({ allow: true }),
      record: (triggerId: string, taskId: string) => { recorded.push({ triggerId, taskId }); },
      noteTerminal: () => {},
      blockAll: () => {},
    } as unknown as IdleTriggerDeps['outcomes'];
    const ctx = makeCtx({
      invBrief: [{ name: 'oak_log', count: 2 }, { name: 'bread', count: 5 }],
    });
    const r = evaluateIdleTriggers(ctx, deps);
    assert.equal(r, null);
    assert.equal(recorded.length, 0, '禁用后 outcomes.record 不应被调用');
  });
});
