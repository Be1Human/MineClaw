/**
 * TaskRuntime Unit Tests · US-G7 / US-DOC-L6
 *
 * Framework: node:test + node:assert/strict
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { TaskRuntime } from '../../../../../../apps/minecraft-companion/src/bot/v2/task/taskRuntime.js';
import { PreconditionRegistry } from '../../../../../../apps/minecraft-companion/src/bot/v2/task/preconditionRegistry.js';
import { MemoryV2 } from '../../../../../../apps/minecraft-companion/src/bot/v2/infra/memory.js';
import type { WorldStateView } from '../../../../../../apps/minecraft-companion/src/bot/v2/types.js';
import type { EventBusV2 } from '../../../../../../apps/minecraft-companion/src/bot/v2/infra/eventBus.js';
import type { TaskSnapshot } from '../../../../../../apps/minecraft-companion/src/bot/v2/infra/memory.js';

// ── mocks ──────────────────────────────────────────────────────────────────

/** Minimal mock EventBus that satisfies the EventBusV2 shape */
const mockBus = {
  publish: () => ({ id: '', type: '', level: 'info' as const, timestamp: 0, payload: undefined }),
  on: () => () => {},
  onLevel: () => () => {},
  onAny: () => () => {},
  drain: () => [],
} as unknown as EventBusV2;

/** Build a minimal WorldStateView for tests */
function makeWorld(overrides: Partial<WorldStateView> = {}): WorldStateView {
  return {
    tick: 0,
    timestamp: Date.now(),
    self: { position: { x: 0, y: 64, z: 0 }, yaw: 0, pitch: 0, health: 20, maxHealth: 20, food: 20, isOnGround: true },
    owner: null,
    environment: { dimension: 'overworld', timeOfDay: 6000, isDay: true, isRaining: false },
    inventory: { items: [], held: null, freeSlots: 36 },
    entities: [],
    taskContext: null,
    ...overrides,
  };
}

/** World with a visible owner */
function makeWorldWithOwner(): WorldStateView {
  return makeWorld({
    owner: {
      username: 'TestOwner',
      position: { x: 5, y: 64, z: 5 },
      distance: 7,
      entityId: 42,
      isVisible: true,
    },
  });
}

/** World with farm items (seeds + hoe) */
function makeWorldWithFarmItems(hoeDurability = 100): WorldStateView {
  return makeWorld({
    owner: null,
    inventory: {
      items: [
        { name: 'wheat_seeds', count: 16, slot: 0 },
        { name: 'wooden_hoe', count: 1, slot: 1, durability: hoeDurability, maxDurability: 60 },
      ],
      held: null,
      freeSlots: 34,
    },
  });
}

/** Helper to create a fresh TaskRuntime with in-memory MemoryV2 */
function makeRuntime() {
  const mem = new MemoryV2(':memory:');
  // 注册与 v2Runtime.ts 一致的 precondition checkers
  const preconditions = new PreconditionRegistry();
  preconditions.register('owner_known', (task, world) => {
    return !!world.owner || !!(task.params.targetPosition || task.params.ownerPosition);
  });
  preconditions.register('owner_known_or_has_position', (task, world) => {
    return !!world.owner || !!(task.params.targetPosition || task.params.ownerPosition);
  });
  preconditions.register('has_seeds', (task, world) => {
    const seed = (task.params.seedName as string) || 'wheat_seeds';
    return world.inventory.items.some(it => it.name === seed && it.count >= 1);
  });
  preconditions.register('has_hoe_with_durability', (task, world) => {
    const hoeName = (task.params.hoeName as string) || 'wooden_hoe';
    const plots = (task.params.plots as number) ?? 1;
    const durPerPlot = (task.params.durabilityPerPlot as number) ?? 1;
    const need = plots * durPerPlot;
    const hoe = world.inventory.items.find(it => it.name === hoeName);
    return !!hoe && (hoe.durability ?? Infinity) >= need;
  });
  const rt = new TaskRuntime(mem, mockBus, preconditions);
  return { mem, rt };
}

// ── tests ──────────────────────────────────────────────────────────────────

describe('TaskRuntime', () => {

  // ① createFollowOwnerTask() → start(id, world) → state=running
  test('① createFollowOwnerTask + start → state running', () => {
    const { rt } = makeRuntime();
    const task = rt.createFollowOwnerTask({ ownerName: 'Alice' });

    assert.equal(task.state, 'pending');
    assert.equal(task.kind, 'follow_owner');

    const world = makeWorldWithOwner();
    const result = rt.start(task.id, world);

    assert.equal(result.ok, true);

    const retrieved = rt.getById(task.id);
    assert.ok(retrieved !== null);
    assert.equal(retrieved!.state, 'running');
    assert.ok(retrieved!.startedAt !== undefined);
  });

  // ② pause(id) → state=paused, resume(id) → state=running
  test('② pause → paused; resume → running', () => {
    const { rt } = makeRuntime();
    const task = rt.createFollowOwnerTask({ ownerName: 'Bob' });
    rt.start(task.id, makeWorldWithOwner());

    rt.pause(task.id, { step: 'approaching' });

    const afterPause = rt.getById(task.id);
    assert.equal(afterPause!.state, 'paused');
    assert.deepEqual(afterPause!.resumePoint, { step: 'approaching' });

    const resumeResult = rt.resume(task.id);
    assert.equal(resumeResult.ok, true);
    assert.deepEqual(resumeResult.resumePoint, { step: 'approaching' });

    const afterResume = rt.getById(task.id);
    assert.equal(afterResume!.state, 'running');
  });

  // ③ complete(id) → removed from stack, state=completed
  test('③ complete → removed from active stack, state=completed', () => {
    const { rt } = makeRuntime();
    const task = rt.createFollowOwnerTask({ ownerName: 'Carol' });
    rt.start(task.id, makeWorldWithOwner());

    // Task should be active before completion
    assert.ok(rt.active() !== null);
    assert.equal(rt.active()!.id, task.id);

    rt.complete(task.id);

    const afterComplete = rt.getById(task.id);
    assert.equal(afterComplete!.state, 'completed');

    // No longer active
    assert.equal(rt.active(), null);
  });

  // ④ Preflight fails (no owner in world) → start() returns {ok:false}
  test('④ preflight fails when owner absent → start returns {ok:false}', () => {
    const { rt } = makeRuntime();
    const task = rt.createFollowOwnerTask({ ownerName: 'Dave' });

    // World has no owner
    const world = makeWorld({ owner: null });
    const result = rt.start(task.id, world);

    assert.equal(result.ok, false);
    assert.ok(result.reason !== undefined);
    assert.ok(result.reason!.includes('preflight_missing'));
    assert.ok(result.reason!.includes('owner_known'));

    // Task remains pending (was not started)
    const t = rt.getById(task.id);
    assert.equal(t!.state, 'pending');
  });

  // ⑤ createFarmTask() + preflight with missing hoe → fail
  test('⑤ farm preflight fails when hoe is missing from inventory', () => {
    const { rt } = makeRuntime();
    const task = rt.createFarmTask({
      seedName: 'wheat_seeds',
      plots: 4,
      hoeName: 'wooden_hoe',
      durabilityPerPlot: 1,
    });

    // World has seeds but NO hoe
    const world = makeWorld({
      inventory: {
        items: [{ name: 'wheat_seeds', count: 16, slot: 0 }],
        held: null,
        freeSlots: 35,
      },
    });

    const result = rt.start(task.id, world);

    assert.equal(result.ok, false);
    assert.ok(result.reason!.includes('preflight_missing'));
    assert.ok(result.reason!.includes('has_hoe'));
  });

  // ⑥ updateParams(id, {plots: 2}) changes params visible in getById
  test('⑥ updateParams changes visible in getById', () => {
    const { rt } = makeRuntime();
    const task = rt.createFarmTask({
      seedName: 'wheat_seeds',
      plots: 1,
      hoeName: 'wooden_hoe',
      durabilityPerPlot: 1,
    });

    assert.equal((rt.getById(task.id)!.params as { plots: number }).plots, 1);

    const updated = rt.updateParams(task.id, { plots: 2 });
    assert.equal(updated, true);

    const retrieved = rt.getById(task.id);
    assert.ok(retrieved !== null);
    assert.equal((retrieved!.params as { plots: number }).plots, 2);
    // Other params preserved
    assert.equal((retrieved!.params as { seedName: string }).seedName, 'wheat_seeds');
  });

  // ⑦ hydrateFromSnapshot → task is registered with state=paused
  test('⑦ hydrateFromSnapshot → task registered with state=paused', () => {
    const { rt } = makeRuntime();
    const snap: TaskSnapshot = {
      taskId: 'task-snap-001',
      kind: 'follow_owner',
      state: 'running',        // original state (ignored — hydrate always sets paused)
      resumePoint: { step: 'navigating' },
      parentId: undefined,
      createdAt: Date.now() - 5000,
      updatedAt: Date.now(),
    };

    rt.hydrateFromSnapshot(snap);

    const t = rt.getById('task-snap-001');
    assert.ok(t !== null, 'task should be registered after hydrate');
    assert.equal(t!.id, 'task-snap-001');
    assert.equal(t!.kind, 'follow_owner');
    // hydrateFromSnapshot always sets state to paused
    assert.equal(t!.state, 'paused', 'hydrated task should be paused, waiting for resume()');
    assert.deepEqual(t!.resumePoint, { step: 'navigating' });
  });

  // ⑧ hydrateFromSnapshot is idempotent — duplicate call does not overwrite
  test('⑧ hydrateFromSnapshot is idempotent on duplicate id', () => {
    const { rt } = makeRuntime();
    const snap: TaskSnapshot = {
      taskId: 'task-snap-002',
      kind: 'farm',
      state: 'paused',
      resumePoint: { plotsDone: 3 },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    rt.hydrateFromSnapshot(snap);
    // Mutate resumePoint then hydrate again — should NOT overwrite
    const snapChanged: TaskSnapshot = { ...snap, resumePoint: { plotsDone: 999 } };
    rt.hydrateFromSnapshot(snapChanged);

    const t = rt.getById('task-snap-002');
    assert.ok(t !== null);
    // First hydrate wins — resumePoint should still be {plotsDone: 3}
    assert.deepEqual(t!.resumePoint, { plotsDone: 3 }, 'second hydrate should not overwrite');
  });

  // ⑨ hydrateFromSnapshot + resume → state=running
  test('⑨ hydrateFromSnapshot + resume → state=running, resumePoint returned', () => {
    const { rt } = makeRuntime();
    const snap: TaskSnapshot = {
      taskId: 'task-snap-003',
      kind: 'guard',
      state: 'running',
      resumePoint: { phase: 'patrolling' },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    rt.hydrateFromSnapshot(snap);

    const result = rt.resume('task-snap-003');
    assert.equal(result.ok, true, 'resume after hydrate should succeed');
    assert.deepEqual(result.resumePoint, { phase: 'patrolling' });

    const t = rt.getById('task-snap-003');
    assert.equal(t!.state, 'running');
  });

  // ⑩ fail() transitions task to failed, removes from active stack
  test('⑩ fail() → state=failed, removed from stack', () => {
    const { rt } = makeRuntime();
    const task = rt.createFollowOwnerTask({ ownerName: 'Eve' });
    rt.start(task.id, makeWorldWithOwner());

    assert.ok(rt.active() !== null);

    rt.fail(task.id, 'timeout');

    const t = rt.getById(task.id);
    assert.equal(t!.state, 'failed');
    assert.equal(rt.active(), null);
  });

  // ⑪ cancel() → 独立 'cancelled' 终态（区别于 failed），移出栈
  test('⑪ cancel() → state=cancelled（非 failed）, removed from stack', () => {
    const { rt } = makeRuntime();
    const task = rt.createFollowOwnerTask({ ownerName: 'Eve' });
    rt.start(task.id, makeWorldWithOwner());

    assert.ok(rt.active() !== null);

    rt.cancel(task.id, '主人要求停止跟随');

    const t = rt.getById(task.id);
    assert.equal(t!.state, 'cancelled', '主人喊停应是 cancelled 而非 failed');
    assert.equal(t!.failure, undefined, 'cancel 不应写 failure（它不是失败）');
    assert.equal(rt.active(), null);
  });

  test('BUG-CROSS-56-005 · 业务显式暂停不被独立任务完成自动恢复', () => {
    const { rt } = makeRuntime();
    const blocked = rt.createFollowOwnerTask({ ownerName: 'Owner' });
    const replacement = rt.createFollowOwnerTask({ ownerName: 'Owner' });

    rt.start(blocked.id, makeWorldWithOwner());
    rt.pause(blocked.id, { reason: 'need_owner', sessionId: 'goalagent:blocked' });
    rt.start(replacement.id, makeWorldWithOwner());
    rt.complete(replacement.id);

    assert.equal(rt.getById(replacement.id)?.state, 'completed');
    assert.equal(rt.getById(blocked.id)?.state, 'paused');
    assert.equal(rt.active(), null);
  });

  test('BUG-CROSS-56-005 · 普通与紧急调度抢占仍自动恢复', () => {
    const { rt } = makeRuntime();
    const original = rt.createFollowOwnerTask({ ownerName: 'Owner' });
    const preemptor = rt.createFollowOwnerTask({ ownerName: 'Owner' });

    rt.start(original.id, makeWorldWithOwner());
    rt.start(preemptor.id, makeWorldWithOwner());
    assert.equal(rt.getById(original.id)?.state, 'paused');
    rt.complete(preemptor.id);
    assert.equal(rt.getById(original.id)?.state, 'running');

    const emergency = rt.createTask('emergency_probe', {}, { priority: 99 });
    rt.startEmergency(emergency.id);
    assert.equal(rt.getById(original.id)?.resumePoint?.reason, 'preempted_emergency');
    rt.complete(emergency.id);
    assert.equal(rt.getById(original.id)?.state, 'running');
    assert.equal(rt.active()?.id, original.id);
  });

  test('BUG-CROSS-56-005 · 持久化恢复策略元数据不泄漏到业务断点', () => {
    const { rt } = makeRuntime();
    rt.hydrateFromSnapshot({
      taskId: 'task-resume-policy',
      kind: 'follow_owner',
      state: 'paused',
      resumePoint: { step: 'waiting', __taskResumePolicy: 'explicit' },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    assert.deepEqual(rt.getById('task-resume-policy')?.resumePoint, { step: 'waiting' });
    assert.deepEqual(rt.resume('task-resume-policy').resumePoint, { step: 'waiting' });
  });

  test('BUG-CROSS-78 · mirror tasks declare projection mode and keep terminal states monotonic', () => {
    const { rt } = makeRuntime();
    const failedId = rt.mirrorStart('invoke_behavior', {}, 'root-1', '行为投影');
    assert.equal(rt.getById(failedId)?.executionMode, 'projection');
    rt.mirrorFinish(failedId, false, 'first terminal failure');
    rt.mirrorFinish(failedId, true, 'late success');
    assert.equal(rt.getById(failedId)?.state, 'failed');
    assert.match(rt.getById(failedId)?.failure?.detail ?? '', /first terminal failure/);

    const completedId = rt.mirrorPlanNode('agriculture', {}, 'root-1', '计划投影', 'running');
    assert.equal(rt.getById(completedId)?.executionMode, 'projection');
    rt.mirrorSetState(completedId, 'completed');
    rt.mirrorSetState(completedId, 'failed', 'late watchdog');
    assert.equal(rt.getById(completedId)?.state, 'completed');
    assert.equal(rt.getById(completedId)?.failure, undefined);
  });

});
