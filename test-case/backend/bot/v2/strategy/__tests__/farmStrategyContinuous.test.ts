/**
 * FEAT-L7-05 · FarmStrategy continuous 模式测试
 *
 * 覆盖：
 *   1. mode 缺省 → oneshot 行为不变（plotsDone>=plots 返 []）
 *   2. mode=continuous + plotsDone<plots → 继续 invoke_behavior farm_one_plot
 *   3. mode=continuous + plotsDone>=plots + 没成熟 plot → 返 []（waiting_growth）
 *   4. mode=continuous + 某 plot plantedAt 过期 → 输出 dig source=farm_loop
 *   5. mode=continuous + atomic.dig.success(source=farm_loop) → plotsDone-- · totalHarvest++
 *   6. mode=continuous + atomic.place_block.success(source=farm_one_plot) → plotsDone++ · 记录撒种位置
 *   7. atomic.dig.success(source 非 farm_loop) → progress 不变
 *   8. inspect view 包含 mode / phase / totalHarvest
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { FarmStrategy } from '../../../../../../apps/minecraft-companion/src/bot/v2/strategy/farmStrategy.js';
import type { StrategyContext } from '../../../../../../apps/minecraft-companion/src/bot/v2/strategy/types.js';
import type { WorldStateView } from '../../../../../../apps/minecraft-companion/src/bot/v2/types.js';
import type { Task } from '../../../../../../apps/minecraft-companion/src/bot/v2/task/taskRuntime.js';
import type { BusEvent } from '../../../../../../apps/minecraft-companion/src/bot/v2/types.js';

function makeWorld(): WorldStateView {
  return {
    tick: 0,
    timestamp: Date.now(),
    self: { position: { x: 10, y: 64, z: 20 }, yaw: 0, pitch: 0, health: 20, maxHealth: 20, food: 20, isOnGround: true },
    owner: null,
    environment: { dimension: 'overworld', timeOfDay: 6000, isDay: true, isRaining: false },
    inventory: { items: [], held: null, freeSlots: 36 },
    entities: [],
    taskContext: null,
  };
}

function makeCtx(world: WorldStateView, tick = 1, kind: string | null = 'farm'): StrategyContext {
  return {
    world,
    tick,
    activeTaskId: kind ? 'task-1' : null,
    activeTaskKind: kind,
  };
}

function makeMockBus() {
  const handlers = new Map<string, Array<(ev: BusEvent) => void>>();
  const published: Array<{ type: string; payload: unknown }> = [];
  return {
    publish: (type: string, _level: string, payload: unknown) => {
      published.push({ type, payload });
    },
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
    published,
  };
}

function makeMockTasks(activeTask: Task | null) {
  return { active: () => activeTask };
}

function makeFarmTask(opts: {
  plotsDone?: number;
  plots?: number;
  mode?: 'oneshot' | 'continuous';
  growthEstimateSec?: number;
  totalHarvest?: number;
}): Task {
  return {
    id: 'task-1',
    kind: 'farm',
    state: 'running',
    priority: 30,
    preconditions: [],
    params: {
      seedName: 'wheat_seeds',
      hoeName: 'wooden_hoe',
      plots: opts.plots ?? 3,
      durabilityPerPlot: 1,
      mode: opts.mode,
      growthEstimateSec: opts.growthEstimateSec ?? 60,
    },
    createdAt: Date.now(),
    lastActiveTick: 0,
    progress: { plotsDone: opts.plotsDone ?? 0, totalHarvest: opts.totalHarvest ?? 0 },
  };
}

describe('FarmStrategy · continuous 模式（FEAT-L7-05）', () => {

  it('1) mode 缺省 → oneshot 行为不变（plotsDone>=plots → []）', () => {
    const bus = makeMockBus();
    const task = makeFarmTask({ plotsDone: 3, plots: 3 });
    const tasks = makeMockTasks(task);
    const strategy = new FarmStrategy(bus as never, tasks as never);
    const reqs = strategy.tick(makeCtx(makeWorld()));
    assert.equal(reqs.length, 0);
    assert.equal((strategy.inspect().view as { phase: string }).phase, 'complete');
  });

  it('2) continuous + plotsDone<plots → invoke_behavior farm_one_plot', () => {
    const bus = makeMockBus();
    const task = makeFarmTask({ plotsDone: 1, plots: 3, mode: 'continuous' });
    const tasks = makeMockTasks(task);
    const strategy = new FarmStrategy(bus as never, tasks as never);
    const reqs = strategy.tick(makeCtx(makeWorld()));
    assert.equal(reqs.length, 1);
    assert.equal(reqs[0].type, 'invoke_behavior');
    assert.equal(reqs[0].target?.behavior, 'farm_one_plot');
    assert.equal((strategy.inspect().view as { phase: string }).phase, 'planting');
  });

  it('3) continuous + plotsDone>=plots + 没已熟 → 返 [] · phase=waiting_growth', () => {
    const bus = makeMockBus();
    const task = makeFarmTask({ plotsDone: 3, plots: 3, mode: 'continuous' });
    const tasks = makeMockTasks(task);
    const strategy = new FarmStrategy(bus as never, tasks as never);
    const reqs = strategy.tick(makeCtx(makeWorld()));
    assert.equal(reqs.length, 0);
    const view = strategy.inspect().view as { phase: string };
    assert.equal(view.phase, 'waiting_growth');
  });

  it('4) continuous + plot 撒种过期 → 输出 dig source=farm_loop', () => {
    const bus = makeMockBus();
    const task = makeFarmTask({ plotsDone: 0, plots: 1, mode: 'continuous', growthEstimateSec: 1 });
    const tasks = makeMockTasks(task);
    const strategy = new FarmStrategy(bus as never, tasks as never);

    // 先 tick 一次产生撒种 ActionRequest（lastPlannedPos 被缓存）
    const r1 = strategy.tick(makeCtx(makeWorld()));
    assert.equal(r1.length, 1);
    assert.equal(r1[0].type, 'invoke_behavior');

    // 模拟撒种成功 · plotsDone++
    bus.emit('atomic.place_block.success', { source: 'farm_one_plot', item: 'wheat_seeds' });
    assert.equal((task.progress!.plotsDone as number), 1, '撒种成功应 plotsDone++');

    // 等 growthEstimateSec=1 秒 + 极小 buffer，但用回退时间戳避免 sleep
    // 直接把刚记录的 plantedAt 改成过去
    // hack: 取 strategy 内部 map 通过私有访问不行，所以改 task 没用
    // 改为：tick growthEstimateSec=0 即可立即过期
    task.params.growthEstimateSec = 0;

    const r2 = strategy.tick(makeCtx(makeWorld(), 2));
    assert.equal(r2.length, 1, '应输出收割 request');
    assert.equal(r2[0].type, 'dig');
    assert.equal(r2[0].source, 'farm_loop', 'source 必须是 farm_loop · atomic.dig.success 监听器靠它认');
    assert.ok(r2[0].target?.position, 'dig 应带 target.position');
  });

  it('5) atomic.dig.success(source=farm_loop) → plotsDone-- · totalHarvest++', () => {
    const bus = makeMockBus();
    const task = makeFarmTask({ plotsDone: 3, plots: 3, mode: 'continuous', totalHarvest: 0 });
    const tasks = makeMockTasks(task);
    new FarmStrategy(bus as never, tasks as never);

    bus.emit('atomic.dig.success', { source: 'farm_loop', pos: { x: 10, y: 63, z: 21 } });
    assert.equal(task.progress!.plotsDone as number, 2, 'plotsDone 应 --');
    assert.equal(task.progress!.totalHarvest as number, 1, 'totalHarvest 应 ++');
  });

  it('6) atomic.place_block.success(source=farm_one_plot) → plotsDone++ · 记撒种位置（continuous）', () => {
    const bus = makeMockBus();
    const task = makeFarmTask({ plotsDone: 0, plots: 1, mode: 'continuous' });
    const tasks = makeMockTasks(task);
    const strategy = new FarmStrategy(bus as never, tasks as never);

    // 必须先 tick 一次让 lastPlannedPos 缓存
    strategy.tick(makeCtx(makeWorld()));
    bus.emit('atomic.place_block.success', { source: 'farm_one_plot', item: 'wheat_seeds' });

    assert.equal(task.progress!.plotsDone as number, 1);
    const view = strategy.inspect().view as { knownPlots: number };
    assert.equal(view.knownPlots, 1, 'continuous 模式应记下 1 个撒种位置');
  });

  it('7) atomic.dig.success(source 不是 farm_loop) → 不动 progress', () => {
    const bus = makeMockBus();
    const task = makeFarmTask({ plotsDone: 3, plots: 3, mode: 'continuous', totalHarvest: 0 });
    const tasks = makeMockTasks(task);
    new FarmStrategy(bus as never, tasks as never);

    bus.emit('atomic.dig.success', { source: 'gather_strategy', pos: { x: 0, y: 0, z: 0 } });
    assert.equal(task.progress!.plotsDone as number, 3, 'plotsDone 不变');
    assert.equal(task.progress!.totalHarvest as number, 0, 'totalHarvest 不变');
  });

  it('8) oneshot 模式下 dig.success(source=farm_loop) → 不动 progress（防误伤）', () => {
    const bus = makeMockBus();
    const task = makeFarmTask({ plotsDone: 3, plots: 3 /* mode 缺省 oneshot */ });
    const tasks = makeMockTasks(task);
    new FarmStrategy(bus as never, tasks as never);

    bus.emit('atomic.dig.success', { source: 'farm_loop', pos: { x: 0, y: 0, z: 0 } });
    assert.equal(task.progress!.plotsDone as number, 3, 'oneshot 模式 progress 不应被 farm_loop 改');
  });

  it('9) inspect view 含 mode/phase/totalHarvest/knownPlots（continuous）', () => {
    const bus = makeMockBus();
    const task = makeFarmTask({ plotsDone: 3, plots: 3, mode: 'continuous', totalHarvest: 5 });
    const tasks = makeMockTasks(task);
    const strategy = new FarmStrategy(bus as never, tasks as never);
    const view = strategy.inspect().view as Record<string, unknown>;
    assert.equal(view.mode, 'continuous');
    assert.equal(view.phase, 'waiting_growth');
    assert.equal(view.totalHarvest, 5);
    assert.equal(typeof view.knownPlots, 'number');
  });

  it('10) place_block.success 在没 active task 时不抛', () => {
    const bus = makeMockBus();
    const tasks = makeMockTasks(null);
    new FarmStrategy(bus as never, tasks as never);
    // 不应抛
    bus.emit('atomic.place_block.success', { source: 'farm_one_plot' });
    bus.emit('atomic.dig.success', { source: 'farm_loop', pos: { x: 0, y: 0, z: 0 } });
  });
});
