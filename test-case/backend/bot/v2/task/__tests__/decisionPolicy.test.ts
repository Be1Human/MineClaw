/**
 * US-G2 · DecisionPolicy 单元测试
 *
 * 覆盖 6 种场景：
 *   ① no candidates → no_solution
 *   ② single full candidate → auto
 *   ③ single partial only → ask_master
 *   ④ two fulls, cost ratio >3x (2s vs 100s) → auto picks cheapest
 *   ⑤ two fulls, cost close (5s vs 7s) → escalate_llm
 *   ⑥ mixed full + partial → auto picks the full one
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DecisionPolicy } from '../../../../../../apps/minecraft-companion/src/bot/v2/task/decisionPolicy.js';
import type { ResourceCandidate } from '../../../../../../apps/minecraft-companion/src/bot/v2/task/resourceProvider.js';
import type { ResolutionResult } from '../../../../../../apps/minecraft-companion/src/bot/v2/task/resourceResolver.js';

// ── helpers ────────────────────────────────────────────────────────────────

function makeCandidate(overrides: Partial<ResourceCandidate>): ResourceCandidate {
  return {
    providerId: 'test',
    summary: 'test candidate',
    satisfaction: 'full',
    estimatedCostSec: 10,
    subtaskSuggestion: { kind: 'fetch_from_chest', params: {} },
    ...overrides,
  };
}

function makeResolution(candidates: ResourceCandidate[]): ResolutionResult {
  return {
    requirement: { kind: 'item', name: 'wooden_hoe', minDurability: 3 },
    candidates,
    hasFullSolution: candidates.some(c => c.satisfaction === 'full'),
  };
}

const policy = new DecisionPolicy();

// ── test cases ─────────────────────────────────────────────────────────────

test('① no candidates → no_solution', () => {
  const res = makeResolution([]);
  const verdict = policy.decide(res);
  assert.equal(verdict.kind, 'no_solution');
});

test('② single full candidate → auto with that candidate chosen', () => {
  const candidate = makeCandidate({ providerId: 'inventory', summary: 'has hoe', estimatedCostSec: 0 });
  const res = makeResolution([candidate]);
  const verdict = policy.decide(res);
  assert.equal(verdict.kind, 'auto');
  if (verdict.kind === 'auto') {
    assert.equal(verdict.chosen.providerId, 'inventory');
  }
});

test('③ only partial candidates (no full) → ask_master', () => {
  // A single candidate always hits the "唯一候选" fast-path → auto.
  // To reach ask_master we need ≥2 candidates, none of which is 'full'.
  const partialA = makeCandidate({
    providerId: 'inventoryA',
    satisfaction: 'partial',
    partialAmount: 1,
    summary: 'partial hoe A',
    estimatedCostSec: 0,
  });
  const partialB = makeCandidate({
    providerId: 'inventoryB',
    satisfaction: 'partial',
    partialAmount: 2,
    summary: 'partial hoe B',
    estimatedCostSec: 5,
  });
  const res = makeResolution([partialA, partialB]);
  const verdict = policy.decide(res);
  assert.equal(verdict.kind, 'ask_master');
  if (verdict.kind === 'ask_master') {
    assert.ok(typeof verdict.question === 'string' && verdict.question.length > 0);
    assert.ok(Array.isArray(verdict.candidates));
  }
});

test('④ two fulls, cost ratio >3x (2s vs 100s) → auto picks cheapest', () => {
  const cheap = makeCandidate({ providerId: 'cheap', estimatedCostSec: 2, summary: 'cheap option' });
  const expensive = makeCandidate({ providerId: 'expensive', estimatedCostSec: 100, summary: 'expensive option' });
  // resolver sorts by cost ascending → cheap first
  const res = makeResolution([cheap, expensive]);
  const verdict = policy.decide(res);
  assert.equal(verdict.kind, 'auto');
  if (verdict.kind === 'auto') {
    assert.equal(verdict.chosen.providerId, 'cheap');
    assert.equal(verdict.chosen.estimatedCostSec, 2);
  }
});

test('⑤ two fulls, cost close (5s vs 7s) → escalate_llm', () => {
  const a = makeCandidate({ providerId: 'providerA', estimatedCostSec: 5, summary: 'option A' });
  const b = makeCandidate({ providerId: 'providerB', estimatedCostSec: 7, summary: 'option B' });
  const res = makeResolution([a, b]);
  const verdict = policy.decide(res);
  assert.equal(verdict.kind, 'escalate_llm');
  if (verdict.kind === 'escalate_llm') {
    assert.ok(Array.isArray(verdict.candidates));
    assert.ok(verdict.candidates.length >= 2);
  }
});

test('⑥ mixed full + partial → auto picks the full one', () => {
  const full = makeCandidate({ providerId: 'full_provider', satisfaction: 'full', estimatedCostSec: 30, summary: 'full option' });
  const partial = makeCandidate({ providerId: 'partial_provider', satisfaction: 'partial', estimatedCostSec: 0, summary: 'partial option', partialAmount: 1 });
  // resolver sorts: full before partial → [full, partial]
  const res = makeResolution([full, partial]);
  const verdict = policy.decide(res);
  assert.equal(verdict.kind, 'auto');
  if (verdict.kind === 'auto') {
    assert.equal(verdict.chosen.satisfaction, 'full');
    assert.equal(verdict.chosen.providerId, 'full_provider');
  }
});
