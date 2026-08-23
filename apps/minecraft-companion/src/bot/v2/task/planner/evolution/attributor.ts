import { terminalPayloadV1, type FailureEnvelopeV1 } from './contracts/executionFactsV1.js';
import type { PlannerLeafEpisode } from './episodeLedger.js';

export type AttributionCategory =
  | 'success'
  | 'planning_error'
  | 'execution_error'
  | 'perception_error'
  | 'environment_impossible'
  | 'infra_failure'
  | 'safety_violation'
  | 'confounded';

export interface EpisodeAttribution {
  episodeId: string;
  category: AttributionCategory;
  confidence: number;
  learnable: boolean;
  reason: string;
  evidenceIds: string[];
  failure?: FailureEnvelopeV1;
}

/** Deterministic responsibility gate. It never infers terminal state from log text. */
export class ExperienceAttributor {
  classify(episode: PlannerLeafEpisode): EpisodeAttribution {
    const evidenceIds = episode.facts.map(fact => fact.eventId);
    if (episode.state !== 'finalized') {
      return result(episode, 'confounded', 1, false, 'episode_not_finalized', evidenceIds);
    }
    const terminalFact = episode.facts.find(fact => fact.eventType === 'execution.session.terminal');
    const terminal = terminalFact ? terminalPayloadV1(terminalFact) : null;
    if (!terminal) return result(episode, 'confounded', 1, false, 'terminal_fact_missing', evidenceIds);
    if (terminal.outcome === 'succeeded' && terminal.verdict.ok) {
      const progressFacts = episode.facts.filter(fact => fact.eventType === 'execution.progress.observed');
      const explicitlyNoProgress = progressFacts.length > 0
        && progressFacts.every(fact => fact.payload.meaningful === false);
      if (explicitlyNoProgress) {
        return result(episode, 'success', 1, false, 'goal_pre_satisfied_no_progress', evidenceIds);
      }
      return result(episode, 'success', 1, true, 'goal_verifier_satisfied', evidenceIds);
    }
    if (terminal.outcome === 'cancelled') {
      return result(episode, 'confounded', 1, false, 'owner_or_system_cancelled', evidenceIds, terminal.failure);
    }
    const failure = terminal.failure;
    if (!failure) return result(episode, 'confounded', 0.5, false, 'failure_envelope_missing', evidenceIds);

    if (failure.origin === 'safety') {
      return result(episode, 'safety_violation', 1, false, failure.code, evidenceIds, failure);
    }
    if (failure.origin === 'infra') {
      return result(episode, 'infra_failure', 1, false, failure.code, evidenceIds, failure);
    }
    if (failure.origin === 'perception') {
      return result(episode, 'perception_error', 0.95, false, failure.code, evidenceIds, failure);
    }
    if (failure.origin === 'environment') {
      return result(episode, 'environment_impossible', 0.95, true, failure.code, evidenceIds, failure);
    }
    // Coordinator has exhausted action-level recovery and explicitly handed
    // control back to the graph planner. Preserve the low-level origin for
    // audit, but route the future-plan recovery lesson to Planner evolution.
    if (terminal.handoff === 'graph_replan_required') {
      return result(episode, 'planning_error', 0.9, true, `graph_replan:${failure.code}`, evidenceIds, failure);
    }
    if (['atomic', 'behavior', 'navigation'].includes(failure.origin)) {
      return result(episode, 'execution_error', 0.95, false, failure.code, evidenceIds, failure);
    }
    if (
      ['decision', 'contract'].includes(failure.origin)
      || ['contract', 'precondition', 'resource'].includes(failure.category)
    ) {
      return result(episode, 'planning_error', 0.9, true, failure.code, evidenceIds, failure);
    }
    return result(episode, 'confounded', 0.4, false, `unmapped:${failure.origin}:${failure.category}`, evidenceIds, failure);
  }
}

function result(
  episode: PlannerLeafEpisode,
  category: AttributionCategory,
  confidence: number,
  learnable: boolean,
  reason: string,
  evidenceIds: string[],
  failure?: FailureEnvelopeV1,
): EpisodeAttribution {
  return {
    episodeId: episode.sessionId,
    category,
    confidence,
    learnable,
    reason,
    evidenceIds,
    ...(failure ? { failure } : {}),
  };
}
