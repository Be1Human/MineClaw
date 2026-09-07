import type { ModelContextProfileV1 } from '../../../../llm/modelContextProfile.js';
import type { TokenMeasureV1 } from './requestTokenMeter.js';

export const CONTEXT_BUDGET_DECISION_SCHEMA = 'mineclaw.context-budget-decision/v1' as const;

export interface ContextBudgetPurposePolicyV1 {
  softInputLimitTokens: number;
  minimumSafetyReserveTokens: number;
  safetyReserveRatio: number;
  compactionTriggerRatio: number;
  compactionTargetRatio: number;
  minimumRecentHistoryTokens: number;
  maxSummaryTokens: number;
}

export interface AgentContextPolicyConfigV1 {
  revision: string;
  purposes: Readonly<Record<string, ContextBudgetPurposePolicyV1>>;
}

export interface FrozenContextBudgetPolicyV1 extends ContextBudgetPurposePolicyV1 {
  purpose: string;
  revision: string;
  source: 'current' | 'last_valid';
}

export type ContextBudgetPolicySnapshotResult =
  | { kind: 'resolved'; policy: Readonly<FrozenContextBudgetPolicyV1> }
  | { kind: 'unavailable'; purpose: string; reason: 'purpose_not_configured' | 'invalid_policy'; detail: string };

export interface ContextBudgetDecisionV1 {
  schema: typeof CONTEXT_BUDGET_DECISION_SCHEMA;
  action: 'keep' | 'reduce' | 'reject';
  hardInputLimitTokens: number;
  softInputLimitTokens: number;
  dispatchLimitTokens: number;
  triggerTokens: number;
  targetTokens: number;
  safetyReserveTokens: number;
  uncertaintyReserveTokens: number;
  requestedOutputTokens: number;
  measuredBeforeTokens: number;
  measuredAfterTokens?: number;
  reason: string;
  policyRevision: string;
}

export interface ContextBudgetPlanInput {
  profile: Readonly<ModelContextProfileV1>;
  measure: Readonly<TokenMeasureV1>;
  policy: Readonly<FrozenContextBudgetPolicyV1>;
  requestedOutputTokens: number;
  requiredSurfaceUpperBoundTokens?: number;
  measuredAfterTokens?: number;
  measureAfter?: Readonly<TokenMeasureV1>;
}

/**
 * Keeps the last valid per-purpose snapshot. Invalid hot reloads never replace
 * the valid state and are reported as last_valid, not silently accepted.
 */
export class ContextBudgetPolicySnapshotter {
  private readonly lastValid = new Map<string, Readonly<FrozenContextBudgetPolicyV1>>();

  snapshot(config: Readonly<AgentContextPolicyConfigV1>, purpose: string): ContextBudgetPolicySnapshotResult {
    const raw = config.purposes[purpose];
    if (!raw) return unavailablePolicy(purpose, 'purpose_not_configured', `no context budget policy for ${purpose}`);
    const problem = validatePurposePolicy(raw);
    if (problem || !config.revision.trim()) {
      const previous = this.lastValid.get(purpose);
      if (previous) return { kind: 'resolved', policy: Object.freeze({ ...previous, source: 'last_valid' }) };
      return unavailablePolicy(purpose, 'invalid_policy', problem ?? 'revision is required');
    }
    const policy = Object.freeze({
      ...raw,
      purpose,
      revision: config.revision,
      source: 'current' as const,
    });
    this.lastValid.set(purpose, policy);
    return { kind: 'resolved', policy };
  }
}

/** Provider- and Agent-neutral pure budget calculation. */
export class ContextBudgetPlanner {
  plan(input: Readonly<ContextBudgetPlanInput>): Readonly<ContextBudgetDecisionV1> {
    const policyProblem = validatePurposePolicy(input.policy);
    if (policyProblem) return rejectDecision(input, 'invalid_policy', zeroLimits(input));
    if (!nonNegativeSafeInteger(input.requestedOutputTokens)) {
      return rejectDecision(input, 'requested_output_invalid', zeroLimits(input));
    }
    if (input.requestedOutputTokens > input.profile.maxOutputTokens) {
      return rejectDecision(input, 'requested_output_exceeds_model_limit', zeroLimits(input));
    }

    const hardInputLimitTokens = input.profile.windowAccounting === 'input_plus_output'
      ? input.profile.contextWindowTokens - input.requestedOutputTokens
      : input.profile.contextWindowTokens;
    if (hardInputLimitTokens <= 0) {
      return rejectDecision(input, 'no_input_capacity_after_output_reserve', {
        hardInputLimitTokens: Math.max(0, hardInputLimitTokens),
        softInputLimitTokens: 0,
        dispatchLimitTokens: 0,
        triggerTokens: 0,
        targetTokens: 0,
        safetyReserveTokens: 0,
        uncertaintyReserveTokens: uncertainty(input.measure),
      });
    }

    const softInputLimitTokens = Math.min(hardInputLimitTokens, input.policy.softInputLimitTokens);
    const uncertaintyReserveTokens = uncertainty(input.measureAfter ?? input.measure);
    const safetyReserveTokens = Math.max(
      input.policy.minimumSafetyReserveTokens,
      Math.ceil(softInputLimitTokens * input.policy.safetyReserveRatio),
      uncertaintyReserveTokens,
    );
    const dispatchLimitTokens = Math.max(0, softInputLimitTokens - safetyReserveTokens);
    const triggerTokens = Math.floor(dispatchLimitTokens * input.policy.compactionTriggerRatio);
    const targetTokens = Math.floor(dispatchLimitTokens * input.policy.compactionTargetRatio);
    const limits = {
      hardInputLimitTokens,
      softInputLimitTokens,
      dispatchLimitTokens,
      triggerTokens,
      targetTokens,
      safetyReserveTokens,
      uncertaintyReserveTokens,
    };
    const required = input.requiredSurfaceUpperBoundTokens;
    if (required !== undefined && (!nonNegativeSafeInteger(required) || required > dispatchLimitTokens)) {
      return rejectDecision(
        input,
        nonNegativeSafeInteger(required) ? 'context_required_surface_exceeds_budget' : 'required_surface_measure_invalid',
        limits,
      );
    }

    const measuredAfterTokens = input.measureAfter?.upperBoundTokens ?? input.measuredAfterTokens;
    const measured = measuredAfterTokens ?? input.measure.upperBoundTokens;
    if (!nonNegativeSafeInteger(measured)) return rejectDecision(input, 'measured_tokens_invalid', limits);
    if (measuredAfterTokens !== undefined && measured > dispatchLimitTokens) {
      return rejectDecision(input, 'context_reduction_insufficient', limits);
    }
    if (measured > dispatchLimitTokens) return decision(input, 'reduce', 'context_exceeds_dispatch_limit', limits);
    if (measuredAfterTokens !== undefined && measured > targetTokens) {
      return decision(input, 'keep', 'target_not_reached_but_dispatch_safe', limits);
    }
    if (measuredAfterTokens !== undefined) return decision(input, 'keep', 'reduced_to_target', limits);
    if (measured > triggerTokens) return decision(input, 'reduce', 'compaction_trigger_reached', limits);
    return decision(input, 'keep', 'within_compaction_trigger', limits);
  }
}

export function validatePurposePolicy(policy: Readonly<ContextBudgetPurposePolicyV1>): string | null {
  for (const [name, value] of Object.entries({
    softInputLimitTokens: policy.softInputLimitTokens,
    minimumSafetyReserveTokens: policy.minimumSafetyReserveTokens,
    minimumRecentHistoryTokens: policy.minimumRecentHistoryTokens,
    maxSummaryTokens: policy.maxSummaryTokens,
  })) {
    if (!nonNegativeSafeInteger(value) || (name === 'softInputLimitTokens' && value === 0)) {
      return `${name} must be ${name === 'softInputLimitTokens' ? 'a positive' : 'a non-negative'} safe integer`;
    }
  }
  if (!ratio(policy.safetyReserveRatio, true)) return 'safetyReserveRatio must be in [0, 1)';
  if (!ratio(policy.compactionTriggerRatio, false)) return 'compactionTriggerRatio must be in (0, 1]';
  if (!ratio(policy.compactionTargetRatio, false)) return 'compactionTargetRatio must be in (0, 1]';
  if (policy.compactionTargetRatio >= policy.compactionTriggerRatio) {
    return 'compactionTargetRatio must be lower than compactionTriggerRatio';
  }
  if (policy.minimumSafetyReserveTokens >= policy.softInputLimitTokens) {
    return 'minimumSafetyReserveTokens must be lower than softInputLimitTokens';
  }
  if (policy.minimumRecentHistoryTokens > policy.softInputLimitTokens) {
    return 'minimumRecentHistoryTokens cannot exceed softInputLimitTokens';
  }
  if (policy.maxSummaryTokens > policy.softInputLimitTokens) {
    return 'maxSummaryTokens cannot exceed softInputLimitTokens';
  }
  return null;
}

type BudgetLimits = Pick<ContextBudgetDecisionV1,
  'hardInputLimitTokens' | 'softInputLimitTokens' | 'dispatchLimitTokens' | 'triggerTokens'
  | 'targetTokens' | 'safetyReserveTokens' | 'uncertaintyReserveTokens'>;

function decision(
  input: Readonly<ContextBudgetPlanInput>,
  action: ContextBudgetDecisionV1['action'],
  reason: string,
  limits: BudgetLimits,
): Readonly<ContextBudgetDecisionV1> {
  return Object.freeze({
    schema: CONTEXT_BUDGET_DECISION_SCHEMA,
    action,
    ...limits,
    requestedOutputTokens: input.requestedOutputTokens,
    measuredBeforeTokens: input.measure.upperBoundTokens,
    ...((input.measureAfter?.upperBoundTokens ?? input.measuredAfterTokens) !== undefined
      ? { measuredAfterTokens: input.measureAfter?.upperBoundTokens ?? input.measuredAfterTokens }
      : {}),
    reason,
    policyRevision: input.policy.revision,
  });
}

function rejectDecision(
  input: Readonly<ContextBudgetPlanInput>,
  reason: string,
  limits: BudgetLimits,
): Readonly<ContextBudgetDecisionV1> {
  return decision(input, 'reject', reason, limits);
}

function zeroLimits(input: Readonly<ContextBudgetPlanInput>): BudgetLimits {
  return {
    hardInputLimitTokens: 0,
    softInputLimitTokens: 0,
    dispatchLimitTokens: 0,
    triggerTokens: 0,
    targetTokens: 0,
    safetyReserveTokens: 0,
    uncertaintyReserveTokens: uncertainty(input.measure),
  };
}

function uncertainty(measure: Readonly<TokenMeasureV1>): number {
  return Math.max(0, measure.upperBoundTokens - measure.tokens);
}

function unavailablePolicy(
  purpose: string,
  reason: Extract<ContextBudgetPolicySnapshotResult, { kind: 'unavailable' }>['reason'],
  detail: string,
): ContextBudgetPolicySnapshotResult {
  return Object.freeze({ kind: 'unavailable' as const, purpose, reason, detail });
}

function ratio(value: number, allowZero: boolean): boolean {
  return Number.isFinite(value) && (allowZero ? value >= 0 : value > 0) && value <= 1 && (allowZero ? value < 1 : true);
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
