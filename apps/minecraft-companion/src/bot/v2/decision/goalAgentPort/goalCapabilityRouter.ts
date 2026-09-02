import type { GoalRequestV2 } from './contracts.js';
import type { CapabilityCatalogEntry } from '../../capabilities/capabilityCatalog.js';

export type GoalCapabilityMode = 'planned_goal' | 'persistent_behavior' | 'query' | 'cancel';

export interface GoalCapabilityDefinition {
  id: string;
  description?: string;
  aliases: string[];
  mode: GoalCapabilityMode;
  successContract: string;
  handler: string;
}

export interface GoalCapabilityKnowledgePort {
  list(): Array<GoalCapabilityDefinition | CapabilityCatalogEntry>;
  search(input: { query: string; limit?: number }): Array<GoalCapabilityDefinition | CapabilityCatalogEntry>;
  get(id: string): GoalCapabilityDefinition | CapabilityCatalogEntry | null;
}

export interface GoalCapabilityMatch {
  definition: GoalCapabilityDefinition;
  matchedAlias?: string;
}

const normalize = (value: string): string => value
  .toLowerCase()
  .replace(/[\s，。！？、；：,.!?;:'"“”‘’]+/g, '');

/** GoalAgent 的注册式能力目录；Planner 只是其中 planned_goal 模式的 handler。 */
export class GoalCapabilityRouter implements GoalCapabilityKnowledgePort {
  private readonly definitions = new Map<string, GoalCapabilityDefinition>();

  constructor(definitions: GoalCapabilityDefinition[] = defaultGoalCapabilities()) {
    for (const definition of definitions) this.register(definition);
  }

  register(definition: GoalCapabilityDefinition): void {
    this.definitions.set(definition.id, {
      ...definition,
      aliases: [...new Set(definition.aliases.map(normalize).filter(Boolean))],
    });
  }

  list(): GoalCapabilityDefinition[] {
    return [...this.definitions.values()].map(definition => ({
      ...definition,
      aliases: [...definition.aliases],
    }));
  }

  search(input: { query: string; limit?: number }): GoalCapabilityDefinition[] {
    const query = normalize(input.query);
    if (!query) return [];
    const limit = Math.max(1, Math.min(20, input.limit ?? 8));
    return [...this.definitions.values()]
      .map(definition => ({ definition, score: capabilityScore(definition, query) }))
      .filter(value => value.score > 0)
      .sort((left, right) => right.score - left.score || left.definition.id.localeCompare(right.definition.id))
      .slice(0, limit)
      .map(value => cloneDefinition(value.definition));
  }

  get(id: string): GoalCapabilityDefinition | null {
    const definition = this.definitions.get(id.trim());
    return definition ? cloneDefinition(definition) : null;
  }

  resolve(request: Pick<GoalRequestV2, 'requestKind' | 'requestText' | 'originalText'>): GoalCapabilityMatch {
    if (request.requestKind === 'cancel') return { definition: this.require('stop_execution') };

    const text = normalize(`${request.originalText}\n${request.requestText}`);
    for (const definition of this.definitions.values()) {
      if (definition.mode !== 'persistent_behavior') continue;
      const alias = definition.aliases.find(candidate => text.includes(candidate));
      if (alias) return { definition, matchedAlias: alias };
    }
    return { definition: this.require('planned_goal') };
  }

  private require(id: string): GoalCapabilityDefinition {
    const definition = this.definitions.get(id);
    if (!definition) throw new Error(`goal_capability_missing:${id}`);
    return definition;
  }
}

export function defaultGoalCapabilities(): GoalCapabilityDefinition[] {
  return [
    {
      id: 'follow_owner',
      description: 'Keep following the owner until explicitly stopped. Use for persistent “follow me” requests, not one-shot arrival.',
      aliases: ['跟我来', '跟着我', '跟随我', '跟随主人', '跟着主人', 'come with me', 'follow me'],
      mode: 'persistent_behavior',
      successContract: 'active follow_owner task + owner target + fresh distance evidence',
      handler: 'task_runtime.follow_owner',
    },
    {
      id: 'game_query', aliases: [], mode: 'query',
      description: 'Answer a game-state question from a fresh observed snapshot without starting a physical task.',
      successContract: 'fresh world/runtime snapshot with observedAt',
      handler: 'goal_agent.query',
    },
    {
      id: 'stop_execution', aliases: [], mode: 'cancel',
      description: 'Stop active GoalAgent execution and fence stale callbacks.',
      successContract: 'target execution handles stopped and stale callbacks fenced',
      handler: 'goal_agent.cancel',
    },
    {
      id: 'planned_goal', aliases: [], mode: 'planned_goal',
      description: 'Complete a one-shot verifiable goal, including reaching a target position once.',
      successContract: 'PlanGraph root verdict with machine evidence',
      handler: 'production_planner_gateway',
    },
  ];
}

function cloneDefinition(definition: GoalCapabilityDefinition): GoalCapabilityDefinition {
  return { ...definition, aliases: [...definition.aliases] };
}

function capabilityScore(definition: GoalCapabilityDefinition, query: string): number {
  const id = normalize(definition.id);
  const description = normalize(definition.description ?? '');
  const mode = normalize(definition.mode);
  if (id === query) return 10_000;
  if (definition.aliases.some(alias => alias === query)) return 9_000;
  const aliasLength = Math.max(0, ...definition.aliases
    .filter(alias => alias.includes(query) || query.includes(alias))
    .map(alias => Math.min(alias.length, query.length)));
  if (aliasLength > 0) return 7_000 + aliasLength;
  if (id.includes(query) || query.includes(id)) return 5_000 + Math.min(id.length, query.length);
  if (description.includes(query) || mode.includes(query)) return 3_000 + query.length;
  return 0;
}
