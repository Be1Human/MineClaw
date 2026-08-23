/**
 * Unit tests for built-in IResourceProvider implementations:
 *   InventoryProvider, CraftProvider, ChestMemoryProvider
 * Framework: node:test + node:assert/strict
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';

import {
  InventoryProvider,
  CraftProvider,
  ChestMemoryProvider,
} from '../../../../../../apps/minecraft-companion/src/bot/v2/task/resourceProvider.js';
import type { ResourceRequirement } from '../../../../../../apps/minecraft-companion/src/bot/v2/task/resourceProvider.js';
import type { WorldStateView, InventoryItemView } from '../../../../../../apps/minecraft-companion/src/bot/v2/types.js';
import { MemoryV2 } from '../../../../../../apps/minecraft-companion/src/bot/v2/infra/memory.js';

// ── helpers ──────────────────────────────────────────────────────────────────

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

function makeItem(overrides: Partial<InventoryItemView> & { name: string; count: number; slot: number }): InventoryItemView {
  return { ...overrides };
}

const hoeReq: ResourceRequirement = { kind: 'item', name: 'wooden_hoe', minDurability: 3 };

// ── InventoryProvider ─────────────────────────────────────────────────────────

describe('InventoryProvider', () => {
  const provider = new InventoryProvider();

  it('has enough hoe durability → returns one full candidate', () => {
    const world = makeWorld({
      inventory: {
        items: [makeItem({ name: 'wooden_hoe', count: 1, slot: 0, durability: 10, maxDurability: 59 })],
        held: null,
        freeSlots: 35,
      },
    });

    const candidates = provider.provide(hoeReq, world);

    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].satisfaction, 'full');
    assert.equal(candidates[0].providerId, 'inventory');
    assert.equal(candidates[0].estimatedCostSec, 0);
  });

  it('hoe present but insufficient durability → returns one partial candidate', () => {
    // minDurability is 3, hoe only has 1 durability left
    const world = makeWorld({
      inventory: {
        items: [makeItem({ name: 'wooden_hoe', count: 1, slot: 0, durability: 1, maxDurability: 59 })],
        held: null,
        freeSlots: 35,
      },
    });

    const candidates = provider.provide(hoeReq, world);

    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].satisfaction, 'partial');
    assert.equal(candidates[0].providerId, 'inventory');
    assert.equal(candidates[0].partialAmount, 1, 'partialAmount should equal remaining durability');
  });

  it('no hoe at all → returns empty candidates array', () => {
    const world = makeWorld({
      inventory: {
        items: [makeItem({ name: 'stick', count: 5, slot: 0 })],
        held: null,
        freeSlots: 35,
      },
    });

    const candidates = provider.provide(hoeReq, world);

    assert.equal(candidates.length, 0);
  });
});

// ── CraftProvider ─────────────────────────────────────────────────────────────

describe('CraftProvider', () => {
  const provider = new CraftProvider();

  it('has enough sticks and planks → returns full candidate with craft_item subtask', () => {
    const world = makeWorld({
      inventory: {
        items: [
          makeItem({ name: 'stick', count: 4, slot: 0 }),
          makeItem({ name: 'oak_planks', count: 4, slot: 1 }),
        ],
        held: null,
        freeSlots: 34,
      },
    });

    const candidates = provider.provide(hoeReq, world);

    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].satisfaction, 'full');
    assert.equal(candidates[0].providerId, 'craft');
    assert.ok(candidates[0].subtaskSuggestion, 'should have a subtask suggestion');
    assert.equal(candidates[0].subtaskSuggestion!.kind, 'craft_item');
  });

  it('not enough materials → returns candidate with mine_then_craft subtask (satisfaction=full per implementation)', () => {
    // Provider currently marks this as 'full' with mine_then_craft suggestion
    // (implementation decision: "need to gather first" is still considered solvable)
    const world = makeWorld({
      inventory: {
        items: [
          makeItem({ name: 'stick', count: 1, slot: 0 }), // need 2, only 1
          makeItem({ name: 'oak_planks', count: 1, slot: 1 }), // need 2, only 1
        ],
        held: null,
        freeSlots: 34,
      },
    });

    const candidates = provider.provide(hoeReq, world);

    // Implementation always returns a candidate (either craft_item or mine_then_craft)
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].providerId, 'craft');
    assert.ok(candidates[0].subtaskSuggestion, 'should have a subtask suggestion');
    assert.equal(candidates[0].subtaskSuggestion!.kind, 'mine_then_craft');
    // Cost is higher since gathering is required
    assert.ok(candidates[0].estimatedCostSec > 8, 'gathering cost should exceed direct craft cost');
  });

  it('non-hoe requirement → provider returns empty (does not handle non-hoe items)', () => {
    const pickaxeReq: ResourceRequirement = { kind: 'item', name: 'wooden_pickaxe', minDurability: 3 };
    const world = makeWorld();

    const candidates = provider.provide(pickaxeReq, world);

    assert.equal(candidates.length, 0, 'CraftProvider should not handle non-hoe items');
  });
});

// ── ChestMemoryProvider ───────────────────────────────────────────────────────

describe('ChestMemoryProvider', () => {
  let memory: MemoryV2;
  let tmpDbPath: string;

  before(() => {
    // Use a temp file for SQLite so tests are isolated
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'minefriend-test-'));
    tmpDbPath = path.join(tmpDir, 'test-memory.db');
    memory = new MemoryV2(tmpDbPath);
  });

  after(() => {
    memory.close();
    // Clean up temp db file
    try { fs.unlinkSync(tmpDbPath); } catch { /* ignore */ }
  });

  it('no chests in memory → returns empty candidates array', () => {
    const provider = new ChestMemoryProvider(memory);
    const world = makeWorld();

    const candidates = provider.provide(hoeReq, world);

    assert.equal(candidates.length, 0);
  });

  it('chest in memory containing matching item → returns full candidate with distance-based cost', () => {
    // Record a chest at a known position with wooden_hoe in it
    memory.record('spatial', {
      kind: 'chest',
      position: { x: 43, y: 64, z: 0 }, // 43 blocks away from origin on X axis
      meta: { items: ['wooden_hoe', 'stick'] },
      timestamp: Date.now(),
    });

    const provider = new ChestMemoryProvider(memory);
    const world = makeWorld({
      self: { position: { x: 0, y: 64, z: 0 }, yaw: 0, pitch: 0, health: 20, maxHealth: 20, food: 20, isOnGround: true },
    });

    const candidates = provider.provide(hoeReq, world);

    assert.equal(candidates.length, 1, 'should find exactly one chest candidate');
    assert.equal(candidates[0].satisfaction, 'full');
    assert.equal(candidates[0].providerId, 'chest_memory');

    // Distance is 43 blocks, cost = 43 / 4.3 = ~10s
    const expectedCost = 43 / 4.3;
    assert.ok(
      Math.abs(candidates[0].estimatedCostSec - expectedCost) < 0.01,
      `expected cost ~${expectedCost.toFixed(2)}s, got ${candidates[0].estimatedCostSec}`,
    );

    // Should have fetch_from_chest subtask
    assert.ok(candidates[0].subtaskSuggestion, 'should have subtask suggestion');
    assert.equal(candidates[0].subtaskSuggestion!.kind, 'fetch_from_chest');
  });

  it('chest in memory but item not in chest → returns empty candidates', () => {
    // Use a fresh memory instance to avoid state from previous test
    const tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'minefriend-test2-'));
    const tmpDb2 = path.join(tmpDir2, 'test-memory2.db');
    const memory2 = new MemoryV2(tmpDb2);

    try {
      memory2.record('spatial', {
        kind: 'chest',
        position: { x: 10, y: 64, z: 10 },
        meta: { items: ['dirt', 'cobblestone'] }, // no wooden_hoe
        timestamp: Date.now(),
      });

      const provider = new ChestMemoryProvider(memory2);
      const world = makeWorld();
      const candidates = provider.provide(hoeReq, world);

      assert.equal(candidates.length, 0, 'chest without matching item should produce no candidates');
    } finally {
      memory2.close();
      try { fs.unlinkSync(tmpDb2); } catch { /* ignore */ }
    }
  });
});
