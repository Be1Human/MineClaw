import type { GoalSuccessCriterion } from '../contracts/goalTypes.js';
import type { GoalAgentStateV1 } from './goalAgentState.js';

export function legacyProgressFacts(state: Readonly<GoalAgentStateV1>): unknown {
  const world = state.world.latest;
  if (!world || !state.rootGoal) return null;
  const criteria = [...state.rootGoal.successCriteria, ...(state.plan.graph?.nodes.flatMap(node => node.goal.metadata?.structuredSuccessCriteria ?? []) ?? [])] as GoalSuccessCriterion[];
  const items = new Set(criteria.flatMap(value => value.item ? [value.item] : []));
  return { inventory: world.inventory.items.filter(item => items.has(item.name)).map(item => ({ name: item.name, count: item.count })).sort((a, b) => a.name.localeCompare(b.name)),
    ...(criteria.some(value => value.type === 'reached') ? { position: world.self.position } : {}),
    targets: world.entities.filter(entity => criteria.some(value => value.type === 'entity_dead' && (value.entityId === String(entity.id) || value.entityName === entity.name))).map(entity => ({ id: entity.id, position: entity.position })),
  };
}
