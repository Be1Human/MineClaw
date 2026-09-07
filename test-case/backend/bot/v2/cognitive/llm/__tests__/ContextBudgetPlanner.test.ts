import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  ContextBudgetPlanner,
  ContextBudgetPolicySnapshotter,
  type ContextBudgetPurposePolicyV1,
  type FrozenContextBudgetPolicyV1,
} from '../../../../../../../apps/minecraft-companion/src/bot/v2/cognitive/llm/contextBudget.js';
import type { ModelContextProfileV1 } from '../../../../../../../apps/minecraft-companion/src/llm/modelContextProfile.js';
import type { TokenMeasureV1 } from '../../../../../../../apps/minecraft-companion/src/bot/v2/cognitive/llm/requestTokenMeter.js';
import { __setTuningOverride, tuning } from '../../../../../../../apps/minecraft-companion/src/bot/v2/infra/tuning.js';

const profile = (accounting: ModelContextProfileV1['windowAccounting'] = 'input_plus_output'): ModelContextProfileV1 => ({
  schema: 'mineclaw.model-context-profile/v1', profileId: 'budget-profile', routeId: 'route-budget',
  model: 'model-budget', api: 'openai-completions', contextWindowTokens: 100_000, maxOutputTokens: 20_000,
  windowAccounting: accounting, tokenizerRef: 'fixture',
  source: { kind: 'explicit_config', version: 'v1', verifiedAt: '2026-09-06T00:00:00.000Z' },
});

const policy: FrozenContextBudgetPolicyV1 = {
  purpose: 'test', revision: 'policy-v1', source: 'current',
  softInputLimitTokens: 80_000,
  minimumSafetyReserveTokens: 4_000,
  safetyReserveRatio: 0.05,
  compactionTriggerRatio: 0.85,
  compactionTargetRatio: 0.70,
  minimumRecentHistoryTokens: 16_000,
  maxSummaryTokens: 8_000,
};

const measure = (tokens: number, upperBoundTokens = tokens): TokenMeasureV1 => ({
  schema: 'mineclaw.token-measure/v1', tokens, upperBoundTokens,
  precision: tokens === upperBoundTokens ? 'exact' : 'conservative_upper_bound',
  tokenizerRef: 'fixture', sectionTokens: [],
});

const plan = (overrides: Partial<Parameters<ContextBudgetPlanner['plan']>[0]> = {}) => new ContextBudgetPlanner().plan({
  profile: profile(), measure: measure(10_000), policy, requestedOutputTokens: 10_000, ...overrides,
});

afterEach(() => __setTuningOverride(null));

describe('FEAT-CROSS-29 · ContextBudgetPlanner', () => {
  it('BP-01 subtracts requested output for input_plus_output windows', () => {
    const result = plan();
    assert.equal(result.hardInputLimitTokens, 90_000);
    assert.equal(result.softInputLimitTokens, 80_000);
  });

  it('BP-02 keeps the full hard input for input_only windows', () => {
    const result = plan({ profile: profile('input_only') });
    assert.equal(result.hardInputLimitTokens, 100_000);
  });

  it('BP-03 rejects output above the physical model maximum', () => {
    const result = plan({ requestedOutputTokens: 20_001 });
    assert.equal(result.action, 'reject');
    assert.equal(result.reason, 'requested_output_exceeds_model_limit');
  });

  it('BP-04 never lets a soft policy enlarge a smaller physical window', () => {
    const result = plan({
      profile: { ...profile(), contextWindowTokens: 65_536 },
      policy: { ...policy, softInputLimitTokens: 131_072 },
    });
    assert.equal(result.hardInputLimitTokens, 55_536);
    assert.equal(result.softInputLimitTokens, 55_536);
  });

  it('BP-05 reserves the maximum of minimum, ratio and measurement uncertainty', () => {
    const minimum = plan({ measure: measure(10_000, 11_000) });
    assert.equal(minimum.safetyReserveTokens, 4_000);
    const ratio = plan({ policy: { ...policy, minimumSafetyReserveTokens: 1_000, safetyReserveRatio: 0.10 } });
    assert.equal(ratio.safetyReserveTokens, 8_000);
    const uncertainty = plan({ measure: measure(10_000, 30_000) });
    assert.equal(uncertainty.safetyReserveTokens, 20_000);
  });

  it('BP-06 keeps input at or below the trigger', () => {
    const result = plan({ measure: measure(64_600) });
    assert.equal(result.dispatchLimitTokens, 76_000);
    assert.equal(result.triggerTokens, 64_600);
    assert.equal(result.action, 'keep');
  });

  it('BP-07 requests reduction above the trigger or dispatch limit', () => {
    assert.equal(plan({ measure: measure(64_601) }).action, 'reduce');
    const over = plan({ measure: measure(76_001) });
    assert.equal(over.action, 'reduce');
    assert.equal(over.reason, 'context_exceeds_dispatch_limit');
  });

  it('BP-08 rejects when required surface alone exceeds dispatch capacity', () => {
    const result = plan({ requiredSurfaceUpperBoundTokens: 76_001 });
    assert.equal(result.action, 'reject');
    assert.equal(result.reason, 'context_required_surface_exceeds_budget');
  });

  it('BP-09 accepts a remeasurement above target but within dispatch limit with evidence', () => {
    const result = plan({ measure: measure(70_000), measuredAfterTokens: 60_000 });
    assert.equal(result.action, 'keep');
    assert.equal(result.reason, 'target_not_reached_but_dispatch_safe');
    assert.equal(result.measuredAfterTokens, 60_000);
  });

  it('BP-10 rejects a reducer result that remains over dispatch limit', () => {
    const result = plan({ measure: measure(90_000), measuredAfterTokens: 76_001 });
    assert.equal(result.action, 'reject');
    assert.equal(result.reason, 'context_reduction_insufficient');
  });
});

describe('FEAT-CROSS-29 · versioned hot policy snapshots', () => {
  it('PF-02 freezes distinct GoalAgent, MainBrain and background defaults', () => {
    const snapshotter = new ContextBudgetPolicySnapshotter();
    const config = tuning().agentContext;
    const goal = snapshotter.snapshot(config, 'goalAgent');
    const main = snapshotter.snapshot(config, 'mainBrain');
    const background = snapshotter.snapshot(config, 'background');
    assert.equal(goal.kind, 'resolved');
    assert.equal(main.kind, 'resolved');
    assert.equal(background.kind, 'resolved');
    if (goal.kind === 'resolved' && main.kind === 'resolved' && background.kind === 'resolved') {
      assert.equal(goal.policy.softInputLimitTokens, 131_072);
      assert.equal(main.policy.softInputLimitTokens, 32_768);
      assert.equal(background.policy.softInputLimitTokens, 16_384);
      assert.ok(Object.isFrozen(goal.policy));
    }
  });

  it('PF-04 keeps the last valid snapshot when a hot reload is invalid', () => {
    const snapshotter = new ContextBudgetPolicySnapshotter();
    const current = snapshotter.snapshot(tuning().agentContext, 'goalAgent');
    assert.equal(current.kind, 'resolved');
    __setTuningOverride({ agentContext: { purposes: { goalAgent: { compactionTargetRatio: 0.99 } } } });
    const fallback = snapshotter.snapshot(tuning().agentContext, 'goalAgent');
    assert.equal(fallback.kind, 'resolved');
    if (fallback.kind === 'resolved') {
      assert.equal(fallback.policy.source, 'last_valid');
      assert.equal(fallback.policy.compactionTargetRatio, 0.70);
    }
  });

  it('PF-05 reports invalid initial and missing-purpose policies instead of inventing defaults', () => {
    const snapshotter = new ContextBudgetPolicySnapshotter();
    const invalid: ContextBudgetPurposePolicyV1 = { ...policy, compactionTargetRatio: 0.90 };
    const first = snapshotter.snapshot({ revision: 'bad', purposes: { broken: invalid } }, 'broken');
    assert.equal(first.kind, 'unavailable');
    const missing = snapshotter.snapshot({ revision: 'v1', purposes: {} }, 'missing');
    assert.equal(missing.kind, 'unavailable');
  });
});
