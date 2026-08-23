/**
 * FEAT-L6-03 · complete() 后置验证门单测（防假成功）
 *
 * 覆盖：critic 未注入=直通 · success/unknown 放行 · fail 拒绝+事件+计数 · 3 次转 failed
 * Framework: node:test + node:assert/strict
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { TaskRuntime } from '../../../../../../apps/minecraft-companion/src/bot/v2/task/taskRuntime.js';
import type { IPostconditionValidator, Verdict, VerdictStatus } from '../../../../../../apps/minecraft-companion/src/bot/v2/task/critic/types.js';
import type { Task } from '../../../../../../apps/minecraft-companion/src/bot/v2/task/taskRuntime.js';
import type { WorldStateView } from '../../../../../../apps/minecraft-companion/src/bot/v2/types.js';
import type { EventBusV2 } from '../../../../../../apps/minecraft-companion/src/bot/v2/infra/eventBus.js';
import type { MemoryV2 } from '../../../../../../apps/minecraft-companion/src/bot/v2/infra/memory.js';

// ── mocks ──────────────────────────────────────────────────────────────────

function makeBus(events: Array<{ type: string; payload: unknown }>): EventBusV2 {
  return {
    publish: (type: string, _level: string, payload: unknown) => {
      events.push({ type, payload });
      return { id: '', type, level: 'info' as const, timestamp: 0, payload };
    },
    on: () => () => {},
    onLevel: () => () => {},
    onAny: () => () => {},
    drain: () => [],
  } as unknown as EventBusV2;
}

const mockMemory = {
  scheduleCommit: () => {},
  setRuntime: () => {},
} as unknown as MemoryV2;

function makeWorld(): WorldStateView {
  return {
    tick: 0,
    timestamp: 0,
    self: { position: { x: 0, y: 64, z: 0 }, yaw: 0, pitch: 0, health: 20, maxHealth: 20, food: 20, isOnGround: true },
    owner: null,
    environment: { dimension: 'overworld', timeOfDay: 0, isDay: true, isRaining: false },
    inventory: { items: [], held: null, freeSlots: 36 },
    entities: [],
    taskContext: null,
  };
}

/** 可配置裁决的后置验证器桩 */
function stubValidator(status: VerdictStatus): IPostconditionValidator {
  return {
    verifyPostcondition: (task: Task): Verdict => ({
      taskId: task.id, taskKind: task.kind, status, reason: `stub:${status}`, evaluatedAt: 0,
    }),
  };
}

function runningTask(rt: TaskRuntime): Task {
  const t = rt.createTask('gather_material', { material: 'oak_log', count: 8 });
  const r = rt.start(t.id, makeWorld());
  assert.equal(r.ok, true, 'task should start');
  return t;
}

// ── tests ────────────────────────────────────────────────────────────────────

describe('FEAT-L6-03 · complete() 后置验证门', () => {
  test('未注入 critic → complete 直通（现状兼容）', () => {
    const rt = new TaskRuntime(mockMemory, makeBus([]));
    const t = runningTask(rt);
    rt.complete(t.id);
    assert.equal(rt.getById(t.id)?.state, 'completed');
  });

  test('verify=success → 放行完成', () => {
    const rt = new TaskRuntime(mockMemory, makeBus([]), undefined, stubValidator('success'), () => makeWorld());
    const t = runningTask(rt);
    rt.complete(t.id);
    assert.equal(rt.getById(t.id)?.state, 'completed');
  });

  test('verify=unknown → 放行完成（无验证器不误杀）', () => {
    const rt = new TaskRuntime(mockMemory, makeBus([]), undefined, stubValidator('unknown'), () => makeWorld());
    const t = runningTask(rt);
    rt.complete(t.id);
    assert.equal(rt.getById(t.id)?.state, 'completed');
  });

  test('verify=fail → 拒绝完成 + 发 task.false_success + 保持 running', () => {
    const events: Array<{ type: string; payload: unknown }> = [];
    const rt = new TaskRuntime(mockMemory, makeBus(events), undefined, stubValidator('fail'), () => makeWorld());
    const t = runningTask(rt);
    rt.complete(t.id);
    assert.equal(rt.getById(t.id)?.state, 'running', '应保持 running');
    const fs = events.find(e => e.type === 'task.false_success');
    assert.ok(fs, '应发 task.false_success 事件');
    const p = fs!.payload as { taskId: string; kind: string; reason: string; attempt: number };
    assert.equal(p.taskId, t.id);
    assert.equal(p.kind, 'gather_material');
    assert.equal(p.attempt, 1);
    assert.ok(p.reason);
  });

  test('连续 3 次 fail → 第 3 次转 failed（防死循环）', () => {
    const events: Array<{ type: string; payload: unknown }> = [];
    const rt = new TaskRuntime(mockMemory, makeBus(events), undefined, stubValidator('fail'), () => makeWorld());
    const t = runningTask(rt);
    rt.complete(t.id);
    assert.equal(rt.getById(t.id)?.state, 'running');
    rt.complete(t.id);
    assert.equal(rt.getById(t.id)?.state, 'running');
    rt.complete(t.id);
    assert.equal(rt.getById(t.id)?.state, 'failed', '第 3 次应转 failed');
    const falseSuccessEvents = events.filter(e => e.type === 'task.false_success');
    assert.equal(falseSuccessEvents.length, 3);
    assert.ok(events.find(e => e.type === 'task.failed'), '应发 task.failed');
  });

  test('worldView 返回 null → 跳过验证门（不误杀）', () => {
    const rt = new TaskRuntime(mockMemory, makeBus([]), undefined, stubValidator('fail'), () => null);
    const t = runningTask(rt);
    rt.complete(t.id);
    assert.equal(rt.getById(t.id)?.state, 'completed', 'worldView=null 时门跳过 → 完成');
  });
});
