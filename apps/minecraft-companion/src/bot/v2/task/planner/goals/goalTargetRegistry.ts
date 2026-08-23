import {
  DEFAULT_GOAL_TARGETS,
  InMemoryGoalKnowledgePort,
  normalizeGoalRegistryId,
  type GoalTargetCriterionTemplate,
  type GoalTargetDefinition,
} from '../../../knowledge/goalTargetKnowledge.js';
import type { ParentGoalTargetKind } from '../plannerContracts.js';

export type { GoalTargetCriterionTemplate, GoalTargetDefinition };

/** Planner adapter over the shared GoalKnowledge catalog. It contains no language interpretation. */
export class GoalTargetRegistry {
  private readonly definitions = new Map<string, GoalTargetDefinition>();

  constructor(definitions: readonly GoalTargetDefinition[] = DEFAULT_GOAL_TARGETS) {
    for (const definition of definitions) this.register(definition);
  }

  register(definition: GoalTargetDefinition): void {
    const normalized = new InMemoryGoalKnowledgePort([definition]).list()[0];
    if (!normalized) throw new Error('invalid goal target definition');
    this.definitions.set(normalized.registryId, Object.freeze(normalized));
  }

  get(registryId: string): GoalTargetDefinition | null {
    return this.definitions.get(normalizeGoalRegistryId(registryId)) ?? null;
  }

  list(): GoalTargetDefinition[] {
    return [...this.definitions.values()].map(definition => ({
      ...definition,
      aliases: [...definition.aliases],
      taskFamilies: [...definition.taskFamilies],
      ...(definition.successCriteria ? { successCriteria: definition.successCriteria.map(value => ({ ...value })) } : {}),
    }));
  }

  resolve(surface: string, kind?: ParentGoalTargetKind): GoalTargetDefinition[] {
    const knowledge = new InMemoryGoalKnowledgePort(this.list());
    return knowledge.searchTargets({ query: surface, kind, limit: this.definitions.size })
      .map(candidate => {
        const { matchedAlias: _matchedAlias, evidenceRef: _evidenceRef, ...definition } = candidate;
        return definition;
      });
  }
}
