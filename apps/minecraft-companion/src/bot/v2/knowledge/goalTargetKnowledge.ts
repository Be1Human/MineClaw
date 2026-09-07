import type { ParentGoalTargetKind } from '../task/planner/plannerContracts.js';
import { jsonSnapshot } from '../infra/jsonSnapshot.js';
import type { ContributionRef } from '../plugin-sdk/identity.js';

export type GoalTargetCriterionTemplate =
  | { type: 'inventory'; item: string; count: number | '$quantity' }
  | { type: 'entity_dead'; entityName: string }
  | { type: 'reached'; relativeTo: 'owner'; radius: number }
  | { type: 'predicate'; predicate: string; predicateVersion?: string; args?: Readonly<Record<string, unknown>> };

export interface GoalTargetDefinition {
  /** Exact Registry-Generation contribution that declared this target. */
  contribution: ContributionRef;
  kind: ParentGoalTargetKind;
  registryId: string;
  aliases: readonly string[];
  taskFamilies: readonly string[];
  /** Domain scope binder declared by the same operation closure. */
  bindingContributionId?: string;
  /** Package-owned machine criteria replace the generic item outcome criterion. */
  successCriteriaPolicy?: 'fallback' | 'authoritative';
  successCriteria?: readonly GoalTargetCriterionTemplate[];
}

export interface GoalTargetCandidate extends GoalTargetDefinition {
  matchedAlias?: string;
  evidenceRef: string;
}

export interface GoalKnowledgePort {
  list(): GoalTargetDefinition[];
  getTarget(registryId: string): GoalTargetDefinition | null;
  searchTargets(input: { query: string; kind?: ParentGoalTargetKind; limit?: number }): GoalTargetCandidate[];
}

export class InMemoryGoalKnowledgePort implements GoalKnowledgePort {
  private readonly definitions = new Map<string, GoalTargetDefinition>();

  constructor(definitions: readonly GoalTargetDefinition[]) {
    for (const definition of definitions) {
      const registryId = normalizeRegistryId(definition.registryId);
      if (!registryId || definition.aliases.length === 0 || !definition.contribution?.pluginId
        || !definition.contribution.pluginVersion || !definition.contribution.contributionId
        || !definition.contribution.contributionVersion) throw new Error('invalid goal target definition');
      this.definitions.set(registryId, Object.freeze({
        ...definition,
        registryId,
        aliases: Object.freeze([...new Set(definition.aliases.map(normalizeSurface).filter(Boolean))]),
        taskFamilies: Object.freeze([...new Set(definition.taskFamilies)]),
        ...(definition.successCriteria ? {
          successCriteria: jsonSnapshot([...definition.successCriteria]),
        } : {}),
      }));
    }
  }

  list(): GoalTargetDefinition[] {
    return [...this.definitions.values()].map(cloneDefinition);
  }

  getTarget(registryId: string): GoalTargetDefinition | null {
    const definition = this.definitions.get(normalizeRegistryId(registryId));
    return definition ? cloneDefinition(definition) : null;
  }

  searchTargets(input: { query: string; kind?: ParentGoalTargetKind; limit?: number }): GoalTargetCandidate[] {
    const query = normalizeSurface(input.query);
    if (!query) return [];
    const limit = Math.max(1, Math.min(50, input.limit ?? 8));
    return [...this.definitions.values()]
      .filter(definition => !input.kind || definition.kind === input.kind)
      .flatMap(definition => {
        const idSurface = normalizeSurface(definition.registryId.replace(/^[^:]+:/, ''));
        const matchedAlias = definition.aliases
          .filter(alias => query.includes(alias) || alias.includes(query))
          .sort((left, right) => right.length - left.length)[0];
        if (!matchedAlias && query !== idSurface && !query.includes(idSurface)) return [];
        return [{
          ...cloneDefinition(definition),
          ...(matchedAlias ? { matchedAlias } : {}),
          evidenceRef: `goal-target:${definition.registryId}`,
        } satisfies GoalTargetCandidate];
      })
      .sort((left, right) => scoreCandidate(right, query) - scoreCandidate(left, query))
      .slice(0, limit);
  }
}

/** Read-only projection for a live registry source; it never owns a second target inventory. */
export class ProjectedGoalKnowledgePort implements GoalKnowledgePort {
  constructor(private readonly read: () => readonly GoalTargetDefinition[]) {}

  list(): GoalTargetDefinition[] { return this.current().list(); }
  getTarget(registryId: string): GoalTargetDefinition | null { return this.current().getTarget(registryId); }
  searchTargets(input: { query: string; kind?: ParentGoalTargetKind; limit?: number }): GoalTargetCandidate[] {
    return this.current().searchTargets(input);
  }

  private current(): InMemoryGoalKnowledgePort { return new InMemoryGoalKnowledgePort(this.read()); }
}

export function normalizeGoalRegistryId(value: string): string {
  return normalizeRegistryId(value);
}

export function normalizeGoalSurface(value: string): string {
  return normalizeSurface(value);
}

function scoreCandidate(candidate: GoalTargetCandidate, query: string): number {
  const idSurface = normalizeSurface(candidate.registryId.replace(/^[^:]+:/, ''));
  if (query === idSurface) return 10_000 + idSurface.length;
  if (candidate.matchedAlias === query) return 8_000 + query.length;
  return 1_000 + (candidate.matchedAlias?.length ?? idSurface.length);
}

function cloneDefinition(definition: GoalTargetDefinition): GoalTargetDefinition {
  return {
    ...definition,
    aliases: [...definition.aliases],
    taskFamilies: [...definition.taskFamilies],
    ...(definition.successCriteria ? { successCriteria: structuredClone(definition.successCriteria) } : {}),
  };
}

function normalizeSurface(value: string): string {
  return value.toLowerCase().replace(/[\s，。！？、；：,.!?;:'"“”‘’]+/g, '');
}

function normalizeRegistryId(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return '';
  return normalized.includes(':') ? normalized : `minecraft:${normalized}`;
}
