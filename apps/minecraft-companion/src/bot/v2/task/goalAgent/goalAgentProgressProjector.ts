import type { GoalReportV2, GoalProgressUpdateV2 } from '../../decision/goalAgentPort/contracts.js';
import type { GoalAgentLoopEvent } from './goalAgentEvents.js';
import type { GoalAgentStateV1 } from './goalAgentState.js';

export type GoalAgentProgressReport = Omit<GoalReportV2, 'meta' | 'requestId'>;

/** Projects meaningful tool-backed rounds into sparse protocol facts. */
export function projectGoalAgentProgressReport(
  state: Readonly<GoalAgentStateV1>,
  event: GoalAgentLoopEvent,
): GoalAgentProgressReport | null {
  if (state.mode !== 'planned_goal' || event.type !== 'goalagent.round.completed') return null;
  const toolNames = roundToolNames(event.payload);
  const summary = stringPayload(event.payload, 'summary') || latestSummary(state);
  const evidenceRefs = stringArrayPayload(event.payload, 'evidenceRefs');
  const semantics = classifyRound(state, toolNames);
  if (!semantics) return null;

  const graphNodes = state.plan.graph?.nodes ?? [];
  const current = graphNodes.filter(node => node.state === 'satisfied').length;
  const observedAt = state.updatedAt;
  return {
    status: 'running',
    summary,
    progress: {
      current,
      ...(graphNodes.length > 0 ? { total: graphNodes.length } : {}),
      milestone: progressMilestone(state, toolNames),
    },
    evidence: evidenceRefs.map(ref => ({ type: 'action_result', ref, observedAt })),
    update: {
      ...semantics,
      episodeKey: episodeKey(state, semantics.kind),
      dedupeKey: `${state.sessionId}:r${state.revision}:${semantics.kind}:${toolNames.join(',')}`,
      ownerActionable: false,
    },
  };
}

function classifyRound(
  state: Readonly<GoalAgentStateV1>,
  toolNames: string[],
): Pick<GoalProgressUpdateV2, 'kind' | 'importance' | 'nextAction'> | null {
  if (toolNames.includes('action_execute') && state.action.result?.ok === false) {
    return { kind: 'obstacle', importance: 'high', nextAction: '分析失败证据并选择恢复方案' };
  }
  if (toolNames.includes('plan_commit') && state.plan.revision > 1) {
    return { kind: 'decision', importance: 'high', nextAction: '根据新证据重新规划任务' };
  }
  if (toolNames.includes('plan_commit')) {
    return { kind: 'milestone', importance: 'medium', nextAction: activePlanGoal(state) || '执行已通过校验的计划' };
  }
  if (toolNames.includes('action_execute') && state.verdict?.decision === 'continue') {
    return { kind: 'milestone', importance: 'medium', nextAction: activePlanGoal(state) || '继续下一个计划里程碑' };
  }
  return null;
}

function activePlanGoal(state: Readonly<GoalAgentStateV1>): string | undefined {
  const id = state.plan.activeNodeId;
  return id ? state.plan.graph?.nodes.find(node => node.id === id)?.goal.goalText : undefined;
}

function episodeKey(state: Readonly<GoalAgentStateV1>, kind: GoalProgressUpdateV2['kind']): string {
  if (kind === 'obstacle' || kind === 'decision' || kind === 'recovery') {
    const failureCode = state.action.result?.failure?.code;
    if (failureCode) return `${state.sessionId}:failure:${failureCode}`;
  }
  return `${state.sessionId}:plan:${state.plan.revision}:${state.plan.activeNodeId ?? state.phase}`;
}

function progressMilestone(state: Readonly<GoalAgentStateV1>, toolNames: string[]): string {
  if (toolNames.includes('plan_commit')) return 'planning';
  if (state.action.result?.ok === false) return 'recovering';
  return 'executing';
}

function roundToolNames(payload: Record<string, unknown>): string[] {
  const tools = payload.tools;
  if (!Array.isArray(tools)) return [];
  return tools.flatMap(value => value && typeof value === 'object' && typeof (value as Record<string, unknown>).name === 'string'
    ? [String((value as Record<string, unknown>).name)]
    : []);
}

function latestSummary(state: Readonly<GoalAgentStateV1>): string {
  return state.verdict?.summary
    ?? state.context.timeline[state.context.timeline.length - 1]?.summary
    ?? `GoalAgent 正在${state.phase}`;
}

function stringPayload(payload: Record<string, unknown>, key: string): string {
  return typeof payload[key] === 'string' ? payload[key] : '';
}

function stringArrayPayload(payload: Record<string, unknown>, key: string): string[] {
  const value = payload[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}
