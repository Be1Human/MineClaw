/**
 * Result Projection contract (kernel design §5.2 table).
 * A projection is pure: it renders an already-adjudicated goal state and never
 * rewrites completion, never invents a question outside `needs_owner`, and never
 * touches storage/events/tools. The input shape carries no side-effect channel,
 * so a violating implementation cannot compile against this contract.
 */
import type { ContributionRef, PluginGoalLease, RegistrySnapshotRef } from '../identity.js';

export type PluginGoalVerdict =
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'running'
  | 'needs_owner'
  | 'obstacle'
  | 'unknown';

export interface PluginResultEvidenceBundle {
  readonly verdict: PluginGoalVerdict;
  readonly predicate: Readonly<Record<string, unknown>> | null;
  readonly progress: Readonly<Record<string, unknown>> | null;
  readonly ledger: readonly Readonly<Record<string, unknown>>[];
  readonly failureClass: string | null;
  readonly details: Readonly<Record<string, unknown>>;
}

export interface PluginResultProjectionInput {
  readonly goal: PluginGoalLease;
  readonly snapshot: RegistrySnapshotRef;
  readonly evidence: PluginResultEvidenceBundle;
  readonly signal: AbortSignal;
}

export interface PluginResultProjectionOutput {
  readonly presentation: Readonly<Record<string, unknown>>;
  readonly audience: 'owner' | 'system';
  readonly summary: string;
  readonly question?: { readonly questionKind: string; readonly options: readonly string[] };
  readonly evidenceRefs: readonly string[];
  readonly contribution: ContributionRef;
}

export type PluginResultProjectionResult =
  | { readonly status: 'projected'; readonly output: PluginResultProjectionOutput }
  | { readonly status: 'projection_cancelled' }
  | { readonly status: 'unavailable'; readonly reason: string };

export interface PluginResultProjection {
  readonly id: string;
  readonly version: string;
  project(input: PluginResultProjectionInput): Promise<PluginResultProjectionResult> | PluginResultProjectionResult;
}
