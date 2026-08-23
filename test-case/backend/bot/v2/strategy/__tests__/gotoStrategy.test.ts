/**
 * BUG-CROSS-03 · GotoStrategy 任务目标、终距与静默停摆验收。
 */

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { EventBusV2 } from '../../../../../../apps/minecraft-companion/src/bot/v2/infra/eventBus.js';
import { MemoryV2 } from '../../../../../../apps/minecraft-companion/src/bot/v2/infra/memory.js';
import { tuning } from '../../../../../../apps/minecraft-companion/src/bot/v2/infra/tuning.js';
import { TaskRuntime } from '../../../../../../apps/minecraft-companion/src/bot/v2/task/taskRuntime.js';
import type { WorldStateView } from '../../../../../../apps/minecraft-companion/src/bot/v2/types.js';
import { GotoStrategy } from '../../../../../../apps/minecraft-companion/src/bot/v2/strategy/gotoStrategy.js';
import type { StrategyContext } from '../../../../../../apps/minecraft-companion/src/bot/v2/strategy/types.js';

const opened: MemoryV2[] = [];

afterEach(() => {
  for (const memory of opened.splice(0)) memory.close();
});

function world(position: { x: number; y: number; z: number }): WorldStateView {
  return {
    tick: 0,
    timestamp: Date.now(),
    self: {
      position,
      yaw: 0,
      pitch: 0,
      health: 20,
      maxHealth: 20,
      food: 20,
      isOnGround: true,
    },
    owner: null,
    entities: [],
    inventory: { items: [], held: null, freeSlots: 36 },
    environment: { dimension: 'overworld', timeOfDay: 6000, isDay: true, isRaining: false },
    taskContext: null,
  };
}

function harness(targetPosition: { x: number; y: number; z: number }) {
  const bus = new EventBusV2();
  const memory = new MemoryV2(':memory:');
  opened.push(memory);
  const tasks = new TaskRuntime(memory, bus);
  const task = tasks.createTask('goto_position', { targetPosition });
  assert.equal(tasks.start(task.id, world({ x: 0, y: 64, z: 0 })).ok, true);
  return { strategy: new GotoStrategy(bus, tasks), tasks, task };
}

function ctx(
  tick: number,
  position: { x: number; y: number; z: number },
  taskId: string,
): StrategyContext {
  return {
    tick,
    activeTaskId: taskId,
    activeTaskKind: 'goto_position',
    world: world(position),
  };
}

describe('BUG-CROSS-03 · GotoStrategy', () => {
  it('只使用任务 targetPosition 生成导航请求，不受外部当前 goal 影响', () => {
    const target = { x: 18, y: 64, z: -7 };
    const h = harness(target);
    const input = ctx(1, { x: 0, y: 64, z: 0 }, h.task.id) as StrategyContext & { currentGoal?: unknown };
    input.currentGoal = { type: 'block', position: { x: 999, y: 64, z: 999 } };

    const requests = h.strategy.tick(input);

    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0].target?.position, target);
    assert.equal(h.tasks.getById(h.task.id)?.state, 'running');
  });

  it('终距按任务 targetPosition 计算，到达后完成', () => {
    const target = { x: 18, y: 64, z: -7 };
    const h = harness(target);
    const input = ctx(1, { x: 18, y: 80, z: -7 }, h.task.id) as StrategyContext & { currentGoal?: unknown };
    input.currentGoal = { type: 'block', position: { x: 999, y: 64, z: 999 } };

    assert.deepEqual(h.strategy.tick(input), []);
    assert.equal(h.tasks.getById(h.task.id)?.state, 'completed');
  });

  it('active 但距离长期无进展时升级为 unreachable，不静默停摆', () => {
    const h = harness({ x: 100, y: 64, z: 0 });
    const stationary = { x: 0, y: 64, z: 0 };

    for (let tick = 1; tick <= tuning().goto.stallTicks + 2; tick++) {
      h.strategy.tick(ctx(tick, stationary, h.task.id));
    }

    const task = h.tasks.getById(h.task.id);
    assert.equal(task?.state, 'failed');
    assert.equal(task?.failure?.code, 'unreachable');
  });
});
