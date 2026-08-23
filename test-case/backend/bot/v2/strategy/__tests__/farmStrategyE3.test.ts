/**
 * FarmStrategy · US-E3 后行为测试（US-G9）
 *
 * 关键变更（US-E3）：
 *   - place_block.success 监听器只推进 plotsDone，不调 tasks.complete()
 *   - task 完成判定由 Heartbeat Critic 步骤接管
 *
 * 覆盖：
 *   1.  isActive 在 activeTaskKind='farm' 时返回 true
 *   2.  tick：farm 任务 + plotsDone < plots → 返回 invoke_behavior 请求
 *   3.  tick：plotsDone >= plots → 返回 []（不再发出请求）
 *   4.  place_block.success + source='farm_one_plot' → plotsDone+1，不调 tasks.complete
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { FarmStrategy } from '../../../../../../apps/minecraft-companion/src/bot/v2/strategy/farmStrategy.js';
import type { StrategyContext } from '../../../../../../apps/minecraft-companion/src/bot/v2/strategy/types.js';
import type { WorldStateView } from '../../../../../../apps/minecraft-companion/src/bot/v2/types.js';
import type { Task } from '../../../../../../apps/minecraft-companion/src/bot/v2/task/taskRuntime.js';
import type { BusEvent } from '../../../../../../apps/minecraft-companion/src/bot/v2/types.js';

// ──────────────────────────────────────────────────────────────────
// 辅助工厂
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

/** 构建 EventBusV2 精简 mock，支持 on/publish/手动 emit */
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
    /** 手动触发已注册的 type 监听器（模拟 bus 事件） */
    emit(type: string, payload: unknown) {
      const ev: BusEvent = {
        id: 'test-1',
        type,
        level: 'info',
        timestamp: Date.now(),
        payload,
      };
      handlers.get(type)?.forEach(fn => fn(ev));
    },
  };
}

/** 构建最小化 TaskRuntime mock */
function makeMockTasks(activeTask: Task | null) {
  let completeCalled = false;
  return {
    active: () => activeTask,
    complete: (_id: string) => { completeCalled = true; },
    getCompleteCalled: () => completeCalled,
  };
}

/** 构建一个 farm Task */
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

describe('FarmStrategy · US-E3 行为（US-G9）', () => {

  // ── 1. isActive 返回 true 当 activeTaskKind='farm'
  it('isActive：activeTaskKind=farm → true', () => {
    const bus = makeMockBus();
    const tasks = makeMockTasks(null);
    const strategy = new FarmStrategy(bus as never, tasks as never);
    const ctx = makeCtx(makeWorld(), 1, 'farm');
    assert.equal(strategy.isActive(ctx), true);
  });

  // ── 2. tick：farm 任务 + plotsDone < plots → 返回 invoke_behavior
  it('tick：plotsDone < plots → emit invoke_behavior(farm_one_plot)', () => {
    const bus = makeMockBus();
    const task = makeFarmTask(0, 3);
    const tasks = makeMockTasks(task);
    const strategy = new FarmStrategy(bus as never, tasks as never);

    const ctx = makeCtx(makeWorld(), 1, 'farm');
    const reqs = strategy.tick(ctx);

    assert.ok(reqs.length >= 1, '应至少输出 1 个请求');
    const req = reqs.find(r => r.type === 'invoke_behavior');
    assert.ok(req, '应有 invoke_behavior 请求');
    assert.equal(req!.target?.behavior, 'farm_one_plot');
    assert.equal(req!.priority, 30);
  });

  // ── 3. tick：plotsDone >= plots → 返回 []
  it('tick：plotsDone >= plots → 返回空数组（不再发请求）', () => {
    const bus = makeMockBus();
    const task = makeFarmTask(3, 3); // 已完成
    const tasks = makeMockTasks(task);
    const strategy = new FarmStrategy(bus as never, tasks as never);

    const ctx = makeCtx(makeWorld(), 1, 'farm');
    const reqs = strategy.tick(ctx);
    assert.equal(reqs.length, 0);
  });

  // ── 4. place_block.success + source=farm_one_plot → plotsDone+1，不调 tasks.complete
  it('place_block.success 事件（source=farm_one_plot）→ plotsDone 递增，不调 tasks.complete', () => {
    const bus = makeMockBus();
    const task = makeFarmTask(1, 3);
    const tasks = makeMockTasks(task);
    const strategy = new FarmStrategy(bus as never, tasks as never);

    // 触发 place_block.success 事件
    bus.emit('atomic.place_block.success', { source: 'farm_one_plot' });

    // plotsDone 应从 1 变成 2
    assert.equal(task.progress!.plotsDone, 2, 'plotsDone 应被递增');
    // tasks.complete 不应被调用
    assert.equal(tasks.getCompleteCalled(), false, 'US-E3: tasks.complete 不应被调用');

    // inspect 也应反映
    const view = strategy.inspect().view as { plotsDone: number; total: number };
    assert.equal(view.plotsDone, 2);
    assert.equal(view.total, 3);
  });
});
