import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { CombatBehavior } from '../../../../../../apps/minecraft-companion/src/bot/v2/behavior/combatBehavior.js';
import type { ActionRequest, EntityView, ExecutionResult, WorldStateView } from '../../../../../../apps/minecraft-companion/src/bot/v2/types.js';

function entity(id: number, distance: number): EntityView {
  return {
    id,
    name: 'zombie',
    type: 'mob',
    position: { x: distance, y: 64, z: 0 },
    distance,
    category: 'hostile',
  };
}

function world(overrides: Partial<WorldStateView> = {}): WorldStateView {
  return {
    tick: 1,
    timestamp: Date.now(),
    self: { position: { x: 0, y: 64, z: 0 }, yaw: 0, pitch: 0, health: 20, maxHealth: 20, food: 20, isOnGround: true },
    owner: null,
    environment: { dimension: 'overworld', timeOfDay: 6000, isDay: true, isRaining: false },
    entities: [],
    inventory: { items: [], held: null, freeSlots: 36 },
    taskContext: null,
    ...overrides,
  };
}

function ok(request: ActionRequest): ExecutionResult {
  return { ok: true, request, durationMs: 1 };
}

describe('FEAT-CROSS-15 · CombatBehavior adaptive loop', () => {
  it('远目标使用真实斧头，接近后攻击并连续两帧确认清场', async () => {
    let current = world({
      entities: [entity(1, 7)],
      inventory: { items: [{ name: 'stone_axe', count: 1, slot: 0 }], held: null, freeSlots: 35 },
    });
    const actions: ActionRequest[] = [];
    const result = await new CombatBehavior().run({
      getWorld: () => current,
      execute: async request => {
        actions.push(request);
        if (request.type === 'equip') current = { ...current, inventory: { ...current.inventory, held: current.inventory.items[0] } };
        if (request.type === 'move_to') current = { ...current, entities: [entity(1, 3)] };
        if (request.type === 'attack') current = { ...current, entities: [] };
        return ok(request);
      },
      publish: () => {},
    });
    assert.equal(result.ok, true);
    assert.deepEqual(actions.map(action => action.type), ['equip', 'move_to', 'attack']);
    assert.equal(actions[0].target?.itemName, 'stone_axe');
    assert.equal(result.details?.emptySnapshots, 2);
  });

  it('贴脸使用 kite，多目标死亡后自动切换', async () => {
    let current = world({
      entities: [entity(1, 1.5), entity(2, 2.8)],
      inventory: {
        items: [{ name: 'stone_sword', count: 1, slot: 0 }],
        held: { name: 'stone_sword', count: 1, slot: 0 },
        freeSlots: 35,
      },
    });
    const actions: ActionRequest[] = [];
    const result = await new CombatBehavior().run({
      taskParams: { clearArea: true, targetEntityName: 'zombie' },
      getWorld: () => current,
      execute: async request => {
        actions.push(request);
        const hitId = request.target?.entityId;
        if (request.type === 'kite' || request.type === 'attack') {
          current = { ...current, entities: current.entities.filter(target => target.id !== hitId) };
        }
        return ok(request);
      },
      publish: () => {},
    });
    assert.equal(result.ok, true);
    assert.deepEqual(actions.map(action => [action.type, action.target?.entityId]), [['kite', 1], ['attack', 2]]);
    assert.equal(result.details?.attacks, 2);
  });

  it('低血且已拉开时先吃食物，恢复后继续清怪', async () => {
    let current = world({
      self: { position: { x: 0, y: 64, z: 0 }, yaw: 0, pitch: 0, health: 6, maxHealth: 20, food: 10, isOnGround: true },
      entities: [entity(1, 7)],
      inventory: {
        items: [{ name: 'bread', count: 3, slot: 0 }, { name: 'stone_sword', count: 1, slot: 1 }],
        held: { name: 'stone_sword', count: 1, slot: 1 },
        freeSlots: 34,
      },
    });
    const actions: ActionRequest[] = [];
    const result = await new CombatBehavior().run({
      getWorld: () => current,
      execute: async request => {
        actions.push(request);
        if (request.type === 'eat') current = { ...current, self: { ...current.self, health: 12, food: 18 }, entities: [entity(1, 3)] };
        if (request.type === 'attack') current = { ...current, entities: [] };
        return ok(request);
      },
      publish: () => {},
    });
    assert.equal(result.ok, true);
    assert.deepEqual(actions.map(action => action.type), ['eat', 'attack']);
    assert.equal(result.details?.eats, 1);
  });

  it('低血但饱食度已满时不重复进食，等待自然恢复后再继续', async () => {
    let current = world({
      self: { position: { x: 0, y: 64, z: 0 }, yaw: 0, pitch: 0, health: 6, maxHealth: 20, food: 20, isOnGround: true },
      entities: [entity(1, 7)],
      inventory: {
        items: [{ name: 'bread', count: 3, slot: 0 }, { name: 'stone_sword', count: 1, slot: 1 }],
        held: { name: 'stone_sword', count: 1, slot: 1 },
        freeSlots: 34,
      },
    });
    const actions: ActionRequest[] = [];
    let snapshots = 0;
    const result = await new CombatBehavior().run({
      getWorld: () => {
        snapshots++;
        if (snapshots >= 2 && current.self.health < 12) {
          current = { ...current, self: { ...current.self, health: 12 } };
        }
        return current;
      },
      execute: async request => {
        actions.push(request);
        if (request.type === 'move_to') current = { ...current, entities: [entity(1, 3)] };
        if (request.type === 'attack') current = { ...current, entities: [] };
        return ok(request);
      },
      publish: () => {},
    });
    // The behavior must not call eat while food is already full.
    assert.equal(actions.filter(action => action.type === 'eat').length, 0);
    assert.equal(result.ok, true);
  });

  it('威胁始终存在时耗尽循环预算并失败，不发布假成功', async () => {
    const current = world({ entities: [entity(1, 1.5)] });
    let actions = 0;
    const result = await new CombatBehavior().run({
      getWorld: () => current,
      execute: async request => { actions++; return ok(request); },
      publish: () => {},
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'combat_iteration_budget_exhausted');
    assert.equal(actions, 80);
  });

  it('动作被抢占但目标已被自动防御清除时重新验真并成功', async () => {
    let current = world({
      entities: [entity(1, 1.5)],
      inventory: {
        items: [{ name: 'stone_sword', count: 1, slot: 0 }],
        held: { name: 'stone_sword', count: 1, slot: 0 },
        freeSlots: 35,
      },
    });
    let calls = 0;
    const result = await new CombatBehavior().run({
      taskParams: { clearArea: true, targetEntityName: 'zombie' },
      getWorld: () => current,
      execute: async request => {
        calls++;
        if (request.type === 'kite') current = { ...current, entities: [] };
        return { ok: false, request, durationMs: 1, error: 'motor_preempted' };
      },
      publish: () => {},
    });
    assert.equal(result.ok, true);
    assert.equal(result.details?.recoveredAfterFailure, true);
    assert.equal(calls, 1);
  });
});
