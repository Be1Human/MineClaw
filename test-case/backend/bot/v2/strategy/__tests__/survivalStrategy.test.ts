import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { SurvivalStrategy, type SurvivalPolicy } from '../../../../../../apps/minecraft-companion/src/bot/v2/strategy/survivalStrategy.js';
import type { EntityView, InventoryView, WorldStateView } from '../../../../../../apps/minecraft-companion/src/bot/v2/types.js';
import type { StrategyContext } from '../../../../../../apps/minecraft-companion/src/bot/v2/strategy/types.js';

const POLICY: SurvivalPolicy = {
  dangerRange: 14,
  criticalHealth: 8,
  eatHealth: 16,
  hungerEatFood: 17,
  safeEatDistance: 6,
  fightHealth: 12,
  fightRange: 5,
  fightCrowdRange: 12,
  corneredTicks: 6,
  corneredNoGain: 0.8,
  fleeDistance: 22,
  sayCooldownMs: 0,
  shelterBlockCount: 4,
  shelterHoldTicks: 200,
  fleeTimeoutMs: 8_000,
  attackTimeoutMs: 4_000,
  eatTimeoutMs: 3_000,
  shelterStepTimeoutMs: 2_000,
};

function world(overrides: Partial<WorldStateView> = {}): WorldStateView {
  return {
    tick: 1,
    timestamp: 1,
    self: { position: { x: 100, y: 64, z: 200 }, yaw: 0, pitch: 0, health: 20, maxHealth: 20, food: 20, isOnGround: true },
    owner: null,
    environment: { dimension: 'overworld', timeOfDay: 6000, isDay: true, isRaining: false },
    entities: [],
    inventory: { items: [], held: null, freeSlots: 36 },
    taskContext: null,
    ...overrides,
  };
}

function hostile(distance: number, id = 7): EntityView {
  return {
    id,
    name: 'zombie',
    type: 'mob',
    position: { x: 100 + distance, y: 64, z: 200 },
    distance,
    category: 'hostile',
  };
}

function inventory(items: Array<{ name: string; count: number }>): InventoryView {
  return { items: items.map((item, slot) => ({ ...item, slot })), held: null, freeSlots: 36 - items.length };
}

function ctx(input: WorldStateView, activeTaskId: string | null = 'task-live'): StrategyContext {
  return {
    world: input,
    tick: input.tick,
    activeTaskId,
    activeTaskKind: activeTaskId ? 'follow_owner' : null,
  };
}

describe('SurvivalStrategy generic fallback contract', () => {
  it('does not create work without a current task to back it', () => {
    const strategy = new SurvivalStrategy(() => POLICY);
    const output = strategy.tick(ctx(world({ entities: [hostile(2)] }), null));

    assert.deepEqual(output, []);
    assert.equal((strategy.inspect().view as { mode: string }).mode, 'unbacked');
  });

  it('uses a closed attack atomic for a healthy lone close hostile', () => {
    const strategy = new SurvivalStrategy(() => POLICY);
    const output = strategy.tick(ctx(world({
      entities: [hostile(3)],
      inventory: inventory([{ name: 'iron_sword', count: 1 }]),
    })));

    assert.equal(output.length, 1);
    assert.equal(output[0]?.type, 'attack');
    assert.equal(output[0]?.target?.entityId, 7);
    assert.equal(output[0]?.taskId, undefined, 'Heartbeat—not Survival—adds the active task backing');
  });

  it('uses an emergency eat atomic at full hunger when a golden apple is available', () => {
    const strategy = new SurvivalStrategy(() => POLICY);
    const output = strategy.tick(ctx(world({
      self: { position: { x: 100, y: 64, z: 200 }, yaw: 0, pitch: 0, health: 6, maxHealth: 20, food: 20, isOnGround: true },
      entities: [hostile(2)],
      inventory: inventory([{ name: 'golden_apple', count: 1 }]),
    })));

    assert.equal(output.length, 1);
    assert.equal(output[0]?.type, 'eat');
    assert.equal(output[0]?.target?.emergency, true);
  });

  it('uses normal eat only after a safe window for hunger-driven regeneration', () => {
    const strategy = new SurvivalStrategy(() => POLICY);
    const output = strategy.tick(ctx(world({
      self: { position: { x: 100, y: 64, z: 200 }, yaw: 0, pitch: 0, health: 10, maxHealth: 20, food: 10, isOnGround: true },
      entities: [hostile(10)],
      inventory: inventory([{ name: 'bread', count: 3 }]),
    })));

    assert.equal(output.length, 1);
    assert.equal(output[0]?.type, 'eat');
    assert.equal(output[0]?.target?.emergency, false);
  });

  it('retreats through a concrete move_to target when critically hurt without emergency food', () => {
    const strategy = new SurvivalStrategy(() => POLICY);
    const output = strategy.tick(ctx(world({
      self: { position: { x: 100, y: 64, z: 200 }, yaw: 0, pitch: 0, health: 4, maxHealth: 20, food: 20, isOnGround: true },
      entities: [hostile(4)],
    })));

    assert.equal(output.length, 1);
    assert.equal(output[0]?.type, 'move_to');
    assert.ok(output[0]?.target?.position);
    assert.notEqual(output[0]?.target?.position?.x, 100);
  });

  it('reads danger range from its injected runtime policy', () => {
    const strategy = new SurvivalStrategy(() => ({ ...POLICY, dangerRange: 1 }));
    const output = strategy.tick(ctx(world({
      entities: [hostile(3)],
      inventory: inventory([{ name: 'iron_sword', count: 1 }]),
    })));

    assert.deepEqual(output, []);
  });

  it('never exposes a raw invoke_behavior fallback', () => {
    const strategy = new SurvivalStrategy(() => POLICY);
    const output = strategy.tick(ctx(world({ entities: [hostile(3)], inventory: inventory([{ name: 'iron_sword', count: 1 }]) })));
    assert.equal(output.some(request => request.type === 'invoke_behavior'), false);
  });
});
