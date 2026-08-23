/**
 * Unit tests for ResourceResolver
 * Framework: node:test + node:assert/strict
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ResourceResolver } from '../../../../../../apps/minecraft-companion/src/bot/v2/task/resourceResolver.js';
import type { IResourceProvider, ResourceCandidate, ResourceRequirement } from '../../../../../../apps/minecraft-companion/src/bot/v2/task/resourceProvider.js';
import type { WorldStateView } from '../../../../../../apps/minecraft-companion/src/bot/v2/types.js';

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

const hoeReq: ResourceRequirement = { kind: 'item', name: 'wooden_hoe', minDurability: 3 };

/** Build a simple stub provider with a fixed response */
function stubProvider(id: string, candidates: ResourceCandidate[]): IResourceProvider {
  return {
    id,
    provide(_req: ResourceRequirement, _world: WorldStateView): ResourceCandidate[] {
      return candidates;
    },
  };
}

/** Build a provider that always throws */
function throwingProvider(id: string): IResourceProvider {
  return {
    id,
    provide(_req: ResourceRequirement, _world: WorldStateView): ResourceCandidate[] {
      throw new Error(`${id} exploded`);
    },
  };
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('ResourceResolver', () => {
  it('full candidates appear before partial candidates', () => {
    const resolver = new ResourceResolver();

    const partialCandidate: ResourceCandidate = {
      providerId: 'p1',
      summary: 'partial only',
      estimatedCostSec: 1,
      subtaskSuggestion: null,
      satisfaction: 'partial',
    };
    const fullCandidate: ResourceCandidate = {
      providerId: 'p2',
      summary: 'full solution',
      estimatedCostSec: 5, // higher cost but should still sort before partial
      subtaskSuggestion: null,
      satisfaction: 'full',
    };

    resolver.register(stubProvider('p1', [partialCandidate]));
    resolver.register(stubProvider('p2', [fullCandidate]));

    const result = resolver.resolve(hoeReq, makeWorld());

    assert.equal(result.candidates.length, 2);
    assert.equal(result.candidates[0].satisfaction, 'full', 'first candidate should be full');
    assert.equal(result.candidates[1].satisfaction, 'partial', 'second candidate should be partial');
  });

  it('candidates with same satisfaction level sort by estimatedCostSec ascending', () => {
    const resolver = new ResourceResolver();

    const cheap: ResourceCandidate = {
      providerId: 'cheap',
      summary: 'cheap full',
      estimatedCostSec: 2,
      subtaskSuggestion: null,
      satisfaction: 'full',
    };
    const expensive: ResourceCandidate = {
      providerId: 'expensive',
      summary: 'expensive full',
      estimatedCostSec: 10,
      subtaskSuggestion: null,
      satisfaction: 'full',
    };
    const medium: ResourceCandidate = {
      providerId: 'medium',
      summary: 'medium full',
      estimatedCostSec: 5,
      subtaskSuggestion: null,
      satisfaction: 'full',
    };

    resolver.register(stubProvider('expensive', [expensive]));
    resolver.register(stubProvider('medium', [medium]));
    resolver.register(stubProvider('cheap', [cheap]));

    const result = resolver.resolve(hoeReq, makeWorld());

    assert.equal(result.candidates.length, 3);
    assert.equal(result.candidates[0].estimatedCostSec, 2, 'cheapest should be first');
    assert.equal(result.candidates[1].estimatedCostSec, 5, 'medium cost should be second');
    assert.equal(result.candidates[2].estimatedCostSec, 10, 'most expensive should be last');
  });

  it('provider that throws is swallowed and other providers still contribute candidates', () => {
    const resolver = new ResourceResolver();

    const goodCandidate: ResourceCandidate = {
      providerId: 'good',
      summary: 'working provider',
      estimatedCostSec: 3,
      subtaskSuggestion: null,
      satisfaction: 'full',
    };

    resolver.register(throwingProvider('bad'));
    resolver.register(stubProvider('good', [goodCandidate]));

    // Should not throw
    let result: ReturnType<typeof resolver.resolve>;
    assert.doesNotThrow(() => {
      result = resolver.resolve(hoeReq, makeWorld());
    });

    // The good provider's candidate should still be present
    const goodCandidates = result!.candidates.filter(c => c.providerId === 'good');
    assert.equal(goodCandidates.length, 1, 'good provider candidate should be present');

    // The bad provider should produce a 'none' error candidate
    const badCandidates = result!.candidates.filter(c => c.providerId === 'bad');
    assert.equal(badCandidates.length, 1, 'bad provider should produce an error candidate');
    assert.equal(badCandidates[0].satisfaction, 'none', 'error candidate should have satisfaction=none');
    assert.equal(badCandidates[0].estimatedCostSec, Infinity);
  });

  it('hasFullSolution is true when at least one candidate has satisfaction=full', () => {
    const resolver = new ResourceResolver();

    resolver.register(stubProvider('p1', [
      { providerId: 'p1', summary: 'partial', estimatedCostSec: 1, subtaskSuggestion: null, satisfaction: 'partial' },
    ]));
    resolver.register(stubProvider('p2', [
      { providerId: 'p2', summary: 'full', estimatedCostSec: 8, subtaskSuggestion: null, satisfaction: 'full' },
    ]));

    const result = resolver.resolve(hoeReq, makeWorld());

    assert.equal(result.hasFullSolution, true);
  });

  it('hasFullSolution is false when no candidate has satisfaction=full', () => {
    const resolver = new ResourceResolver();

    resolver.register(stubProvider('p1', [
      { providerId: 'p1', summary: 'partial', estimatedCostSec: 1, subtaskSuggestion: null, satisfaction: 'partial' },
    ]));

    const result = resolver.resolve(hoeReq, makeWorld());

    assert.equal(result.hasFullSolution, false);
  });

  it('returns empty candidates and hasFullSolution=false when no providers registered', () => {
    const resolver = new ResourceResolver();

    const result = resolver.resolve(hoeReq, makeWorld());

    assert.equal(result.candidates.length, 0);
    assert.equal(result.hasFullSolution, false);
  });
});
