import type { PlannerLeafEpisode } from './episodeLedger.js';

/**
 * A graph replan keeps one PlanRun and creates a newer revision for the
 * affected node. Outcome checks use the latest revision per node; callers may
 * still retain every revision for cost, safety and audit evidence.
 */
export function latestPlanEpisodes(episodes: readonly PlannerLeafEpisode[]): PlannerLeafEpisode[] {
  const latest = new Map<string, PlannerLeafEpisode>();
  for (const episode of episodes) {
    const logicalId = logicalPlanNodeId(episode.nodeId);
    const current = latest.get(logicalId);
    if (!current || compareEpisodeRevision(episode, current) > 0) latest.set(logicalId, episode);
  }
  return [...latest.values()];
}

/**
 * Affected-subgraph replans deliberately allocate new runtime node IDs such as
 * `smelt~r2` and `smelt~r2~r3`.  They are newer attempts of one logical plan
 * node, not extra nodes in the PlanRun completion denominator.
 */
export function logicalPlanNodeId(nodeId: string): string {
  return nodeId.replace(/(?:~r\d+)+$/u, '');
}

export function declaredPlanNodeCount(episodes: readonly PlannerLeafEpisode[]): number {
  for (const episode of episodes) {
    const bound = episode.facts.find(fact => fact.eventType === 'execution.plan.bound');
    const graph = isRecord(bound?.payload.planGraph) ? bound.payload.planGraph : null;
    if (graph && Array.isArray(graph.nodes)) return graph.nodes.length;
  }
  return latestPlanEpisodes(episodes).length;
}

function compareEpisodeRevision(left: PlannerLeafEpisode, right: PlannerLeafEpisode): number {
  if (left.planRevision !== right.planRevision) return left.planRevision - right.planRevision;
  const leftEnd = terminalTime(left);
  const rightEnd = terminalTime(right);
  if (leftEnd !== rightEnd) return leftEnd - rightEnd;
  return left.lastContiguousSequence - right.lastContiguousSequence;
}

function terminalTime(episode: PlannerLeafEpisode): number {
  const terminal = episode.facts.find(fact => fact.eventType === 'execution.session.terminal');
  const value = Date.parse(terminal?.occurredAt ?? '');
  return Number.isFinite(value) ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
