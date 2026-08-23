import type { GoalAgentEventSource, GoalAgentPhase } from './goalAgentState.js';

export interface GoalAgentEvent {
  type: string;
  sessionId: string;
  revision: number;
  epoch: number;
  phase: GoalAgentPhase;
  node: GoalAgentEventSource;
  payload: Record<string, unknown>;
}

/** Compatibility alias for existing bus and WebUI consumers. */
export type GoalAgentLoopEvent = GoalAgentEvent;
