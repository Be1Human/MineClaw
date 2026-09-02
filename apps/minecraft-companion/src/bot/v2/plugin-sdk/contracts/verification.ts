/**
 * Predicate Evaluator contract (kernel design §5.2 table, FEAT-CROSS-26 F03).
 * A predicate only returns satisfied/unsatisfied/unknown with evidence; it must
 * never treat an action receipt as world fact.
 */
import type { ContributionRef, PluginGoalLease, RegistrySnapshotRef } from '../identity.js';
import type { ClosedSchema } from './observation.js';

export type PluginPredicateVerdict = 'satisfied' | 'unsatisfied' | 'unknown';

export interface PluginPredicateInput {
  readonly goal: PluginGoalLease;
  readonly snapshot: RegistrySnapshotRef;
  readonly evidence: Readonly<Record<string, unknown>>;
  readonly facts: readonly Readonly<Record<string, unknown>>[];
  readonly args: Readonly<Record<string, unknown>>;
  readonly signal: AbortSignal;
}

export interface PluginPredicateResult {
  readonly verdict: PluginPredicateVerdict;
  readonly evidenceRefs: readonly string[];
  readonly reason?: string;
  readonly contribution: ContributionRef;
}

export interface PluginPredicateEvaluator {
  readonly id: string;
  readonly version: string;
  readonly argumentSchema?: ClosedSchema;
  readonly factRequirements?: readonly string[];
  evaluate(input: PluginPredicateInput): Promise<PluginPredicateResult> | PluginPredicateResult;
}
