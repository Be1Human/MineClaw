/**
 * US-E3 · Critic integration tests
 *
 * 验证 RuleCritic 正确接管 Farm/Follow 任务的完成判定
 * （Strategy 不再自判 · Critic 统一判断）
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { RuleCritic, CriticRegistry, makeVerdict } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/critic/ruleCritic.js';
import type { Task } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/taskRuntime.js';
import type { WorldStateView } from '../../../../../../../apps/minecraft-companion/src/bot/v2/types.js';

// ── 辅助：创建带业务验证逻辑的 RuleCritic ────────────────────────

function makeRuleCriticWithVerifiers(): RuleCritic {
  const critic = new RuleCritic();
  // follow_owner verifier（与 v2Runtime.ts 一致）
  critic.registerVerifier('follow_owner', (task, _before, after) => {
    const owner = after.owner;
    if (!owner) {
      const hasTarget = !!(task.params.targetPosition || task.params.ownerPosition);
      if (hasTarget) return makeVerdict(task, 'partial', 'seeking target position');
      return makeVerdict(task, 'unknown', 'owner not visible');
    }
    if (owner.distance <= 3) return makeVerdict(task, 'success', `in range: ${owner.distance.toFixed(1)}`);
    return makeVerdict(task, 'partial', `moving: dist=${owner.distance.toFixed(1)}`);
  });
  // farm verifier（与 v2Runtime.ts 一致）
  critic.registerVerifier('farm', (task, before, after) => {
    const seed = (task.params.seedName as string) || 'wheat_seeds';
    const countItem = (w: typeof before, n: string) =>
      w.inventory.items.filter(it => it.name === n).reduce((s, it) => s + it.count, 0);
    const seedsBefore = countItem(before, seed);
    const seedsAfter = countItem(after, seed);
    const seedsUsed = seedsBefore - seedsAfter;
    const expectedPlots = (task.params.plots as number) ?? 1;
    const progress = (task.progress?.plotsDone as number) ?? 0;
    if (progress >= expectedPlots) return makeVerdict(task, 'success', `done: ${progress}/${expectedPlots}`);
    if (seedsUsed >= expectedPlots) return makeVerdict(task, 'success', `planted all: ${seedsUsed}/${expectedPlots}`);
    if (seedsUsed > 0) return makeVerdict(task, 'partial', `planted ${seedsUsed}/${expectedPlots}`);
    return makeVerdict(task, 'fail', `no progress: seeds=${seedsBefore}→${seedsAfter}`);
  });
  return critic;
}

// ── 辅助函数 ─────────────────────────────────────────────────────

function makeWorld(overrides: Partial<WorldStateView> = {}): WorldStateView {
  return {
    tick: 0,
    timestamp: Date.now(),
    self: {
      position: { x: 0, y: 64, z: 0 },
      yaw: 0, pitch: 0,
      health: 20, maxHealth: 20,
      food: 20,
      isOnGround: true,
    },
    owner: null,
    environment: { dimension: 'overworld', timeOfDay: 6000, isDay: true, isRaining: false },
    inventory: { items: [], held: null, freeSlots: 36 },
    entities: [],
    taskContext: null,
    ...overrides,
  };
}

function makeFarmTask(plotsDone: number, plots: number): Task {
  return {
    id: `farm-test-${Date.now()}`,
    kind: 'farm',
    state: 'running',
    priority: 30,
    preconditions: ['has_seeds', 'has_hoe_with_durability'],
    params: { seedName: 'wheat_seeds', plots, hoeName: 'wooden_hoe', durabilityPerPlot: 1 },
    createdAt: Date.now(),
    lastActiveTick: 0,
    progress: { plotsDone },
  };
}

function makeFollowTask(ownerDistance?: number): Task {
  return {
    id: `follow-test-${Date.now()}`,
    kind: 'follow_owner',
    state: 'running',
    priority: 40,
    preconditions: ['owner_known'],
    params: { ownerName: 'testOwner' },
    createdAt: Date.now(),
    lastActiveTick: 0,
    _testOwnerDistance: ownerDistance,
  } as unknown as Task;
}

// ── RuleCritic · Farm 规则 ────────────────────────────────────────

describe('RuleCritic · farm rule', () => {
  const critic = makeRuleCriticWithVerifiers();

  test('plotsDone >= plots (progress 路径) → success', () => {
    const task = makeFarmTask(3, 3);
    const world = makeWorld();
    const verdict = critic.verify(task, world, world);
    assert.equal(verdict.status, 'success');
    assert.equal(verdict.taskId, task.id);
    assert.equal(verdict.taskKind, 'farm');
  });

  test('plotsDone=0, seedsUsed=0 → fail', () => {
    const task = makeFarmTask(0, 5);
    // before and after both have 5 seeds → seedsUsed = 0, progress = 0 → fail
    const worldWithSeeds = makeWorld({
      inventory: { items: [{ name: 'wheat_seeds', count: 5, slot: 0 }], held: null, freeSlots: 35 },
    });
    const verdict = critic.verify(task, worldWithSeeds, worldWithSeeds);
    assert.equal(verdict.status, 'fail');
  });

  test('seedsUsed >= plots (inventory 路径) → success', () => {
    const task = makeFarmTask(0, 3);
    const before = makeWorld({
      inventory: { items: [{ name: 'wheat_seeds', count: 5, slot: 0 }], held: null, freeSlots: 35 },
    });
    const after = makeWorld({
      inventory: { items: [{ name: 'wheat_seeds', count: 2, slot: 0 }], held: null, freeSlots: 35 },
    });
    const verdict = critic.verify(task, before, after);
    // 5-2=3 seedsUsed >= 3 plots
    assert.equal(verdict.status, 'success');
  });

  test('0 < seedsUsed < plots → partial', () => {
    const task = makeFarmTask(0, 5);
    const before = makeWorld({
      inventory: { items: [{ name: 'wheat_seeds', count: 5, slot: 0 }], held: null, freeSlots: 35 },
    });
    const after = makeWorld({
      inventory: { items: [{ name: 'wheat_seeds', count: 3, slot: 0 }], held: null, freeSlots: 35 },
    });
    const verdict = critic.verify(task, before, after);
    // 5-3=2 seedsUsed, 2 < 5 → partial
    assert.equal(verdict.status, 'partial');
  });
});

// ── RuleCritic · Follow 规则 ─────────────────────────────────────
// 注：follow_owner 验证逻辑现在由业务侧注册（v2Runtime.ts）
// 这里复制注册逻辑来测试

describe('RuleCritic · follow_owner rule', () => {
  const critic = makeRuleCriticWithVerifiers();

  test('owner.distance <= 3 → success', () => {
    const task = makeFarmTask(0, 1); // reuse as dummy; kind matters
    const farmTask = { ...task, kind: 'follow_owner', progress: undefined };
    const world = makeWorld({
      owner: {
        username: 'testOwner',
        distance: 2.5,
        isVisible: true,
        position: { x: 2, y: 64, z: 0 },
        entityId: 1,
      },
    });
    const verdict = critic.verify(farmTask as Task, world, world);
    assert.equal(verdict.status, 'success');
  });

  test('owner.distance > 10 → partial (still moving)', () => {
    const task = { ...makeFarmTask(0, 1), kind: 'follow_owner', progress: undefined } as Task;
    const world = makeWorld({
      owner: {
        username: 'testOwner',
        distance: 15,
        isVisible: true,
        position: { x: 15, y: 64, z: 0 },
        entityId: 1,
      },
    });
    const verdict = critic.verify(task, world, world);
    assert.equal(verdict.status, 'partial');
  });

  test('owner not visible + no targetPosition → unknown', () => {
    const task = { ...makeFarmTask(0, 1), kind: 'follow_owner', progress: undefined } as Task;
    const world = makeWorld({ owner: null });
    const verdict = critic.verify(task, world, world);
    assert.equal(verdict.status, 'unknown');
  });

  test('owner not visible + has targetPosition → partial (seeking)', () => {
    const task = { ...makeFarmTask(0, 1), kind: 'follow_owner', progress: undefined, params: { targetPosition: { x: -88, y: 107, z: 126 } } } as Task;
    const world = makeWorld({ owner: null });
    const verdict = critic.verify(task, world, world);
    assert.equal(verdict.status, 'partial');
  });
});

// ── CriticRegistry · verifyAll ────────────────────────────────────

describe('CriticRegistry · verifyAll', () => {
  test('verifyAll returns verdicts for all running tasks', () => {
    const registry = new CriticRegistry();
    registry.register(makeRuleCriticWithVerifiers());

    const t1 = makeFarmTask(3, 3); // success
    const t2 = makeFarmTask(0, 5); // fail (no seeds used)
    const world = makeWorld();

    const verdicts = registry.verifyAll([t1, t2] as Task[], world, world);
    assert.equal(verdicts.length, 2);
    assert.equal(verdicts[0].status, 'success');
    assert.equal(verdicts[1].status, 'fail');
  });

  test('unknown task kind → unknown verdict', () => {
    const registry = new CriticRegistry();
    registry.register(makeRuleCriticWithVerifiers());

    const guardTask: Task = {
      ...makeFarmTask(0, 1),
      kind: 'guard',
      progress: undefined,
    };
    const world = makeWorld();
    const verdicts = registry.verifyAll([guardTask], world, world);
    assert.equal(verdicts[0].status, 'unknown');
  });
});
