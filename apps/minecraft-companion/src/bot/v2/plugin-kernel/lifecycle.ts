/**
 * Plugin lifecycle and generation-pinned resolution (kernel design §5.6/§5.7).
 * The kernel owns generation and lease only — never goal compilation or ledger
 * business state. Resolvers refuse to look up the live Registry when a record is
 * missing from the pinned generation (needs_rebind/in_doubt), and never hand a
 * draining contribution to a new goal.
 */
import type { ActiveGenerationRecord, PublishedGenerationSlot, StagedContributionRecord, TypedRegistrySnapshot } from './registration.js';
import type { ContributionRef, RegistrySnapshotRef } from '../plugin-sdk/identity.js';
import { pluginError } from '../plugin-sdk/errors.js';

export type PluginLifecycleState = 'prepared' | 'active' | 'draining' | 'disabled' | 'faulted';

export class LifecycleCoordinator {
  private readonly states = new Map<string, PluginLifecycleState>();

  declare(pluginId: string, state: PluginLifecycleState): void {
    this.states.set(pluginId, state);
  }

  transition(pluginId: string, to: PluginLifecycleState): void {
    if (!this.states.has(pluginId)) throw pluginError('manifest_invalid', `unknown plugin ${pluginId} in lifecycle coordinator`);
    const from = this.states.get(pluginId)!;
    if (from === 'faulted' && to !== 'disabled') {
      throw pluginError('plugin_runtime_fault', `faulted plugin ${pluginId} may only transition to disabled`);
    }
    this.states.set(pluginId, to);
  }

  stateOf(pluginId: string): PluginLifecycleState | null {
    return this.states.get(pluginId) ?? null;
  }
}

export type GenerationResolveStatus = 'resolved' | 'needs_rebind' | 'in_doubt';

export interface GenerationResolveResult {
  readonly status: GenerationResolveStatus;
  readonly record: ActiveGenerationRecord | null;
  readonly entry: StagedContributionRecord | null;
  readonly reason?: string;
}

/**
 * The single lookup path for every generation-pinned consumer. It searches only
 * the record referenced by the snapshot (active or draining); a missing record
 * or contribution yields needs_rebind/in_doubt — never a live-Registry fallback.
 */
export class GenerationResolvers {
  private readonly slot: PublishedGenerationSlot;

  constructor(slot: PublishedGenerationSlot) {
    this.slot = slot;
  }

  resolveContribution(snapshot: RegistrySnapshotRef, contributionRef: ContributionRef): GenerationResolveResult {
    return this.resolve(snapshot, contributionRef.contributionId, contributionRef);
  }

  resolveById(snapshot: RegistrySnapshotRef, contributionId: string): GenerationResolveResult {
    return this.resolve(snapshot, contributionId, null);
  }

  private resolve(snapshot: RegistrySnapshotRef, contributionId: string, expected: ContributionRef | null): GenerationResolveResult {
    const current = this.slot.read();
    const record = current.active.generationId === snapshot.generationId
      ? current.active
      : current.drainingById.get(snapshot.generationId) ?? null;
    if (!record) {
      return { status: 'needs_rebind', record: null, entry: null, reason: `generation ${snapshot.generationId} is no longer published` };
    }
    const entry = record.registry.byId.get(contributionId) ?? null;
    if (!entry) {
      return { status: 'in_doubt', record, entry: null, reason: `contribution ${contributionId} missing from generation ${snapshot.generationId}` };
    }
    if (expected !== null && entry.ref.contributionVersion !== expected.contributionVersion) {
      return { status: 'in_doubt', record, entry: null, reason: `contribution ${contributionId} version ${entry.ref.contributionVersion} differs from pinned ${expected.contributionVersion}` };
    }
    return { status: 'resolved', record, entry };
  }

  /** New goals may only select contributions from the active record with availability 'available'. */
  resolveActive(contributionId: string): { status: 'available' | 'unavailable'; record: ActiveGenerationRecord; entry: StagedContributionRecord | null; availability: string } {
    const record = this.slot.read().active;
    const entry = record.registry.byId.get(contributionId) ?? null;
    if (!entry) return { status: 'unavailable', record, entry: null, availability: 'unsupported' };
    return { status: 'available', record, entry, availability: 'available' };
  }
}

export interface ActiveGenerationView {
  readonly snapshot: RegistrySnapshotRef;
  readonly registry: TypedRegistrySnapshot;
}

export function snapshotView(record: ActiveGenerationRecord): ActiveGenerationView {
  return Object.freeze({
    snapshot: Object.freeze({
      generationId: record.generationId,
      buildId: record.buildId,
      graphHash: record.graphHash,
    }),
    registry: record.registry,
  });
}

/** Availability gate for the catalog: draining never admits new goals. */
export function catalogSelectable(record: ActiveGenerationRecord, contributionId: string): boolean {
  const entry = record.registry.byId.get(contributionId);
  if (!entry) return false;
  return record.registry.disabledIds.includes(contributionId) === false;
}
