import test from 'node:test';
import assert from 'node:assert/strict';

import { executeAtomic, type AtomicContext } from '../../../../../../apps/minecraft-companion/src/bot/v2/atomic/atomics.js';
import type { ActionRequest } from '../../../../../../apps/minecraft-companion/src/bot/v2/types.js';

function request(position: { x: number; y: number; z: number }): ActionRequest {
  return {
    id: 'goto-1', source: 'goto_strategy', type: 'goto_position', priority: 40,
    interrupt_level: 'soft', resource: ['movement'], target: { position }, preconditions: [], timeout_ms: 1000,
  };
}

function gatherRequest(position: { x: number; y: number; z: number }): ActionRequest {
  return {
    ...request(position),
    id: 'gather-approach-1',
    source: 'gather_block',
    type: 'move_to',
  };
}

function context(blocks: Record<string, { name: string; boundingBox: 'block' | 'empty' } | null>) {
  const goals: unknown[] = [];
  const events: Array<{ type: string; payload: unknown }> = [];
  const game = {
    getPosition: () => ({ x: 0, y: 64, z: 0 }),
    getBlockAt: (p: { x: number; y: number; z: number }) => blocks[`${p.x},${p.y},${p.z}`] ?? null,
  };
  const ctx: AtomicContext = {
    game: game as never,
    nav: { goto: async (goal: unknown) => { goals.push(goal); return { ok: true }; } } as never,
    bus: { publish: (type: string, _level: string, payload: unknown) => events.push({ type, payload }) } as never,
  };
  return { ctx, goals, events };
}

test('BUG-CROSS-03：占据目标转为安全邻接落点，原始坐标仍可追溯', async () => {
  const { ctx, goals, events } = context({
    '10,64,20': { name: 'chest', boundingBox: 'block' },
    '11,64,20': { name: 'air', boundingBox: 'empty' },
    '11,65,20': { name: 'air', boundingBox: 'empty' },
    '11,63,20': { name: 'stone', boundingBox: 'block' },
  });
  const result = await executeAtomic(request({ x: 10, y: 64, z: 20 }), ctx);
  assert.equal(result.ok, true);
  assert.deepEqual(goals[0], { type: 'block', position: { x: 11, y: 64, z: 20 }, range: 1 });
  const start = events.find(event => event.type === 'atomic.move_to.start')!.payload as Record<string, unknown>;
  assert.deepEqual(start.originalTarget, { x: 10, y: 64, z: 20 });
  assert.equal(start.normalized, true);
});

test('BUG-CROSS-03：邻点未加载或不安全时保留原目标', async () => {
  const { ctx, goals } = context({ '10,64,20': { name: 'chest', boundingBox: 'block' } });
  await executeAtomic(request({ x: 10, y: 64, z: 20 }), ctx);
  assert.deepEqual(goals[0], { type: 'block', position: { x: 10, y: 64, z: 20 }, range: 1 });
});

test('BUG-CROSS-69：move_to 可选到达半径透传给导航，普通调用仍默认 1', async () => {
  const { ctx, goals } = context({});
  const precise = request({ x: 3, y: 64, z: 0 });
  precise.target = { ...precise.target, range: 0 };
  await executeAtomic(precise, ctx);
  assert.deepEqual(goals[0], { type: 'block', position: { x: 3, y: 64, z: 0 }, range: 0 });
});

test('GoalAgent gather：高位资源和挖后空气都归一化到下方安全落点', async () => {
  for (const targetBoundingBox of ['block', 'empty'] as const) {
    const { ctx, goals } = context({
      '5,-56,5': { name: targetBoundingBox === 'block' ? 'oak_log' : 'air', boundingBox: targetBoundingBox },
      '6,-59,5': { name: 'air', boundingBox: 'empty' },
      '6,-58,5': { name: 'air', boundingBox: 'empty' },
      '6,-60,5': { name: 'stone', boundingBox: 'block' },
    });
    await executeAtomic(gatherRequest({ x: 5, y: -56, z: 5 }), ctx);
    assert.deepEqual(goals[0], { type: 'block', position: { x: 6, y: -59, z: 5 }, range: 1 });
  }
});

test('BUG-CROSS-03：Motor 导航失败原因原样传到原子结果与结束事件', async () => {
  for (const reason of ['unreachable', 'nav_timeout', 'cancelled', 'stall_no_progress']) {
    const events: Array<{ type: string; payload: unknown }> = [];
    const ctx: AtomicContext = {
      game: {
        getPosition: () => ({ x: 0, y: 64, z: 0 }),
        getBlockAt: () => null,
      } as never,
      nav: {} as never,
      motor: {
        run: async () => ({ ok: false, reason }),
      } as never,
      bus: {
        publish: (type: string, _level: string, payload: unknown) => events.push({ type, payload }),
      } as never,
    };

    const result = await executeAtomic(request({ x: 10, y: 64, z: 20 }), ctx);
    assert.equal(result.ok, false);
    assert.equal(result.error, reason);
    const end = events.find(event => event.type === 'atomic.move_to.end')!.payload as { reason?: string };
    assert.equal(end.reason, reason);
  }
});
