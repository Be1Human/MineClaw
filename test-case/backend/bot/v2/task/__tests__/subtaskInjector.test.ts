/**
 * US-D2 · SubtaskInjector 单元测试
 *
 * 覆盖场景：
 *   ① inject 成功 → 返回 ok=true + subtaskId，父任务变 paused，子任务入栈（isAlive=true）
 *   ② inject 父任务不存在 → ok=false + error
 *   ③ inject 父任务非 running → ok=false + error
 *   ④ 子任务 complete → 父任务自动 resume，发出 task.subtask_done 事件
 *   ⑤ reset_pathfinder kind → 注入后 isAlive true
 *   ⑥ craft_item kind → 子任务 parentId 正确
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { EventBusV2 } from '../../../../../../apps/minecraft-companion/src/bot/v2/infra/eventBus.js';
import { MemoryV2 } from '../../../../../../apps/minecraft-companion/src/bot/v2/infra/memory.js';
import { TaskRuntime } from '../../../../../../apps/minecraft-companion/src/bot/v2/task/taskRuntime.js';
import { SubtaskInjector } from '../../../../../../apps/minecraft-companion/src/bot/v2/task/subtaskInjector.js';

// ─── helpers ─────────────────────────────────────────────────────────────────

/** 最小 WorldStateView（preflight 里 owner_known 只看 world.owner） */
function makeWorld(): Parameters<TaskRuntime['start']>[1] {
  return {
    tick: 0,
    timestamp: Date.now(),
    owner: { username: 'testOwner', position: { x: 0, y: 64, z: 0 }, distance: 0, entityId: 1, isVisible: true },
    self: {
      position: { x: 0, y: 64, z: 0 },
      yaw: 0,
      pitch: 0,
      health: 20,
      maxHealth: 20,
      food: 20,
      isOnGround: true,
    },
    entities: [],
    inventory: { items: [], held: null, freeSlots: 36 },
    environment: {
      dimension: 'overworld',
      timeOfDay: 6000,
      isDay: true,
      isRaining: false,
    },
    taskContext: null,
  };
}

/** 创建一套测试用的基础设施 */
function setup() {
  const bus = new EventBusV2();
  const memory = new MemoryV2(':memory:');
  const tasks = new TaskRuntime(memory, bus);
  const injector = new SubtaskInjector(tasks, bus);
  return { bus, memory, tasks, injector };
}

// ─── 收集 bus 事件 ────────────────────────────────────────────────────────────

function collectEvents(bus: EventBusV2): string[] {
  const types: string[] = [];
  bus.onAny(ev => types.push(ev.type));
  return types;
}

// ─── tests ───────────────────────────────────────────────────────────────────

test('① inject 成功 — 父任务 paused，子任务 isAlive，返回 ok=true', () => {
  const { bus, tasks, injector } = setup();
  const events = collectEvents(bus);

  // 创建并启动父任务
  const parent = tasks.createFollowOwnerTask({ ownerName: 'testOwner' });
  const startResult = tasks.start(parent.id, makeWorld());
  assert.equal(startResult.ok, true, 'parent task should start ok');
  assert.equal(tasks.getById(parent.id)?.state, 'running');

  // 注入子任务
  const result = injector.inject(parent.id, {
    kind: 'fetch_from_chest',
    params: { item: 'wooden_hoe', chestPos: { x: 0, y: 64, z: 0 } },
  });

  assert.equal(result.ok, true, 'inject should succeed');
  assert.ok(result.subtaskId, 'subtaskId should be set');

  // 父任务应变为 paused
  assert.equal(tasks.getById(parent.id)?.state, 'paused', 'parent should be paused');

  // 子任务应在运行中（isAlive）
  assert.equal(injector.isAlive(result.subtaskId!), true, 'subtask should be alive');

  // bus 应有 task.subtask_injected 事件
  assert.ok(events.includes('task.subtask_injected'), 'bus should emit task.subtask_injected');
});

test('② inject — 父任务不存在 → ok=false', () => {
  const { injector } = setup();
  const result = injector.inject('nonexistent-id', {
    kind: 'craft_item',
    params: { item: 'wooden_hoe' },
  });
  assert.equal(result.ok, false);
  assert.ok(result.error?.includes('parent_task_not_found'));
});

test('③ inject — 父任务非 running → ok=false', () => {
  const { tasks, injector } = setup();
  // 创建但不启动（state=pending）
  const parent = tasks.createFollowOwnerTask({ ownerName: 'testOwner' });
  assert.equal(parent.state, 'pending');

  const result = injector.inject(parent.id, {
    kind: 'reset_pathfinder',
    params: {},
  });
  assert.equal(result.ok, false);
  assert.ok(result.error?.includes('parent_task_not_running'));
});

test('④ 子任务 complete → 父任务自动 resume + task.subtask_done 事件', () => {
  const { bus, tasks, injector } = setup();
  const subtaskDoneEvents: string[] = [];
  bus.on('task.subtask_done', () => subtaskDoneEvents.push('done'));
  const taskResumedEvents: string[] = [];
  bus.on('task.resumed', ev => taskResumedEvents.push((ev.payload as { taskId: string }).taskId));

  // 创建并启动父任务
  const parent = tasks.createFollowOwnerTask({ ownerName: 'testOwner' });
  tasks.start(parent.id, makeWorld());

  // 注入子任务
  const result = injector.inject(parent.id, { kind: 'fetch_from_chest', params: {} });
  assert.equal(result.ok, true);
  const subtaskId = result.subtaskId!;

  // 父任务此时 paused
  assert.equal(tasks.getById(parent.id)?.state, 'paused');

  // 完成子任务
  tasks.complete(subtaskId);

  // 子任务状态 completed
  assert.equal(tasks.getById(subtaskId)?.state, 'completed');

  // 父任务应自动 resume
  assert.equal(tasks.getById(parent.id)?.state, 'running', 'parent should auto-resume');

  // 应收到 task.subtask_done 事件
  assert.equal(subtaskDoneEvents.length, 1, 'task.subtask_done should be emitted once');

  // 应收到 task.resumed 事件（for the parent）
  assert.ok(taskResumedEvents.includes(parent.id), 'task.resumed for parent should fire');
});

test('⑤ reset_pathfinder kind — isAlive 正确', () => {
  const { tasks, injector } = setup();
  const parent = tasks.createFollowOwnerTask({ ownerName: 'testOwner' });
  tasks.start(parent.id, makeWorld());

  const result = injector.inject(parent.id, {
    kind: 'reset_pathfinder',
    params: { reason: 'stuck' },
  });

  assert.equal(result.ok, true);
  assert.equal(injector.isAlive(result.subtaskId!), true);

  const subtask = tasks.getById(result.subtaskId!);
  assert.equal(subtask?.kind, 'reset_pathfinder');
  assert.equal(subtask?.params.reason, 'stuck');
});

test('⑥ craft_item kind — parentId 正确写入子任务', () => {
  const { tasks, injector } = setup();
  const parent = tasks.createFollowOwnerTask({ ownerName: 'testOwner' });
  tasks.start(parent.id, makeWorld());

  const result = injector.inject(parent.id, {
    kind: 'craft_item',
    params: { item: 'wooden_hoe' },
    priority: 60,
  });

  assert.equal(result.ok, true);

  const subtask = tasks.getById(result.subtaskId!);
  assert.equal(subtask?.parentId, parent.id, 'subtask.parentId should point to parent');
  assert.equal(subtask?.kind, 'craft_item');
  assert.equal(subtask?.priority, 60, 'custom priority should be respected');
});

test('⑦ isAlive — 子任务 complete 后返回 false', () => {
  const { tasks, injector } = setup();
  const parent = tasks.createFollowOwnerTask({ ownerName: 'testOwner' });
  tasks.start(parent.id, makeWorld());

  const result = injector.inject(parent.id, { kind: 'fetch_from_chest', params: {} });
  const subtaskId = result.subtaskId!;

  assert.equal(injector.isAlive(subtaskId), true);
  tasks.complete(subtaskId);
  assert.equal(injector.isAlive(subtaskId), false, 'completed task should not be alive');
});
