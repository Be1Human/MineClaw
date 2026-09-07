import type {
  GoalCapabilityCatalogEntry,
  GoalCapabilityDefinition,
  GoalCapabilityKnowledgePort,
} from '../decision/goalAgentPort/goalCapabilityRouter.js';
import type { PublishedGenerationSlot } from './registration.js';
import { GenerationCatalog, type CatalogEntry } from './catalog.js';

/** GoalAgent capability knowledge projected from the published Generation only. */
export function createGenerationCapabilityKnowledge(input: {
  readonly slot: () => PublishedGenerationSlot | null;
  readonly routes: () => readonly GoalCapabilityDefinition[];
}): GoalCapabilityKnowledgePort {
  const list = (): Array<GoalCapabilityDefinition | GoalCapabilityCatalogEntry> => {
    const slot = input.slot();
    if (!slot) return [...input.routes()];
    const graphHash = slot.read().active.graphHash;
    return [...input.routes(), ...new GenerationCatalog(slot).list().map(entry => project(entry, graphHash))];
  };
  return {
    list,
    get: id => list().find(entry => entry.id === id.trim()) ?? null,
    search: ({ query, limit = 8 }) => {
      const normalized = normalize(query);
      if (!normalized) return [];
      return list()
        .map(entry => ({ entry, score: score(entry, normalized) }))
        .filter(value => value.score > 0)
        .sort((left, right) => right.score - left.score || left.entry.id.localeCompare(right.entry.id))
        .slice(0, Math.max(1, Math.min(50, limit)))
        .map(value => value.entry);
    },
  };
}

function project(entry: CatalogEntry, catalogVersion: string): GoalCapabilityCatalogEntry {
  const executable = entry.kind === 'execution';
  return {
    id: entry.contributionId,
    entryKind: 'contribution',
    version: `${entry.pluginVersion}/${entry.contributionVersion}`,
    catalogVersion,
    layer: layer(entry.kind),
    title: entry.title ?? entry.contributionId,
    summary: entry.description ?? `${entry.kind} contribution owned by ${entry.pluginId}`,
    aliases: entry.aliases ?? [],
    discovery: ['capability_search', 'capability_get', ...(executable ? ['action_list'] : [])],
    invocation: executable ? ['action_execute'] : [],
    availability: entry.availability === 'available'
      ? { state: 'needs_observation', reasons: ['goal_inputs_scope_and_world_must_be_validated'] }
      : { state: 'unavailable', reasons: [entry.reason ?? entry.availability] },
    packageId: entry.pluginId,
    packageVersion: entry.pluginVersion,
    contributionVersion: entry.contributionVersion,
    contributionKind: entry.kind,
  };
}

function layer(kind: CatalogEntry['kind']): string {
  if (kind === 'observation') return 'observation';
  if (kind === 'goal') return 'goal';
  if (kind === 'planning') return 'planning';
  if (kind === 'verification') return 'verification';
  if (kind === 'execution') return 'execution';
  if (kind === 'result') return 'result';
  return kind;
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[\s，。！？、；：,.!?;:'"“”‘’]+/g, '');
}

function score(entry: GoalCapabilityDefinition | GoalCapabilityCatalogEntry, query: string): number {
  const aliases = entry.aliases.map(normalize);
  const id = normalize(entry.id);
  if (id === query || aliases.includes(query)) return 10_000;
  if (id.includes(query) || query.includes(id) || aliases.some(alias => alias.includes(query) || query.includes(alias))) return 5_000;
  const detail = normalize('entryKind' in entry ? `${entry.title} ${entry.summary} ${entry.layer}` : `${entry.description ?? ''} ${entry.mode}`);
  return detail.includes(query) ? 1_000 : 0;
}
