/**
 * FEAT-L6-04 · FailureReason + TaskRuntime.fail() 结构化失败 单元测试（回边①）
 *
 * 覆盖：
 *   1. toFailureReason：string → {code:'unknown', detail}；FailureReason 原样
 *   2. fail(taskId, string) 兼容：task.failed payload 含 kind/code/detail/reason
 *   3. fail(taskId, FailureReason)：payload 原样 code/detail
 *   4. task.failure 写到 Task 上（终态可观测）
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { TaskRuntime } from '../../../../../../apps/minecraft-companion/src/bot/v2/task/taskRuntime.js';
import { toFailureReason } from '../../../../../../apps/minecraft-companion/src/bot/v2/task/failureReason.js';
import type { MemoryV2 } from '../../../../../../apps/minecraft-companion/src/bot/v2/infra/memory.js';
import type { WorldStateView } from '../../../../../../apps/minecraft-companion/src/bot/v2/types.js';

function makeBus(events: Array<{ type: string; payload: unknown }>) {
  return {
    publish: (type: string, _level: string, payload: unknown) => { events.push({ type, payload }); },
    on: () => () => {}, onLevel: () => () => {}, onAny: () => () => {}, drain: () => [],
  } as unknown as ConstructorParameters<typeof TaskRuntime>[1];
}

const mockMemory = { scheduleCommit: () => {} } as unknown as MemoryV2;

function makeWorld(): WorldStateView {
  return {
    tick: 0, timestamp: 0,
    self: { position: { x: 0, y: 64, z: 0 }, yaw: 0, pitch: 0, health: 20, maxHealth: 20, food: 20, isOnGround: true },
    owner: null,
    environment: { dimension: 'overworld', timeOfDay: 6000, isDay: true, isRaining: false },
    inventory: { items: [], held: null, freeSlots: 36 },
    entities: [], taskContext: null,
  };
}

describe('FailureReason · FEAT-L6-04', () => {
  it('1) toFailureReason：string → unknown · 结构原样', () => {
    assert.deepEqual(toFailureReason('boom'), { code: 'unknown', detail: 'boom' });
    assert.deepEqual(toFailureReason({ code: 'no_tool', detail: '缺镐' }), { code: 'no_tool', detail: '缺镐' });
  });

  it('2) fail(string) 兼容 → payload code=unknown · reason 保留文本', () => {
    const events: Array<{ type: string; payload: unknown }> = [];
    const rt = new TaskRuntime(mockMemory, makeBus(events));
    const t = rt.createTask('gather_material', { material: 'oak_log' });
    rt.start(t.id, makeWorld());
    rt.fail(t.id, '找不到树');
    const f = events.find(e => e.type === 'task.failed')!.payload as Record<string, unknown>;
    assert.equal(f.code, 'unknown');
    assert.equal(f.detail, '找不到树');
    assert.equal(f.kind, 'gather_material');
    assert.equal(f.reason, 'unknown · 找不到树');
    assert.equal(rt.getById(t.id)?.failure?.code, 'unknown');
  });

  it('3) fail(FailureReason) → payload 原样 code/detail', () => {
    const events: Array<{ type: string; payload: unknown }> = [];
    const rt = new TaskRuntime(mockMemory, makeBus(events));
    const t = rt.createTask('gather_material', { material: 'oak_log' });
    rt.start(t.id, makeWorld());
    rt.fail(t.id, { code: 'no_resource_found', detail: '探索耗尽' });
    const f = events.find(e => e.type === 'task.failed')!.payload as Record<string, unknown>;
    assert.equal(f.code, 'no_resource_found');
    assert.equal(f.detail, '探索耗尽');
    assert.equal(rt.getById(t.id)?.failure?.code, 'no_resource_found');
    assert.equal(rt.getById(t.id)?.state, 'failed');
  });
});
