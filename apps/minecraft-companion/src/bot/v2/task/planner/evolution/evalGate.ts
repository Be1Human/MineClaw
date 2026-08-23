export interface PolicyMetrics {
  successRate: number;
  medianDurationMs: number;
  medianActions: number;
  medianLlmRounds: number;
  p95DurationMs?: number;
  p95Actions?: number;
  p95LlmRounds?: number;
  /** Actions that produced no criterion/world-state delta. */
  medianNoProgressActions?: number;
  /** Coordinator recovery decisions within one parent PlanRun. */
  medianRecoveryCount?: number;
  /** Affected-subgraph replans within one parent PlanRun. */
  medianReplanCount?: number;
  /** Contract-invalid proposals rejected before Atomic/Behavior. */
  medianInvalidActions?: number;
  interventionRate: number;
  safetyViolations: number;
  samples: number;
}

export interface EvaluationTrack {
  selection: PolicyMetrics;
  hidden: PolicyMetrics;
  triggered?: boolean;
  compliant?: boolean;
  infraFailure?: boolean;
  comparable?: boolean;
}

export interface GateDecision {
  decision: 'promote' | 'reject' | 'inconclusive' | 'blacklist';
  selectionDelta: number;
  hiddenRegression: boolean;
  safetyViolations: number;
  efficiencyImproved?: boolean;
  reasons: string[];
}

export class EvalGate {
  decide(control: EvaluationTrack, treatment: EvaluationTrack): GateDecision {
    const reasons: string[] = [];
    const safety = treatment.selection.safetyViolations + treatment.hidden.safetyViolations;
    if (safety > 0) {
      return { decision: 'blacklist', selectionDelta: 0, hiddenRegression: true, safetyViolations: safety, reasons: ['safety_veto'] };
    }
    if (treatment.infraFailure || control.infraFailure) reasons.push('infra_failure');
    if (treatment.triggered === false) reasons.push('treatment_not_triggered');
    if (treatment.compliant === false) reasons.push('treatment_noncompliant');
    if (treatment.comparable === false || control.comparable === false) reasons.push('contexts_not_comparable');
    if (reasons.length > 0) {
      return { decision: 'inconclusive', selectionDelta: 0, hiddenRegression: false, safetyViolations: 0, reasons };
    }
    const selectionDelta = treatment.selection.successRate - control.selection.successRate;
    const selectionCosts = costMetrics(control.selection, treatment.selection);
    const hiddenCosts = costMetrics(control.hidden, treatment.hidden);
    const hiddenSuccessDelta = treatment.hidden.successRate - control.hidden.successRate;
    const efficiencyImproved = selectionDelta === 0
      && control.selection.successRate === 1
      && treatment.selection.successRate === 1
      && selectionCosts.some(metric => metric.improved);
    // Cost is comparable only at the same success rate. A fast failure must
    // never veto a slower successful treatment; later generations can optimize
    // efficiency once both sides complete the task reliably.
    const selectionCostRegression = selectionDelta === 0
      && selectionCosts.some(metric => metric.regressed);
    const hiddenCostRegression = hiddenSuccessDelta === 0
      && hiddenCosts.some(metric => metric.regressed);
    const hiddenRegression = hiddenSuccessDelta < 0
      || treatment.hidden.interventionRate > control.hidden.interventionRate
      || treatment.hidden.safetyViolations > control.hidden.safetyViolations
      || hiddenCostRegression;
    if (selectionDelta < 0 || (selectionDelta === 0 && !efficiencyImproved)) reasons.push(selectionDelta === 0 ? 'selection_tie' : 'selection_regression');
    if (selectionCostRegression) reasons.push('selection_cost_regression');
    if (hiddenRegression) reasons.push('hidden_regression');
    if (treatment.selection.samples < 2 || treatment.hidden.samples < 1) reasons.push('insufficient_samples');
    return {
      decision: reasons.length === 0 ? 'promote' : 'reject',
      selectionDelta,
      hiddenRegression,
      safetyViolations: 0,
      efficiencyImproved,
      reasons,
    };
  }
}

function improvedBy15Percent(control: number, treatment: number): boolean {
  return control > 0 && treatment <= control * 0.85;
}

function regressedBy25Percent(control: number, treatment: number): boolean {
  return control === 0 ? treatment > 0 : treatment > control * 1.25;
}

function costMetrics(control: PolicyMetrics, treatment: PolicyMetrics): Array<{ improved:boolean; regressed:boolean }> {
  return [
    [control.medianDurationMs, treatment.medianDurationMs],
    [control.medianActions, treatment.medianActions],
    [control.medianLlmRounds, treatment.medianLlmRounds],
    [control.p95DurationMs ?? control.medianDurationMs, treatment.p95DurationMs ?? treatment.medianDurationMs],
    [control.p95Actions ?? control.medianActions, treatment.p95Actions ?? treatment.medianActions],
    [control.p95LlmRounds ?? control.medianLlmRounds, treatment.p95LlmRounds ?? treatment.medianLlmRounds],
    [control.medianNoProgressActions ?? 0, treatment.medianNoProgressActions ?? 0],
    [control.medianRecoveryCount ?? 0, treatment.medianRecoveryCount ?? 0],
    [control.medianReplanCount ?? 0, treatment.medianReplanCount ?? 0],
    [control.medianInvalidActions ?? 0, treatment.medianInvalidActions ?? 0],
  ].map(([baseline, current]) => ({
    improved: improvedBy15Percent(baseline, current),
    regressed: regressedBy25Percent(baseline, current),
  }));
}
