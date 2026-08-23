export type GoalAgentMonitorSource = 'handle' | 'world' | 'watchdog' | 'manual';
export type GoalAgentMonitorChange = 'heartbeat' | 'progress' | 'blocked' | 'world_changed' | 'handle_terminal';

export interface GoalAgentMonitorSignal {
  readonly sessionId: string;
  readonly source: GoalAgentMonitorSource;
  readonly change: GoalAgentMonitorChange;
  readonly summary: string;
  readonly evidenceRefs: readonly string[];
}

export interface GoalAgentMonitoringProbeV1 extends GoalAgentMonitorSignal {
  readonly schema: 'mineclaw.goal-agent-monitoring-probe/v1';
  readonly meaningful: boolean;
}

export interface GoalAgentMonitoringAdvice {
  readonly decision: 'continue' | 'replan' | 'recover' | 'need_owner' | 'fail';
  readonly summary: string;
  readonly evidenceRefs: readonly string[];
}

export function classifyGoalAgentStatusChange(
  previous: GoalStatusSnapshotV2 | null,
  current: GoalStatusSnapshotV2,
): GoalAgentMonitorChange {
  if (!previous) return 'heartbeat';
  if (previous.state !== current.state) {
    if (current.state === 'completed' || current.state === 'failed') return 'handle_terminal';
    if (current.state === 'blocked') return 'blocked';
    return 'progress';
  }
  if (current.state === 'blocked' && previous.blocker !== current.blocker) return 'blocked';
  const previousRefs = stableEvidenceRefs(previous);
  const currentRefs = stableEvidenceRefs(current);
  if (previousRefs !== currentRefs) {
    if (hasWorldRefChange(previous, current)) return 'world_changed';
    return 'progress';
  }
  if (previous.stage !== current.stage || previous.nextAction !== current.nextAction) return 'progress';
  return 'heartbeat';
}

/** Heartbeats are projection-only. Semantic monitor cognition is reserved for meaningful change. */
export function assessGoalAgentMonitorSignal(signal: GoalAgentMonitorSignal): GoalAgentMonitoringProbeV1 {
  if (!signal.sessionId.trim() || !signal.summary.trim()) throw new Error('GoalAgent monitor signal identity and summary are required');
  if (signal.evidenceRefs.some(ref => typeof ref !== 'string' || !ref.trim())) {
    throw new Error('GoalAgent monitor evidenceRefs must be non-empty strings');
  }
  return Object.freeze({
    schema: 'mineclaw.goal-agent-monitoring-probe/v1',
    ...signal,
    evidenceRefs: Object.freeze([...new Set(signal.evidenceRefs)]),
    meaningful: signal.change !== 'heartbeat',
  });
}

export function parseGoalAgentMonitoringAdvice(content: string, probe: GoalAgentMonitoringProbeV1): GoalAgentMonitoringAdvice {
  let value: unknown;
  try { value = JSON.parse(content); } catch { value = null; }
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const allowed = new Set(['continue', 'replan', 'recover', 'need_owner', 'fail']);
  const decision = allowed.has(String(record.decision))
    ? String(record.decision) as GoalAgentMonitoringAdvice['decision']
    : 'continue';
  return {
    decision,
    summary: typeof record.summary === 'string' && record.summary.trim() ? record.summary.trim() : probe.summary,
    evidenceRefs: [...new Set(probe.evidenceRefs)],
  };
}

function stableEvidenceRefs(snapshot: GoalStatusSnapshotV2): string {
  return snapshot.evidence.map(item => `${item.type}:${item.ref}`).sort().join('|');
}

function hasWorldRefChange(previous: GoalStatusSnapshotV2, current: GoalStatusSnapshotV2): boolean {
  const worldPrefixes = ['owner-position:', 'bot-position:', 'owner-distance:'];
  const select = (snapshot: GoalStatusSnapshotV2): string[] => snapshot.evidence
    .map(item => item.ref)
    .filter(ref => worldPrefixes.some(prefix => ref.startsWith(prefix)))
    .sort();
  return JSON.stringify(select(previous)) !== JSON.stringify(select(current));
}
import type { GoalStatusSnapshotV2 } from '../../decision/goalAgentPort/contracts.js';
