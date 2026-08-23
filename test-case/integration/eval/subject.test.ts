import test from 'node:test';
import assert from 'node:assert/strict';
import { Subject } from '../../../benchmark/engineering/core/subject.js';
import type { ActionRequest } from '../../../apps/minecraft-companion/src/bot/v2/types.js';

test('BUG-CROSS-06 · 同一 repeat 只建一个 running 任务并复用 taskId', () => {
  const submitted: ActionRequest[] = [];
  let createCount = 0;
  const running = new Set<string>();
  const subject = new Subject({
    host: '127.0.0.1', port: 25565, username: 'EvalSubject', auth: 'offline',
    ownerName: 'EvalDirector', anchor: { x: 1000, y: 120, z: 1000 },
  });
  Object.defineProperty(subject, 'v2', { value: {
    tasks: {
      isRunning: (id: string) => running.has(id),
      createTask: () => ({ id: `task-${++createCount}` }),
      start: (id: string) => { running.add(id); return { ok: true }; },
    },
    perception: { perceive: () => ({}) },
    heart: { submitRequest: (req: ActionRequest) => { submitted.push(req); } },
  } });

  subject.injectMove({ x: 10, y: 64, z: 10 });
  subject.injectMove({ x: 20, y: 64, z: 20 });

  assert.equal(createCount, 1);
  assert.equal(submitted.length, 2);
  assert.equal(submitted[0]?.taskId, 'task-1');
  assert.equal(submitted[1]?.taskId, 'task-1');
});

test('BUG-CROSS-06 · 任务不再 running 时下一次注入会重建背书', () => {
  const submitted: ActionRequest[] = [];
  let createCount = 0;
  const running = new Set<string>();
  const subject = new Subject({
    host: '127.0.0.1', port: 25565, username: 'EvalSubject', auth: 'offline',
    ownerName: 'EvalDirector', anchor: { x: 1000, y: 120, z: 1000 },
  });
  Object.defineProperty(subject, 'v2', { value: {
    tasks: {
      isRunning: (id: string) => running.has(id),
      createTask: () => ({ id: `task-${++createCount}` }),
      start: (id: string) => { running.add(id); return { ok: true }; },
    },
    perception: { perceive: () => ({}) },
    heart: { submitRequest: (req: ActionRequest) => { submitted.push(req); } },
  } });

  subject.injectMove({ x: 10, y: 64, z: 10 });
  running.clear();
  subject.injectMove({ x: 20, y: 64, z: 20 });

  assert.equal(createCount, 2);
  assert.deepEqual(submitted.map(req => req.taskId), ['task-1', 'task-2']);
});

test('BUG-CROSS-26 · reset 经统一入口取消执行并等待收敛', async () => {
  const calls: string[] = [];
  const subject = new Subject({
    host: '127.0.0.1', port: 25565, username: 'EvalSubject', auth: 'offline',
    ownerName: 'EvalDirector', anchor: { x: 1000, y: 120, z: 1000 },
  });
  Object.defineProperty(subject, 'v2', { value: {
    cancelActiveTasks: (reason: string) => { calls.push(`cancel:${reason}`); return 1; },
  } });
  Object.defineProperty(subject as unknown as { conn: unknown }, 'conn', { value: {
    navAdapter: { stop: () => { calls.push('nav.stop'); } },
  } });
  Object.defineProperty(subject as unknown as { moveTaskId: string | null }, 'moveTaskId', {
    value: 'task-old', writable: true,
  });
  Object.defineProperty(subject as unknown as { diedInRun: boolean }, 'diedInRun', {
    value: true, writable: true,
  });

  const reset = subject.reset();
  calls.push('after-call');
  await reset;
  calls.push('after-await');

  assert.deepEqual(calls, ['cancel:eval_reset', 'nav.stop', 'after-call', 'after-await']);
  assert.equal((subject as unknown as { moveTaskId: string | null }).moveTaskId, null);
  assert.equal(subject.hasDiedSinceReset(), false, 'reset 必须清除上一 repeat 的死亡锁存');
});
