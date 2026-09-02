import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateGoalCriteria, evaluateGoalCriteriaState, type GoalPredicateEvaluator } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/goalRunner/goalCriteriaEvaluator.js';
import { validatePredicateArguments } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/goalRunner/goalPredicateEvaluation.js';
import { worldFactIssue } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/goalRunner/worldFactValidation.js';
import { GoalAgentProductionVerificationPort } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/goalAgent/production/goalAgentProductionPorts.js';
import { __setTuningOverride } from '../../../../../../../apps/minecraft-companion/src/bot/v2/infra/tuning.js';
import type { WorldFact, WorldFactRequirement } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/contracts/worldFact.js';
import type { GoalSuccessCriterion } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/contracts/goalTypes.js';
import type { WorldStateView } from '../../../../../../../apps/minecraft-companion/src/bot/v2/types.js';

const now = Date.now();
const region = { min: { x: 0, y: 64, z: 0 }, max: { x: 3, y: 64, z: 3 } };
const requirement: WorldFactRequirement = { providerId: 'test.field', version: '1', dimension: 'overworld', region };
function world(): WorldStateView {
  return { tick: 1, timestamp: now, self: { position: { x: 0, y: 64, z: 0 }, yaw: 0, pitch: 0, health: 20, maxHealth: 20, food: 20, isOnGround: true },
    owner: null, environment: { dimension: 'overworld', timeOfDay: 1000, isDay: true, isRaining: false },
    entities: [], inventory: { items: [], held: null, freeSlots: 36 }, taskContext: null };
}
function fact(): WorldFact {
  return { providerId: 'test.field', version: '1', observedAt: now, complete: true, truncated: false,
    bounds: { dimension: 'overworld', region }, value: { present: true }, evidenceRefs: ['fact:test.field@1:bounded'] };
}
function predicate(): GoalPredicateEvaluator {
  return { id: 'test.crop_present', version: '1',
    argumentSchema: { type: 'object', additionalProperties: false, required: ['count'], properties: { count: { type: 'integer', minimum: 1 } } },
    factRequirements: () => [requirement],
    evaluate: ({ facts }) => ({ status: (facts?.[0]?.value as { present: boolean })?.present ? 'satisfied' : 'unsatisfied', detail: 'crop state checked' }),
  };
}
function criterion(): GoalSuccessCriterion { return { type: 'predicate', predicate: 'test.crop_present', predicateVersion: '1', args: { count: 1 } }; }
const goal = () => ({ goalText: 'check bounded crop', successCriteria: [criterion()] });
const evidence = (p = predicate(), facts: WorldFact[] = [fact()]) => ({ predicateEvaluators: [p], worldFacts: facts, now });

test('U06: parameter schema/version gate rejects malformed arguments before invoking the evaluator', () => {
  let calls = 0; const p = { ...predicate(), evaluate: () => { calls += 1; return { status: 'satisfied' as const, detail: 'must not execute' }; } };
  for (const invalid of [
    { ...criterion(), predicateVersion: '2' }, { ...criterion(), predicateVersion: undefined },
    { ...criterion(), args: {} }, { ...criterion(), args: { count: -1 } },
    { ...criterion(), args: { count: 1.5 } }, { ...criterion(), args: { count: Infinity } },
    { ...criterion(), args: { count: 1, script: 'run()' } }, { ...criterion(), args: { count: '1' } },
  ]) {
    assert.throws(() => validatePredicateArguments(invalid as GoalSuccessCriterion, p));
    assert.equal(evaluateGoalCriteriaState({ ...goal(), successCriteria: [invalid as GoalSuccessCriterion] }, world(), evidence(p)).status, 'unknown');
  }
  assert.equal(calls, 0);
});

test('U07: fresh complete matching facts alone may prove satisfied; provenance includes predicate version', () => {
  const verdict = evaluateGoalCriteriaState(goal(), world(), evidence());
  assert.equal(verdict.status, 'satisfied');
  assert.ok(verdict.evidenceRefs?.includes('fact:test.field@1:bounded'));
  assert.ok(verdict.evidenceRefs?.includes('predicate:test.crop_present@1'));
  assert.equal(evaluateGoalCriteria(goal(), world(), evidence()).ok, true);
  const missing = { ...fact(), value: { present: false } };
  assert.equal(evaluateGoalCriteriaState(goal(), world(), evidence(predicate(), [missing])).status, 'unsatisfied');
});

test('U07: missing, stale, truncated, unloaded, wrong dimension/version and insufficient coverage are unknown', () => {
  let calls = 0; const p = { ...predicate(), evaluate: () => { calls += 1; return { status: 'satisfied' as const, detail: 'must not execute' }; } };
  const variants: WorldFact[] = [
    { ...fact(), complete: false }, { ...fact(), truncated: true }, { ...fact(), observedAt: now - 6000 },
    { ...fact(), observedAt: now + 2000 }, { ...fact(), observedAt: NaN }, { ...fact(), version: '2' },
    { ...fact(), bounds: { dimension: 'the_nether', region } }, { ...fact(), bounds: { dimension: 'overworld' } },
    { ...fact(), bounds: { dimension: 'overworld', region: { ...region, max: { x: 2, y: 64, z: 2 } } } },
    { ...fact(), evidenceRefs: [] },
  ];
  for (const facts of [[], ...variants.map(value => [value])]) {
    assert.equal(evaluateGoalCriteriaState(goal(), world(), evidence(p, facts)).status, 'unknown');
    assert.equal(evaluateGoalCriteria(goal(), world(), evidence(p, facts)).ok, false);
  }
  assert.equal(calls, 0);
});

test('U07: world freshness and hot tuning are checked even if a fact itself looks fresh', () => {
  const snapshot = { ...world(), timestamp: now - 6000 };
  assert.equal(evaluateGoalCriteriaState(goal(), snapshot, evidence()).status, 'unknown');
  __setTuningOverride({ goalEvidence: { maxWorldAgeMs: 7000, maxFactAgeMs: 7000 } });
  try { assert.equal(evaluateGoalCriteriaState(goal(), snapshot, evidence()).status, 'satisfied'); }
  finally { __setTuningOverride(null); }
  assert.equal(evaluateGoalCriteriaState(goal(), snapshot, evidence()).status, 'unknown');
  assert.equal(worldFactIssue(fact(), { ...requirement, worldId: 'another-world' }, now), 'fact_world_mismatch');
});

test('U07: allOf implements three-state logic independent of condition ordering', () => {
  const statuses = ['satisfied', 'unsatisfied', 'unknown'] as const;
  for (const first of statuses) for (const second of statuses) {
    const criteria = ['a', 'b'].map(id => ({ type: 'predicate' as const, predicate: id, predicateVersion: '1', args: {} }));
    const evaluators: GoalPredicateEvaluator[] = [first, second].map((status, index) => ({
      id: index ? 'b' : 'a', version: '1', argumentSchema: { type: 'object', properties: {}, additionalProperties: false },
      evaluate: () => ({ status, detail: status }),
    }));
    const expected = [first, second].includes('unsatisfied') ? 'unsatisfied' : [first, second].includes('unknown') ? 'unknown' : 'satisfied';
    const input = { goalText: 'all', successCriteria: criteria }, data = { predicateEvaluators: evaluators, now };
    assert.equal(evaluateGoalCriteriaState(input, world(), data).status, expected);
    assert.equal(evaluateGoalCriteria(input, world(), data).ok, expected === 'satisfied');
  }
});

test('U07: versioned evaluators cannot use bool-only success, exceptions or duplicate identities as proof', () => {
  const base = predicate();
  assert.equal(evaluateGoalCriteriaState(goal(), world(), evidence({ ...base, evaluate: () => ({ ok: true, detail: 'legacy bool' }) })).status, 'unknown');
  assert.equal(evaluateGoalCriteriaState(goal(), world(), evidence({ ...base, evaluate: () => { throw new Error('offline'); } })).status, 'unknown');
  assert.equal(evaluateGoalCriteriaState(goal(), world(), { ...evidence(), predicateEvaluators: [base, base] }).status, 'unknown');
  assert.equal(evaluateGoalCriteriaState({ goalText: 'empty', successCriteria: [] }, world(), evidence()).status, 'unknown');
});

test('I02: production verification exposes unknown and cannot complete from missing facts or no-op receipts', () => {
  const verifier = new GoalAgentProductionVerificationPort(() => [], () => [], () => [], () => [predicate()]);
  const state = { rootGoal: { schema: 'mineclaw.goal/v1', goalId: 'g', profileId: 'p', createdAt: new Date(now).toISOString(),
    goalText: goal().goalText, successCriteria: goal().successCriteria }, world: { latest: world() } } as never;
  const result = verifier.verifyRoot({ state });
  assert.equal(result.status, 'unknown'); assert.equal(result.ok, false);
  assert.equal(evaluateGoalCriteria({ goalText: 'legacy', successCriteria: [{ type: 'predicate', predicate: 'legacy' }] }, world(), {
    predicateEvaluators: [{ id: 'legacy', evaluate: () => ({ ok: true, detail: 'legacy preserved' }) }],
  }).ok, true);
});
