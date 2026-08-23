import { createHash } from 'node:crypto';
import type { GoalAgentLoopEvent } from './goalAgentEvents.js';
import { stableJson } from './goalAgentJson.js';
import type { GoalAgentModelRuntime } from './goalAgentModelRuntime.js';
import type { GoalAgentSessionEventLogPort } from './goalAgentSessionEventLog.js';
import type { GoalAgentStateV1 } from './goalAgentState.js';
import type { GoalAgentExperiencePort } from './ports/index.js';

export interface GoalAgentReflectionWorkerOptions {
  model: Pick<GoalAgentModelRuntime, 'reflectTerminal'>;
  eventLog: GoalAgentSessionEventLogPort;
  experience?: GoalAgentExperiencePort;
  publish?: (event: GoalAgentLoopEvent) => void;
}

/**
 * Reads immutable terminal facts after the main loop has stopped and writes
 * only a quarantined experience proposal. It never mutates GoalAgent state.
 */
export class GoalAgentReflectionWorker {
  constructor(private readonly options: GoalAgentReflectionWorkerOptions) {}

  async consume(state: Readonly<GoalAgentStateV1>): Promise<void> {
    if (!state.terminal) throw new Error('GoalAgent reflection requires terminal state');
    const existing = this.options.eventLog.listSessionEvents(state.sessionId)
      .find(event => event.type === 'reflection.proposed' || event.type === 'reflection.skipped');
    if (existing) return;

    const ineligible = eligibilityFailure(state, this.options.experience);
    if (ineligible) {
      this.append('reflection.skipped', 'goalagent.reflection.skipped', state, { reason: ineligible });
      return;
    }

    try {
      const reflected = await this.options.model.reflectTerminal(state, new AbortController().signal);
      const proposal = {
        idempotencyKey: `goalagent-reflection:${state.sessionId}:${state.epoch}:${state.revision}:${state.terminal.outcome}`,
        sessionId: state.sessionId,
        goalSignature: state.goal.signature?.key ?? state.rootGoal?.goalId ?? state.sessionId,
        outcome: state.terminal.outcome === 'completed' ? 'completed' as const : 'failed' as const,
        summary: reflected.summary,
        evidenceRefs: [...new Set(state.terminal.evidenceRefs)],
        timelineDigest: createHash('sha256').update(stableJson(state.context.timeline)).digest('hex'),
      };
      const committed = await this.options.experience!.commitProposal!(proposal);
      this.append('reflection.proposed', 'goalagent.reflection.proposed', state, {
        proposalId: committed.proposalId,
        outcome: proposal.outcome,
        evidenceRefs: proposal.evidenceRefs,
        reflectionCallId: reflected.callId,
      });
    } catch (error) {
      this.append('reflection.failed', 'goalagent.reflection.failed', state, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private append(
    eventType: 'reflection.proposed' | 'reflection.skipped' | 'reflection.failed',
    busType: string,
    state: Readonly<GoalAgentStateV1>,
    payload: Record<string, unknown>,
  ): void {
    this.options.eventLog.appendSessionEvent({
      ...(eventType !== 'reflection.failed' ? { eventId: `${state.sessionId}:${eventType}` } : {}),
      sessionId: state.sessionId,
      occurredAt: new Date().toISOString(),
      type: eventType,
      node: 'terminal',
      stateRevision: state.revision,
      epoch: state.epoch,
      payload,
    });
    this.options.publish?.({
      type: busType,
      sessionId: state.sessionId,
      revision: state.revision,
      epoch: state.epoch,
      phase: state.phase,
      node: 'terminal',
      payload,
    });
  }
}

function eligibilityFailure(
  state: Readonly<GoalAgentStateV1>,
  experience: GoalAgentExperiencePort | undefined,
): string | null {
  if (!experience?.commitProposal) return 'experience_quarantine_unavailable';
  if (state.request.requestKind !== 'task') return 'non_task_session';
  if (state.terminal?.outcome === 'cancelled') return 'cancelled_session';
  if (state.terminal?.outcome === 'completed') {
    if (state.verdict?.decision !== 'complete' || state.verdict.machineCriteriaSatisfied !== true) {
      return 'success_not_machine_verified';
    }
    if (state.terminal.evidenceRefs.length === 0) return 'success_evidence_missing';
  }
  return null;
}
