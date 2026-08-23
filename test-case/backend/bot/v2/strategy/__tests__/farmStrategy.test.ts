/**
 * FarmStrategy · 补充测试（US-DOC-L5）
 *
 * 覆盖：
 *   1. isActive=false 当 activeTaskKind 不是 farm
 *   2. tick：无激活 task → 返回空
 *   3. inspect() phase=idle 当无 task
 *   4. inspect() phase=complete 当 plotsDone>=plots
 *   5. reset() 清零 sinceTick 与 reqSeq
 *   6. place_block.success 源不匹配时不递增 plotsDone
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { FarmStrategy } from '../../../../../../apps/minecraft-companion/src/bot/v2/strategy/farmStrategy.js';
import type { StrategyContext } from '../../../../../../apps/minecraft-companion/src/bot/v2/strategy/types.js';
import type { WorldStateView } from '../../../../../../apps/minecraft-companion/src/bot/v2/types.js';
import type { Task } from '../../../../../../apps/minecraft-companion/src/bot/v2/task/taskRuntime.js';
import type { BusEvent } from '../../../../../../apps/minecraft-companion/src/bot/v2/types.js';

// ──────────────────────────────────────────────────────────────────
// 辅助工厂（同 farmStrategyE3.test.ts 保持一致）
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

function makeCtx(world: WorldStateView, tick = 1, kind: string | null = null): StrategyContext {
  return {
    world,
    tick,
    activeTaskId: kind ? 'task-1' : null,
    activeTaskKind: kind,
  };
}

function makeMockBus() {
  const handlers = new Map<string, Array<(ev: BusEvent) => void>>();
  return {
    publish: () => {},
    on: (type: string, fn: (ev: BusEvent) => void) => {
      if (!handlers.has(type)) handlers.set(type, []);
      handlers.get(type)!.push(fn);
      return () => {};
    },
    onLevel: () => () => {},
    onAny: () => () => {},
    drain: () => [] as BusEvent[],
    emit(type: string, payload: unknown) {
      const ev: BusEvent = { id: 'test-1', type, level: 'info', timestamp: Date.now(), payload };
      handlers.get(type)?.forEach(fn => fn(ev));
    },
  };
}

function makeMockTasks(activeTask: Task | null) {
  return { active: () => activeTask };
}

function makeFarmTask(plotsDone: number, plots: number): Task {
  return {
    id: 'task-1',
    kind: 'farm',
    state: 'running',
    priority: 30,
    preconditions: [],
    params: { seedName: 'wheat_seeds', hoeName: 'wooden_hoe', plots, durabilityPerPlot: 1 },
    createdAt: Date.now(),
    lastActiveTick: 0,
    progress: { plotsDone },
  };
}

// ──────────────────────────────────────────────────────────────────
// 测试
// ──────────────────────────────────────────────────────────────────

describe('FarmStrategy · 补充测试（US-DOC-L5）', () => {

  // ── 1. isActive=false 当 activeTaskKind 不是 farm
  it('isActive：activeTaskKind=follow_owner → false', () => {
    const bus = makeMockBus();
    const tasks = makeMockTasks(null);
    const strategy = new FarmStrategy(bus as never, tasks as never);
    const ctx = makeCtx(makeWorld(), 1, 'follow_owner');
    assert.equal(strategy.isActive(ctx), false);
  });

  // ── 2. tick：无激活 task → 返回空
  it('tick：tasks.active()=null → 返回空数组', () => {
    const bus = makeMockBus();
    const tasks = makeMockTasks(null);
    const strategy = new FarmStrategy(bus as never, tasks as never);
    const ctx = makeCtx(makeWorld(), 1, 'farm');
    const reqs = strategy.tick(ctx);
    assert.equal(reqs.length, 0);
  });

  // ── 3. inspect() phase=idle 当无 task
  it('inspect()：无 task → phase=idle，plotsDone=0，total=0', () => {
    const bus = makeMockBus();
    const tasks = makeMockTasks(null);
    const strategy = new FarmStrategy(bus as never, tasks as never);
    const view = strategy.inspect().view as { phase: string; plotsDone: number; total: number };
    assert.equal(view.phase, 'idle');
    assert.equal(view.plotsDone, 0);
    assert.equal(view.total, 0);
  });

  // ── 4. inspect() phase=complete 当 plotsDone>=plots
  it('inspect()：plotsDone=3, plots=3 → phase=complete', () => {
    const bus = makeMockBus();
    const task = makeFarmTask(3, 3);
    const tasks = makeMockTasks(task);
    const strategy = new FarmStrategy(bus as never, tasks as never);
    const view = strategy.inspect().view as { phase: string; plotsDone: number; total: number };
    assert.equal(view.phase, 'complete');
    assert.equal(view.plotsDone, 3);
    assert.equal(view.total, 3);
  });

  // ── 5. reset() 清零 sinceTick
  it('reset() 后 inspect() sinceTick=0', () => {
    const bus = makeMockBus();
    const task = makeFarmTask(0, 3);
    const tasks = makeMockTasks(task);
    const strategy = new FarmStrategy(bus as never, tasks as never);
    // tick 一次让 sinceTick 被设置
    strategy.tick(makeCtx(makeWorld(), 5, 'farm'));
    strategy.reset();
    const s = strategy.inspect();
    assert.equal(s.sinceTick, 0, 'reset 后 sinceTick 应归零');
  });

  // ── 6. place_block.success 源不匹配时不递增 plotsDone
  it('place_block.success source≠farm_one_plot → plotsDone 不变', () => {
    const bus = makeMockBus();
    const task = makeFarmTask(1, 3);
    const tasks = makeMockTasks(task);
    new FarmStrategy(bus as never, tasks as never);
    // 触发 source 不匹配的事件
    bus.emit('atomic.place_block.success', { source: 'some_other_skill' });
    assert.equal(task.progress!.plotsDone, 1, 'plotsDone 不应改变');
  });
});
