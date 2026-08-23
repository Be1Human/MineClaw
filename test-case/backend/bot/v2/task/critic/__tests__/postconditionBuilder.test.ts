/**
 * FEAT-L6-03 阶段二 · 声明式后置验证器单测
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildPostconditionFn } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/critic/postconditionBuilder.js';
import type { PostconditionSpec } from '../../../../../../../apps/minecraft-companion/src/bot/v2/knowledge/types.js';
import type { Task } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/taskRuntime.js';
import type { WorldStateView } from '../../../../../../../apps/minecraft-companion/src/bot/v2/types.js';
import type { InventoryItemView } from '../../../../../../../apps/minecraft-companion/src/bot/v2/types.js';

function task(kind: string, params: Record<string, unknown>): Task {
  return {
    id: 't1', kind, state: 'running', priority: 30, preconditions: [],
    params, createdAt: 0, lastActiveTick: 0,
  };
}

function worldWith(items: Array<{ name: string; count: number }>): WorldStateView {
  const inv: InventoryItemView[] = items.map((it, i) => ({ name: it.name, count: it.count, slot: i }));
  return {
    tick: 0, timestamp: 0,
    self: { position: { x: 0, y: 64, z: 0 }, yaw: 0, pitch: 0, health: 20, maxHealth: 20, food: 20, isOnGround: true },
    owner: null,
    environment: { dimension: 'overworld', timeOfDay: 0, isDay: true, isRaining: false },
    inventory: { items: inv, held: null, freeSlots: 36 },
    entities: [], taskContext: null,
  };
}

const gatherSpec: PostconditionSpec[] = [
  { type: 'inventory_gte', item: { fromSlot: 'material' }, count: { fromSlot: 'count', default: 8 } },
];
const craftSpec: PostconditionSpec[] = [
  { type: 'inventory_gte', item: { fromSlot: 'item' }, count: { fromSlot: 'count', default: 1 } },
];

describe('FEAT-L6-03 阶段二 · buildPostconditionFn', () => {
  test('gather 达标 → success', () => {
    const fn = buildPostconditionFn(gatherSpec);
    const v = fn(task('gather_material', { material: 'oak_log', count: 4 }), worldWith([{ name: 'oak_log', count: 4 }]));
    assert.equal(v.status, 'success');
  });

  test('gather 未达标 → fail', () => {
    const fn = buildPostconditionFn(gatherSpec);
    const v = fn(task('gather_material', { material: 'oak_log', count: 4 }), worldWith([{ name: 'oak_log', count: 2 }]));
    assert.equal(v.status, 'fail');
  });

  test('gather 木头模式：混合原木求和达标 → success', () => {
    const fn = buildPostconditionFn(gatherSpec);
    const v = fn(
      task('gather_material', { material: 'oak_log', count: 4 }),
      worldWith([{ name: 'oak_log', count: 2 }, { name: 'birch_log', count: 2 }]),
    );
    assert.equal(v.status, 'success', '全原木求和应达标');
  });

  test('gather count 缺省=8', () => {
    const fn = buildPostconditionFn(gatherSpec);
    assert.equal(fn(task('gather_material', { material: 'oak_log' }), worldWith([{ name: 'oak_log', count: 8 }])).status, 'success');
    assert.equal(fn(task('gather_material', { material: 'oak_log' }), worldWith([{ name: 'oak_log', count: 7 }])).status, 'fail');
  });

  test('craft 产物入包 → success / 未入包 → fail', () => {
    const fn = buildPostconditionFn(craftSpec);
    assert.equal(fn(task('craft_item', { item: 'wooden_pickaxe' }), worldWith([{ name: 'wooden_pickaxe', count: 1 }])).status, 'success');
    assert.equal(fn(task('craft_item', { item: 'wooden_pickaxe' }), worldWith([])).status, 'fail');
  });

  test('空 specs → unknown（放行）', () => {
    assert.equal(buildPostconditionFn([])(task('x', {}), worldWith([])).status, 'unknown');
  });
});
