/**
 * StrategyExecutor · defaultCheckCondition 单测（FEAT-CROSS-07 R4）
 * （BT 遍历/递归/抢占逻辑已由 btInterpreter.test 覆盖；这里测内置谓词求值。）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StrategyExecutor, defaultCheckCondition } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/strategy/strategyExecutor.js';
import type { Strategy } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/strategy/strategyTypes.js';

const world = (over: Record<string, unknown> = {}) => ({
  self: { position: { x: 0, y: 0, z: 0 }, health: 20 },
  entities: [{ id: 42, name: 'Annie', position: { x: 1, y: 0, z: 0 }, distance: 1 }],
  inventory: { items: [{ name: 'oak_log', count: 7 }] },
  ...over,
}) as never;

test('CC-has_item', () => {
  assert.equal(defaultCheckCondition('has_item', { item: 'oak_log', count: 5 }, world()), true);
  assert.equal(defaultCheckCondition('has_item', { item: 'oak_log', count: 10 }, world()), false);
  assert.equal(defaultCheckCondition('has_item', { item: 'iron', count: 1 }, world()), false);
});

test('CC-hp_below', () => {
  assert.equal(defaultCheckCondition('hp_below', { value: 10 }, world({ self: { position: { x: 0, y: 0, z: 0 }, health: 6 } })), true);
  assert.equal(defaultCheckCondition('hp_below', { value: 10 }, world()), false);
});

test('CC-target_dead：实体在→活，不在→死', () => {
  assert.equal(defaultCheckCondition('target_dead', { target: 42 }, world()), false, '42 还在 → 没死');
  assert.equal(defaultCheckCondition('target_dead_or_fled', { target: 999 }, world()), true, '不在快照 → 死/逃');
  assert.equal(defaultCheckCondition('target_dead', { target: 'Annie' }, world()), false, '按名也认');
});

test('CC-reached', () => {
  assert.equal(defaultCheckCondition('reached', { position: { x: 0, y: 0, z: 0 }, radius: 2 }, world()), true);
  assert.equal(defaultCheckCondition('reached', { position: { x: 50, y: 0, z: 0 }, radius: 2 }, world()), false);
});

test('CC-未知谓词 / 无世界 → false（安全默认）', () => {
  assert.equal(defaultCheckCondition('whatever', {}, world()), false);
  assert.equal(defaultCheckCondition('has_item', { item: 'x' }, null), false);
});

test('BUG-CROSS-17 · per-run preemption 覆盖默认值并阻止 Strategy 动作', async () => {
  const strategy: Strategy = {
    id: 'old-route', name: 'old', description: 'old route', params: [], applicability: {},
    bt: { type: 'action', atomic: 'move_to', args: { position: { x: 99, y: 0, z: 0 } } },
    lifecycle: { state: 'trusted', confidence: 1, trialRuns: 1, cleanSuccess: 1, deps: [], ownerVerdict: null },
  };
  const executor = new StrategyExecutor({
    atom: {} as never,
    getStrategy: () => undefined,
    getWorld: () => world(),
    isPreempted: () => false,
  });

  const result = await executor.run(strategy, {}, () => true);
  assert.equal(result.status, 'preempted');
});

test('FEAT-CROSS-14-006 - injected execution port owns Strategy side effects', async () => {
  const strategy: Strategy = {
    id: 'coordinated-action', name: 'coordinated', description: 'coordinated', params: [], applicability: {},
    bt: { type: 'action', atomic: 'craft', args: { itemName: 'iron_pickaxe' } },
    lifecycle: { state: 'trusted', confidence: 1, trialRuns: 1, cleanSuccess: 1, deps: [], ownerVerdict: null },
  };
  const calls: Array<{ action: string; args: Record<string, unknown> }> = [];
  const executor = new StrategyExecutor({
    atom: {} as never,
    getStrategy: () => undefined,
    getWorld: () => world(),
  });
  const result = await executor.run(strategy, {}, undefined, {
    execute: async (action, args) => {
      calls.push({ action, args });
      return { ok: true, detail: 'coordinator accepted' };
    },
  });
  assert.equal(result.status, 'success');
  assert.deepEqual(calls, [{ action: 'craft', args: { itemName: 'iron_pickaxe' } }]);
});
