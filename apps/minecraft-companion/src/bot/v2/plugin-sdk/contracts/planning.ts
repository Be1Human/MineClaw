/**
 * Binding / Candidate / Progress provider contracts (kernel design §5.2 table).
 * These providers are strictly read/planning-side: they never authorize, never
 * execute, and must return structured results instead of silent success.
 */
import type { ContributionRef, PluginGoalLease, RegistrySnapshotRef } from '../identity.js';
import type { PluginObservationFact } from './observation.js';

export interface PluginPlanningInput {
  readonly goal: PluginGoalLease;
  readonly snapshot: RegistrySnapshotRef;
  readonly facts: readonly PluginObservationFact[];
  readonly params: Readonly<Record<string, unknown>>;
  readonly signal: AbortSignal;
  readonly budget: Readonly<Record<string, unknown>>;
}

export interface PluginBinding {
  readonly bindingId: string;
  readonly scope: Readonly<Record<string, unknown>>;
  readonly evidenceRefs: readonly string[];
  readonly contribution: ContributionRef;
}

export interface PluginCandidate {
  readonly candidateId: string;
  readonly operationContribution: ContributionRef;
  readonly params: Readonly<Record<string, unknown>>;
  readonly evidenceRefs: readonly string[];
  readonly contribution: ContributionRef;
}

export interface PluginProgress {
  readonly completed: number;
  readonly total: number;
  readonly blocked: number;
  readonly truncated: boolean;
  readonly evidenceRefs: readonly string[];
  readonly contribution: ContributionRef;
}

export type PluginPlanningStatus = 'complete' | 'partial' | 'ambiguous' | 'unavailable' | 'cancelled';

export interface PluginBindingResult {
  readonly status: PluginPlanningStatus;
  readonly bindings: readonly PluginBinding[];
  readonly reason?: string;
  readonly needsOwner?: { readonly questionKind: string; readonly options: readonly string[] };
}

export interface PluginCandidateResult {
  readonly status: PluginPlanningStatus;
  readonly candidates: readonly PluginCandidate[];
  readonly reason?: string;
}

export interface PluginProgressResult {
  readonly status: 'complete' | 'partial' | 'unavailable' | 'cancelled';
  readonly progress: PluginProgress | null;
  readonly reason?: string;
}

export interface PluginBindingProvider {
  readonly id: string;
  list(input: PluginPlanningInput): Promise<PluginBindingResult> | PluginBindingResult;
}

export interface PluginCandidateProvider {
  readonly id: string;
  list(input: PluginPlanningInput): Promise<PluginCandidateResult> | PluginCandidateResult;
}

export interface PluginProgressProvider {
  readonly id: string;
  assess(input: PluginPlanningInput): Promise<PluginProgressResult> | PluginProgressResult;
}
