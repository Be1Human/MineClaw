/**
 * TC-WEBUI · assembleWorldUiView 单元测试
 *
 * 覆盖：威胁分级 · blocks 映射 · navigation 状态派生 · 空入参安全默认值
 * AC2/AC7 静态检查：验证 runtime.ts / server.ts 中 v1 符号已移除
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assembleWorldUiView } from '../../../../apps/minecraft-companion/src/bot/runtime.js';
import type { EntityView } from '../../../../apps/minecraft-companion/src/bot/v2/types.js';
import type { SpatialEntry } from '../../../../apps/minecraft-companion/src/bot/v2/infra/memory.js';
import type { Task } from '../../../../apps/minecraft-companion/src/bot/v2/task/taskRuntime.js';

// ─── helpers ─────────────────────────────────────────────────────────────────

const __dir = dirname(fileURLToPath(import.meta.url));
const SRC = join(__dir, '..', '..', '..', '..', 'apps', 'minecraft-companion', 'src');

function makeEntity(overrides: Partial<EntityView> = {}): EntityView {
  return {
    id: 1,
    name: 'Zombie',
    type: 'mob',
    position: { x: 0, y: 64, z: 0 },
    distance: 10,
    category: 'hostile',
    ...overrides,
  };
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    kind: 'follow_owner',
    state: 'running',
    priority: 50,
    preconditions: [],
    params: {},
    createdAt: Date.now(),
    lastActiveTick: 0,
    ...overrides,
  };
}

function makeSpatial(overrides: Partial<SpatialEntry> = {}): SpatialEntry {
  return {
    kind: 'chest',
    position: { x: 10, y: 64, z: 10 },
    timestamp: Date.now(),
    ...overrides,
  };
}

// ─── assembleWorldUiView ──────────────────────────────────────────────────────

describe('assembleWorldUiView', () => {

  test('TC-WEBUI-01 · 空入参 → 安全默认值', () => {
    const view = assembleWorldUiView(undefined, [], []);
    assert.equal(view.tick, 0);
    assert.equal(view.self, null);
    assert.deepEqual(view.entities, []);
    assert.deepEqual(view.threats, []);
    assert.deepEqual(view.blocks, []);
    assert.equal(view.navigation.hasGoal, false);
    assert.equal(view.navigation.status, 'idle');
    assert.equal(view.navigation.goalPosition, null);
    assert.ok(typeof view.timestamp === 'number');
    // environment 有合理默认值
    assert.equal(view.environment.dimension, 'overworld');
    assert.equal(view.environment.isDay, true);
    assert.equal(view.environment.isRaining, false);
  });

  test('TC-WEBUI-02 · hostile 距离 3m → severity=high', () => {
    const view = assembleWorldUiView(
      { tick: 5, timestamp: 0, self: null as never, owner: null, environment: { dimension: 'overworld', timeOfDay: 6000, isDay: true, isRaining: false }, entities: [makeEntity({ distance: 3 })], inventory: { items: [], held: null, freeSlots: 36 }, taskContext: null },
      [], [],
    );
    assert.equal(view.threats.length, 1);
    assert.equal(view.threats[0].severity, 'high');
    assert.equal(view.threats[0].distance, 3);
    assert.equal(view.threats[0].entityId, 1);
    assert.equal(view.threats[0].description, 'Zombie');
  });

  test('TC-WEBUI-03 · hostile 距离 7m → severity=medium', () => {
    const view = assembleWorldUiView(
      { tick: 5, timestamp: 0, self: null as never, owner: null, environment: { dimension: 'overworld', timeOfDay: 6000, isDay: true, isRaining: false }, entities: [makeEntity({ distance: 7 })], inventory: { items: [], held: null, freeSlots: 36 }, taskContext: null },
      [], [],
    );
    assert.equal(view.threats[0].severity, 'medium');
  });

  test('TC-WEBUI-04 · hostile 距离 15m → severity=low', () => {
    const view = assembleWorldUiView(
      { tick: 5, timestamp: 0, self: null as never, owner: null, environment: { dimension: 'overworld', timeOfDay: 6000, isDay: true, isRaining: false }, entities: [makeEntity({ distance: 15 })], inventory: { items: [], held: null, freeSlots: 36 }, taskContext: null },
      [], [],
    );
    assert.equal(view.threats[0].severity, 'low');
  });

  test('TC-WEBUI-05 · passive/player 实体 → 不计入 threats', () => {
    const entities = [
      makeEntity({ id: 1, category: 'passive', name: 'Cow', distance: 2 }),
      makeEntity({ id: 2, category: 'player', name: 'qxy', distance: 3 }),
    ];
    const view = assembleWorldUiView(
      { tick: 1, timestamp: 0, self: null as never, owner: null, environment: { dimension: 'overworld', timeOfDay: 0, isDay: true, isRaining: false }, entities, inventory: { items: [], held: null, freeSlots: 36 }, taskContext: null },
      [], [],
    );
    assert.equal(view.threats.length, 0);
    assert.equal(view.entities.length, 2); // 仍出现在 entities
  });

  test('TC-WEBUI-06 · 多个 hostile → 多条 threats，各自分级', () => {
    const entities = [
      makeEntity({ id: 1, name: 'Zombie', distance: 3, category: 'hostile' }),
      makeEntity({ id: 2, name: 'Skeleton', distance: 8, category: 'hostile' }),
      makeEntity({ id: 3, name: 'Enderman', distance: 20, category: 'hostile' }),
    ];
    const view = assembleWorldUiView(
      { tick: 1, timestamp: 0, self: null as never, owner: null, environment: { dimension: 'overworld', timeOfDay: 0, isDay: false, isRaining: false }, entities, inventory: { items: [], held: null, freeSlots: 36 }, taskContext: null },
      [], [],
    );
    assert.equal(view.threats.length, 3);
    assert.equal(view.threats.find(t => t.entityId === 1)?.severity, 'high');
    assert.equal(view.threats.find(t => t.entityId === 2)?.severity, 'medium');
    assert.equal(view.threats.find(t => t.entityId === 3)?.severity, 'low');
  });

  test('TC-WEBUI-07 · spatial 记忆 → blocks 数组正确映射', () => {
    const spatial: SpatialEntry[] = [
      makeSpatial({ kind: 'chest', position: { x: 10, y: 64, z: 10 }, meta: { blockName: 'chest' } }),
      makeSpatial({ kind: 'resource', position: { x: 5, y: 63, z: 5 }, meta: {} }),
    ];
    const view = assembleWorldUiView(undefined, spatial, []);
    assert.equal(view.blocks.length, 2);
    assert.equal(view.blocks[0].name, 'chest');
    assert.equal(view.blocks[0].category, 'chest');
    assert.deepEqual(view.blocks[0].position, { x: 10, y: 64, z: 10 });
    assert.equal(view.blocks[0].exposedAny, false);
    // kind 当 name fallback（无 blockName meta）
    assert.equal(view.blocks[1].name, 'resource');
  });

  test('TC-WEBUI-08 · 无运行任务 → navigation.hasGoal=false, status=idle', () => {
    const view = assembleWorldUiView(undefined, [], []);
    assert.equal(view.navigation.hasGoal, false);
    assert.equal(view.navigation.status, 'idle');
    assert.equal(view.navigation.goalPosition, null);
    assert.equal(view.navigation.path, null);
    assert.equal(view.navigation.plannedRoute, null);
  });

  test('TC-WEBUI-09 · follow_owner 运行中 → hasGoal=true, status=following', () => {
    const view = assembleWorldUiView(undefined, [], [makeTask({ kind: 'follow_owner' })]);
    assert.equal(view.navigation.hasGoal, true);
    assert.equal(view.navigation.status, 'following');
  });

  test('TC-WEBUI-10 · follow_entity 运行中 → status=following', () => {
    const view = assembleWorldUiView(undefined, [], [makeTask({ kind: 'follow_entity' })]);
    assert.equal(view.navigation.status, 'following');
  });

  test('TC-WEBUI-11 · move_to 运行中 → status=moving, goalPosition 正确', () => {
    const pos = { x: 100, y: 64, z: -50 };
    const view = assembleWorldUiView(
      undefined, [],
      [makeTask({ kind: 'move_to', params: { position: pos } })],
    );
    assert.equal(view.navigation.hasGoal, true);
    assert.equal(view.navigation.status, 'moving');
    assert.deepEqual(view.navigation.goalPosition, pos);
  });

  test('TC-WEBUI-12 · 非导航任务（farm）运行中 → navigation 仍 idle', () => {
    const view = assembleWorldUiView(undefined, [], [makeTask({ kind: 'farm' })]);
    assert.equal(view.navigation.hasGoal, false);
    assert.equal(view.navigation.status, 'idle');
  });

  test('TC-WEBUI-13 · tick / entities 字段从 ws 正确透传', () => {
    const entity = makeEntity({ id: 42, name: 'Creeper', category: 'hostile', distance: 6 });
    const view = assembleWorldUiView(
      { tick: 99, timestamp: 0, self: null as never, owner: null, environment: { dimension: 'nether', timeOfDay: 0, isDay: false, isRaining: false }, entities: [entity], inventory: { items: [], held: null, freeSlots: 36 }, taskContext: null },
      [], [],
    );
    assert.equal(view.tick, 99);
    assert.equal(view.entities.length, 1);
    assert.equal(view.entities[0].id, 42);
    assert.equal(view.environment.dimension, 'nether');
    assert.equal(view.environment.isDay, false);
  });

});

// ─── 静态 AC 检查 ─────────────────────────────────────────────────────────────

describe('AC · v1 退役验证（静态代码检查）', () => {

  test('TC-WEBUI-14 (AC2) · runtime.ts 不含 WorldStateCollector / startPerception', () => {
    const src = readFileSync(join(SRC, 'bot', 'runtime.ts'), 'utf-8');
    assert.ok(!src.includes('WorldStateCollector'), 'runtime.ts 仍含 WorldStateCollector');
    assert.ok(!src.includes('startPerception'), 'runtime.ts 仍含 startPerception');
    assert.ok(!src.includes('perceptionInterval'), 'runtime.ts 仍含 perceptionInterval');
  });

  test('TC-WEBUI-15 (AC7) · server.ts 不含 v1 socket 事件', () => {
    const src = readFileSync(join(SRC, 'hub', 'server.ts'), 'utf-8');
    assert.ok(!src.includes('bot:worldState'), 'server.ts 仍含 bot:worldState');
    assert.ok(!src.includes('bot:navPhase'), 'server.ts 仍含 bot:navPhase');
    assert.ok(!src.includes('bot:taskStack'), 'server.ts 仍含 bot:taskStack');
    assert.ok(!src.includes('bot:btState'), 'server.ts 仍含 bot:btState');
  });

  test('TC-WEBUI-16 (AC7) · server.ts 含 bot:v2:worldState 推送', () => {
    const src = readFileSync(join(SRC, 'hub', 'server.ts'), 'utf-8');
    assert.ok(src.includes('bot:v2:worldState'), 'server.ts 缺少 bot:v2:worldState 推送');
  });

});
