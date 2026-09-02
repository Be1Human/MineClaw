/**
 * Observation Provider contract (kernel design §5.2 table + §5.3 ports).
 * Common contract owned by FEAT-CROSS-26 F01/F03; FEAT-CROSS-28 consumes it
 * through the Catalog and must not define a parallel shape.
 */
import type { ContributionRef } from '../identity.js';

/** Versioned fact kinds; closed consumer vocabulary (FEAT-CROSS-28 §5.2). */
export const FACT_KINDS = [
  'self_location',
  'owner_location',
  'nearby_entities',
  'nearby_blocks',
  'nearby_crops',
  'inventory',
  'container_contents',
  'task_status',
  'capability_status',
] as const;

export type FactKind = (typeof FACT_KINDS)[number];

export interface ClosedSchema extends Readonly<Record<string, unknown>> {}

export interface ObservationCoverageDeclaration {
  readonly dimension: readonly string[];
  readonly maxRadius?: number;
  readonly role: 'world' | 'self' | 'owner' | 'entity' | 'system';
}

export interface ObservationLimits {
  readonly maxResults?: number;
  readonly maxBlocks?: number;
  readonly maxSlots?: number;
  readonly timeoutMs?: number;
  readonly maxFanOut?: number;
}

export interface ObservationEvidenceRef {
  readonly ref: string;
  readonly source: string;
  readonly at: string;
}

export interface PluginObservationDescriptor {
  readonly id: string;
  readonly version: string;
  readonly inputSchema: ClosedSchema;
  readonly resultSchema: ClosedSchema;
  readonly factKinds: readonly FactKind[];
  readonly coverage: ObservationCoverageDeclaration;
  readonly limits: ObservationLimits;
  readonly aliases?: readonly string[];
}

export interface PluginObservationFact {
  readonly factKind: FactKind;
  readonly snapshotVersion: string;
  readonly observedAt: string;
  readonly requestedBounds: Readonly<Record<string, unknown>>;
  readonly observedBounds: Readonly<Record<string, unknown>>;
  readonly complete: boolean;
  readonly truncated: boolean;
  readonly unloadedRegions: readonly string[];
  readonly payload: Readonly<Record<string, unknown>>;
  readonly evidenceRefs: readonly ObservationEvidenceRef[];
  readonly contribution: ContributionRef;
}

export interface PluginObservationInput {
  readonly params: Readonly<Record<string, unknown>>;
  readonly signal: AbortSignal;
  readonly scope: Readonly<Record<string, unknown>>;
  readonly budget: {
    readonly timeoutMs: number;
    readonly maxResults: number;
  };
}

export type PluginObservationResult =
  | { readonly status: 'fulfilled'; readonly fact: PluginObservationFact }
  | { readonly status: 'timed_out'; readonly reason: string; readonly partialFact?: PluginObservationFact }
  | { readonly status: 'cancelled' }
  | { readonly status: 'unavailable'; readonly reason: string };

export interface PluginObservationProvider {
  readonly id: string;
  observe(input: PluginObservationInput): Promise<PluginObservationResult>;
  /** After close the provider must reject further observes (unavailable with reason 'closed'). */
  close(): void;
}

/** Factories receive a scoped host context and must not hold cross-goal shared state. */
export interface PluginObservationProviderFactory {
  readonly id: string;
  readonly version: string;
  readonly descriptor: PluginObservationDescriptor;
  create(context: PluginObservationConstructionContext): PluginObservationProvider;
}

export interface PluginObservationConstructionContext {
  readonly scoped: import('./scopedContext.js').ScopedHostContext;
  readonly identity: ContributionRef;
  readonly signal: AbortSignal;
}
