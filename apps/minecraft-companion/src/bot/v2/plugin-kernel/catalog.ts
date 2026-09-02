/**
 * FEAT-CROSS-26-001-004-003/-004 · GenerationCatalog (P3-2, P06).
 * The catalog reads ONLY the published generation set: new goals may select
 * `available` contributions; draining serves existing goals only; unknown
 * statuses never pass by default. No live-registry fallback.
 */
import type { PublishedGenerationSlot } from './registration.js';
import type { ContributionAvailability } from '../plugin-sdk/errors.js';
import type { PluginContribution, PluginGoalTargetDeclaration } from '../plugin-sdk/contributions.js';
import { evaluateContributionAvailability } from '../plugin-sdk/availability.js';

export interface CatalogEntry {
  readonly contributionId: string;
  readonly pluginId: string;
  readonly pluginVersion: string;
  readonly contributionVersion: string;
  readonly kind: PluginContribution['kind'];
  readonly availability: ContributionAvailability;
  readonly reason?: string;
  readonly title?: string;
  readonly aliases?: readonly string[];
  readonly factKinds?: readonly string[];
  readonly description?: string;
}

export class GenerationCatalog {
  private readonly slot: PublishedGenerationSlot;

  constructor(slot: PublishedGenerationSlot) {
    this.slot = slot;
  }

  private entries(): CatalogEntry[] {
    const current = this.slot.read();
    const result: CatalogEntry[] = [];
    for (const record of current.active.registry.byId.values()) {
      result.push(toEntry(record.contribution, record.ref.pluginVersion, record.ref.contributionVersion, 'available'));
    }
    for (const [generationId, record] of current.drainingById) {
      for (const contribution of record.registry.byId.values()) {
        const entry = toEntry(contribution.contribution, contribution.ref.pluginVersion, contribution.ref.contributionVersion, 'draining');
        result.push({ ...entry, reason: `generation ${generationId} is draining for new goals` });
      }
    }
    return result;
  }

  search(query: string, limit = 10): readonly CatalogEntry[] {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return [];
    return this.entries()
      .filter(entry => matches(entry, normalized))
      .sort((a, b) => rank(a) - rank(b))
      .slice(0, limit);
  }

  details(id: string): CatalogEntry | null {
    const match = this.entries().find(entry => entry.contributionId === id);
    return match ?? null;
  }

  /** Only `available` entries may seed new goals; draining never admits new selection. */
  selectable(id: string): { readonly selectable: boolean; readonly entry: CatalogEntry | null } {
    const entry = this.details(id);
    return { selectable: entry !== null && entry.availability === 'available', entry };
  }
}

function toEntry(contribution: PluginContribution, pluginVersion: string, contributionVersion: string, availability: ContributionAvailability): CatalogEntry {
  const base: CatalogEntry = {
    contributionId: contribution.id,
    pluginId: contribution.id.split('.')[0] ?? 'unknown',
    pluginVersion,
    contributionVersion,
    kind: contribution.kind,
    availability,
  };
  if (contribution.kind === 'goal') {
    const target = contribution.target as PluginGoalTargetDeclaration;
    return { ...base, title: target.registryId, aliases: target.aliases };
  }
  if (contribution.kind === 'observation') {
    return { ...base, factKinds: contribution.factory.descriptor.factKinds };
  }
  if (contribution.kind === 'skill') {
    return { ...base, title: contribution.entryRef };
  }
  if (contribution.kind === 'proactive') {
    return { ...base, title: contribution.label, description: contribution.description };
  }
  return base;
}

function matches(entry: CatalogEntry, normalized: string): boolean {
  const haystack = [
    entry.contributionId,
    entry.kind,
    entry.title ?? '',
    entry.aliases?.join(',') ?? '',
    entry.factKinds?.join(',') ?? '',
    entry.description ?? '',
  ].join(' ').toLowerCase();
  return haystack.includes(normalized);
}

function rank(entry: CatalogEntry): number {
  if (entry.kind === 'goal') return 0;
  if (entry.kind === 'skill' || entry.kind === 'knowledge') return 1;
  return 2;
}

/** P06 helper: resolve an available execution operation's closure within the published set. */
export function assertSelectableClosure(catalog: GenerationCatalog, operationRef: string): { readonly closed: boolean; readonly missing: readonly string[] } {
  const { entry } = catalog.selectable(operationRef);
  if (!entry) return { closed: false, missing: [operationRef] };
  return { closed: entry.availability === 'available', missing: entry.availability === 'available' ? [] : [entry.reason ?? 'unavailable'] };
}
