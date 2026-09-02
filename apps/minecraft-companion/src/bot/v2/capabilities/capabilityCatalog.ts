import { createHash } from 'node:crypto';
import type { GoalCapabilityDefinition } from '../decision/goalAgentPort/goalCapabilityRouter.js';
import { tuning } from '../infra/tuning.js';
import type { CapabilityPackageSnapshot } from './types.js';
import { jsonSnapshot } from '../infra/jsonSnapshot.js';
import type { CapabilityExecutorKind, CapabilityOperationDefinition } from './capabilityOperation.js';

export interface CapabilityResourceDescription {
  readonly id: string;
  readonly kind: CapabilityExecutorKind | 'service' | 'adapter';
  readonly layer: 'L1' | 'L2' | 'L3' | 'L4' | 'L5' | 'L6';
  readonly title: string;
  readonly summary: string;
  readonly aliases: readonly string[];
  readonly registered: boolean;
  readonly discovery: readonly string[];
  readonly invocation: readonly string[];
  readonly inputSchema?: Readonly<Record<string, unknown>>;
}

/** Code-owned attestation, separate from an author's lifecycle declaration. */
export interface CapabilityExecutionSupport {
  readonly kind: CapabilityExecutorKind;
  readonly id: string;
  readonly controlledCancellation: boolean;
}

export interface CapabilityCatalogEntry {
  readonly id: string;
  readonly entryKind: 'route' | 'operation' | 'resource';
  readonly version: string;
  readonly catalogVersion: string;
  readonly layer: string;
  readonly title: string;
  readonly summary: string;
  readonly aliases: readonly string[];
  readonly discovery: readonly string[];
  readonly invocation: readonly string[];
  readonly availability: {
    readonly state: 'needs_observation' | 'unavailable';
    readonly reasons: readonly string[];
  };
  readonly packageId?: string;
  readonly packageVersion?: number;
  readonly references?: Readonly<Record<string, unknown>>;
  readonly operation?: CapabilityOperationDefinition;
  readonly resource?: CapabilityResourceDescription;
  readonly route?: GoalCapabilityDefinition;
}

type EntryDraft = Omit<CapabilityCatalogEntry, 'version' | 'catalogVersion'>;

/** Immutable projection, with no execute/register methods or implementation objects. */
export class CapabilityCatalog {
  readonly version: string;
  private readonly entries: readonly CapabilityCatalogEntry[];

  constructor(input: {
    readonly snapshot: CapabilityPackageSnapshot;
    readonly routes: readonly GoalCapabilityDefinition[];
    readonly resources?: readonly CapabilityResourceDescription[];
    readonly executionSupport?: readonly CapabilityExecutionSupport[];
  }) {
    const drafts: EntryDraft[] = input.routes.map(route => ({
      id: route.id, entryKind: 'route', layer: 'L7', title: route.id,
      summary: route.description ?? route.successContract, aliases: route.aliases,
      discovery: ['capability_search', 'capability_get'], invocation: [route.handler],
      availability: { state: 'needs_observation', reasons: ['request_mode_and_runtime_required'] },
      route,
    }));
    const layer: Record<CapabilityExecutorKind, string> = { atomic: 'L3', behavior: 'L4', strategy: 'L5', task: 'L6' };
    for (const { packageId, packageVersion, definition: operation } of input.snapshot.operations) {
      const support = input.executionSupport?.find(value => value.kind === operation.kind && value.id === operation.executorRef.id);
      const safe = support?.controlledCancellation === true && operation.lifecycle.cancellation === 'cooperative';
      drafts.push({
        id: operation.id, entryKind: 'operation', layer: layer[operation.kind],
        title: operation.title, summary: operation.summary, aliases: operation.aliases,
        packageId, packageVersion, operation,
        discovery: ['capability_search', 'capability_get', 'action_list'],
        invocation: ['action_execute', `${operation.kind}:${operation.executorRef.id}`],
        availability: {
          state: safe ? 'needs_observation' : 'unavailable',
          reasons: safe ? ['goal_inputs_scope_and_world_must_be_validated'] : ['controlled_execution_not_connected'],
        },
      });
    }
    for (const resource of input.resources ?? []) {
      const internal = resource.kind === 'adapter' || resource.kind === 'service' || !resource.discovery.includes('action_list');
      drafts.push({
        id: `${resource.kind}:${resource.id}`, entryKind: 'resource', layer: resource.layer,
        title: resource.title, summary: resource.summary, aliases: resource.aliases,
        discovery: ['capability_search', 'capability_get', ...resource.discovery], invocation: resource.invocation,
        resource,
        availability: {
          state: !resource.registered || internal ? 'unavailable' : 'needs_observation',
          reasons: !resource.registered ? ['not_registered'] : internal
            ? [resource.kind === 'service' || resource.kind === 'adapter' || resource.kind === 'strategy'
              ? 'internal_only' : 'no_direct_tool_use_action_list_for_applicable_candidates']
            : ['legacy_candidate_conditions_required'],
        },
      });
    }
    // Versioned fact and predicate contracts are knowledge, never body-action grants.
    for (const provider of input.snapshot.worldFactProviders) {
      if (!provider.version || !provider.inputSchema) continue;
      drafts.push({
        id: `world_fact:${provider.id}`, entryKind: 'resource', layer: 'observation', title: provider.id,
        summary: 'Versioned bounded read-only observation Provider. Request through world_observe; this does not authorize mutation.',
        aliases: [provider.id], discovery: ['capability_search', 'capability_get'], invocation: ['world_observe'],
        availability: { state: 'needs_observation', reasons: ['registered_read_only_provider_inputs_required'] },
        references: { worldFact: { providerId: provider.id, version: provider.version, inputSchema: provider.inputSchema } },
      });
    }
    for (const evaluator of input.snapshot.predicateEvaluators) {
      if (!evaluator.version || !evaluator.argumentSchema) continue;
      drafts.push({
        id: `predicate:${evaluator.id}`, entryKind: 'resource', layer: 'verification', title: evaluator.id,
        summary: 'Versioned machine predicate. May define goal success, never a body action or independent tool.',
        aliases: [evaluator.id], discovery: ['capability_search', 'capability_get'], invocation: [],
        availability: { state: 'unavailable', reasons: ['verification_only'] },
        references: { predicate: { id: evaluator.id, version: evaluator.version, argumentSchema: evaluator.argumentSchema } },
      });
    }
    for (const definition of input.snapshot.packages) {
      if (definition.manifest.schema !== 'mineclaw/capability-manifest@1') continue;
      const { manifest } = definition;
      drafts.push({
        id: `package:${manifest.id}`, entryKind: 'resource', layer: 'cross_layer',
        title: manifest.id, summary: manifest.description,
        aliases: [...new Set(manifest.goalTargets.flatMap(target => target.aliases))],
        packageId: manifest.id, packageVersion: manifest.version,
        discovery: ['capability_search', 'capability_get', 'goal_search_targets'],
        invocation: definition.actionProviders.length ? ['action_list', 'action_execute'] : ['ProactiveScheduler'],
        availability: definition.actionProviders.length
          ? { state: 'needs_observation', reasons: ['legacy_package_target_and_provider_conditions_required'] }
          : { state: 'unavailable', reasons: ['internal_only'] },
        references: {
          targets: manifest.goalTargets.map(x => x.registryId), requires: manifest.requires,
          skills: manifest.skills, knowledge: manifest.knowledge,
          providers: definition.actionProviders.map(x => x.id), evaluators: definition.predicateEvaluators.map(x => x.id),
        },
      });
    }
    drafts.sort((a, b) => a.id.localeCompare(b.id));
    if (new Set(drafts.map(value => value.id)).size !== drafts.length) throw new Error('duplicate capability catalog identity');
    const detached = jsonSnapshot(drafts);
    this.version = hash(detached);
    this.entries = jsonSnapshot(detached.map(value => ({ ...value, version: hash(value), catalogVersion: this.version })));
  }

  list(): CapabilityCatalogEntry[] { return [...this.entries]; }

  get(id: string): CapabilityCatalogEntry | null {
    return this.entries.find(value => value.id === id.trim()) ?? null;
  }

  search(input: { query: string; limit?: number }): CapabilityCatalogEntry[] {
    const query = normalize(input.query);
    if (!query) return [];
    const configured = tuning().capabilityCatalog.searchLimit;
    if (!Number.isFinite(configured) || configured < 1) return [];
    const requested = input.limit ?? configured;
    if (!Number.isFinite(requested) || requested < 1) return [];
    const limit = Math.floor(Math.min(requested, configured));
    return this.entries.map(entry => ({ entry, score: relevance(entry, query) }))
      .filter(value => value.score > 0)
      .sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id))
      .slice(0, limit).map(value => value.entry);
  }
}

function hash(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(jsonSnapshot(value))).digest('hex')}`;
}

function normalize(value: string): string { return value.toLowerCase().replace(/[\s，。！？、；：,.!?;:'"“”‘’]+/g, ''); }

function relevance(entry: CapabilityCatalogEntry, query: string): number {
  const names = [entry.id, entry.title, ...entry.aliases].map(normalize);
  if (names.includes(query)) return 3;
  if (names.some(name => name && (name.includes(query) || query.includes(name)))) return 2;
  const detail = normalize(JSON.stringify([entry.summary, entry.layer, entry.operation?.inputSchema ?? {}, entry.operation?.effects ?? []]));
  return detail.includes(query) ? 1 : 0;
}
