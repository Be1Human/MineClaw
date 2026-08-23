/**
 * CompositeCritic · 多数投票单元测试
 *
 * 测什么：
 *   1. 2 success + 1 fail → composite = success
 *   2. 1 success + 2 fail → composite = fail
 *   3. 全部 unknown → composite = unknown
 *   4. 1 success + 1 fail + 1 unknown → success（忽略 unknown，success/fail 各 1，平票取先遍历的 success）
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { CompositeCritic } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/critic/compositeCritic.js';
import type { ICritic, Verdict, VerdictStatus } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/critic/types.js';
import type { WorldStateView } from '../../../../../../../apps/minecraft-companion/src/bot/v2/types.js';
import type { Task } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/taskRuntime.js';

// ──────────────────────────────────────────────────────────────────
// 辅助：构造 mock
// ──────────────────────────────────────────────────────────────────

function makeMockCritic(status: VerdictStatus, id?: string): ICritic {
  const criticId = id ?? `mock-${status}-${Math.random().toString(36).slice(2, 7)}`;
  return {
    id: criticId,
    verify(_task: Task, _before: WorldStateView, _after: WorldStateView): Verdict {
      return {
        taskId: _task.id,
        taskKind: _task.kind,
        status,
        reason: `mock critic always returns ${status}`,
        evaluatedAt: Date.now(),
      };
    },
  };
}

const STUB_TASK: Task = {
  id: 'test-task-1',
  kind: 'farm',
  state: 'running',
  priority: 50,
  preconditions: [],
  params: { seedName: 'wheat_seeds', plots: 3 },
  createdAt: Date.now(),
  lastActiveTick: 0,
};

const STUB_WORLD: WorldStateView = {
  tick: 100,
  timestamp: Date.now(),
  self: {
    position: { x: 0, y: 64, z: 0 },
    yaw: 0,
    pitch: 0,
    health: 20,
    maxHealth: 20,
    food: 20,
    isOnGround: true,
  },
  owner: null,
  entities: [],
  inventory: { items: [], held: null, freeSlots: 27 },
  environment: {
    dimension: 'overworld',
    timeOfDay: 6000,
    isDay: true,
    isRaining: false,
  },
  taskContext: null,
};

// ──────────────────────────────────────────────────────────────────
// 测试
// ──────────────────────────────────────────────────────────────────

describe('CompositeCritic · 多数投票', () => {
  it('2 success + 1 fail → composite = success', () => {
    const composite = new CompositeCritic('test', [
      makeMockCritic('success'),
      makeMockCritic('success'),
      makeMockCritic('fail'),
    ]);

    const verdict = composite.verify(STUB_TASK, STUB_WORLD, STUB_WORLD);
    assert.equal(verdict.status, 'success');
    assert.equal(verdict.taskId, STUB_TASK.id);
    assert.equal(verdict.taskKind, STUB_TASK.kind);
    const metrics = verdict.metrics as { counts: Record<VerdictStatus, number>; verdicts: VerdictStatus[] };
    assert.equal(metrics.counts.success, 2);
    assert.equal(metrics.counts.fail, 1);
  });

  it('1 success + 2 fail → composite = fail', () => {
    const composite = new CompositeCritic('test', [
      makeMockCritic('success'),
      makeMockCritic('fail'),
      makeMockCritic('fail'),
    ]);

    const verdict = composite.verify(STUB_TASK, STUB_WORLD, STUB_WORLD);
    assert.equal(verdict.status, 'fail');
    const metrics = verdict.metrics as { counts: Record<VerdictStatus, number> };
    assert.equal(metrics.counts.success, 1);
    assert.equal(metrics.counts.fail, 2);
  });

  it('全部 unknown → composite = unknown', () => {
    const composite = new CompositeCritic('test', [
      makeMockCritic('unknown'),
      makeMockCritic('unknown'),
      makeMockCritic('unknown'),
    ]);

    const verdict = composite.verify(STUB_TASK, STUB_WORLD, STUB_WORLD);
    assert.equal(verdict.status, 'unknown');
    const metrics = verdict.metrics as { counts: Record<VerdictStatus, number> };
    assert.equal(metrics.counts.unknown, 3);
    assert.equal(metrics.counts.success, 0);
    assert.equal(metrics.counts.fail, 0);
  });

  it('1 success + 1 fail + 1 unknown → success（平票中 success 先遍历）', () => {
    const composite = new CompositeCritic('test', [
      makeMockCritic('success'),
      makeMockCritic('fail'),
      makeMockCritic('unknown'),
    ]);

    const verdict = composite.verify(STUB_TASK, STUB_WORLD, STUB_WORLD);
    // success/fail 各 1，unknown 被忽略；遍历顺序 success→partial→fail，success 先到 maxCount
    assert.equal(verdict.status, 'success');
    const metrics = verdict.metrics as { counts: Record<VerdictStatus, number> };
    assert.equal(metrics.counts.unknown, 1);
  });

  it('metrics.verdicts 包含所有子 critic 的状态', () => {
    const composite = new CompositeCritic('test', [
      makeMockCritic('success'),
      makeMockCritic('partial'),
      makeMockCritic('fail'),
    ]);

    const verdict = composite.verify(STUB_TASK, STUB_WORLD, STUB_WORLD);
    const metrics = verdict.metrics as { verdicts: VerdictStatus[] };
    assert.deepEqual(metrics.verdicts.sort(), ['fail', 'partial', 'success']);
  });

  it('空 critics 列表 → unknown', () => {
    const composite = new CompositeCritic('empty', []);
    const verdict = composite.verify(STUB_TASK, STUB_WORLD, STUB_WORLD);
    assert.equal(verdict.status, 'unknown');
  });
});
