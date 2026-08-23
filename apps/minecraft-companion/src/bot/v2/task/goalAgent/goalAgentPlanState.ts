import type { PlanGraph } from '../planner/plannerContracts.js';
import type { GoalAgentStateV1 } from './goalAgentState.js';

export function transitionActivePlanNode(
  state: Readonly<GoalAgentStateV1>,
  nextState: 'ready' | 'needs_replan',
): GoalAgentStateV1['plan'] {
  const graph = state.plan.graph;
  const activeNodeId = state.plan.activeNodeId;
  if (!graph || !activeNodeId) return structuredClone(state.plan);
  return {
    ...state.plan,
    graph: {
      ...graph,
      nodes: graph.nodes.map(node => node.id === activeNodeId
        ? { ...node, state: nextState }
        : node),
    },
  };
}

export function satisfyAndUnlockPlanNode(
  graph: PlanGraph,
  plan: GoalAgentStateV1['plan'],
  activeNodeId: string,
): { plan: GoalAgentStateV1['plan']; nextNodeId: string | null } {
  let nodes = graph.nodes.map(node => node.id === activeNodeId ? { ...node, state: 'satisfied' as const } : node);
  const satisfied = new Set(nodes.filter(node => node.state === 'satisfied').map(node => node.id));
  nodes = nodes.map(node => {
    if (node.state !== 'pending' && node.state !== 'needs_replan') return node;
    const requirements = graph.edges.filter(edge => edge.type === 'requires' && edge.to === node.id).map(edge => edge.from);
    return requirements.every(id => satisfied.has(id)) ? { ...node, state: 'ready' as const } : node;
  });
  const nextNodeId = nodes.find(node => node.state === 'ready')?.id ?? null;
  return { plan: { ...plan, graph: { ...graph, nodes }, activeNodeId: nextNodeId }, nextNodeId };
}

export function freezeCurrentPlanRevision(
  state: Readonly<GoalAgentStateV1>,
): GoalAgentStateV1['plan']['history'] {
  if (!state.plan.graph || state.plan.revision < 1) return [...state.plan.history];
  const frozenGraph = structuredClone(state.plan.graph);
  const index = state.plan.history.findIndex(entry => entry.revision === state.plan.revision);
  if (index < 0) {
    return [...state.plan.history, {
      revision: state.plan.revision,
      graph: frozenGraph,
      reason: planRevisionReason(state),
      createdAt: state.updatedAt,
    }];
  }
  return state.plan.history.map((entry, entryIndex) => entryIndex === index
    ? { ...entry, graph: frozenGraph }
    : entry);
}

export function planRevisionReason(
  state: Readonly<GoalAgentStateV1>,
): 'initial' | 'plan_critic' | 'execution_replan' {
  if (!state.plan.graph) return 'initial';
  return state.plan.graph.nodes.some(node => node.state === 'needs_replan')
    ? 'execution_replan'
    : 'plan_critic';
}
