import type { EpisodeLedger, PlannerLeafEpisode } from './episodeLedger.js';
import type { ExperienceAttributor } from './attributor.js';
import type { EvaluationTrack, PolicyMetrics } from './evalGate.js';
import type { CandidateExperimentAllocation, CandidateValidationRun, PlannerLearningStore } from './learningStore.js';
import type { ExperienceCandidate } from './plannerOptimizer.js';
import { declaredPlanNodeCount, latestPlanEpisodes } from './planEpisodeAggregation.js';
import { candidateIdentity } from './candidateIdentity.js';

export interface CandidateEvaluationReady {
  candidateId: string;
  attempt: number;
  baselineEpisodeIds: string[];
  selectionEpisodeIds: string[];
  hiddenEpisodeIds: string[];
  control: EvaluationTrack;
  treatment: EvaluationTrack;
}

/**
 * Assigns immutable Episodes to one candidate's baseline/selection/hidden tracks.
 * It never starts tasks or emits execution commands; new trials only arrive from execution facts.
 */
export class CandidateTrialScheduler {
  constructor(
    private readonly ledger: EpisodeLedger,
    private readonly learning: PlannerLearningStore,
    private readonly attributor: ExperienceAttributor,
  ) {}

  advance(candidate: ExperienceCandidate): CandidateEvaluationReady | null {
    if (!candidate.validationSpec || candidate.status !== 'candidate') return null;
    const identity = candidateIdentity(candidate);
    const episodeIds = unique([...candidate.positiveEpisodeIds, ...candidate.negativeEpisodeIds]);
    let run = this.learning.getValidationRun(candidate.id);
    if (!run) {
      this.learning.upsertValidationRun({
        candidateId: candidate.id,
        candidateGeneration: identity.generation,
        candidateContentHash: identity.contentHash,
        candidateEvidenceCutoffAt: latestEpisodeTime(episodeIds, this.ledger),
        baselineEpisodeIds: episodeIds,
        baselineCutoffOccurredAt: latestEpisodeTime(episodeIds, this.ledger),
        selectionEpisodeIds: [],
        hiddenEpisodeIds: [],
        consumedTrialEpisodeIds: [],
        attempt: 1,
        status: 'collecting',
      });
      return null;
    }
    if (run.status !== 'collecting') return null;
    const selection = oneEpisodePerPlanRun(
      run.selectionEpisodeIds.filter(id => trackedTrialEligible(id, candidate.id, this.ledger, this.learning)),
      this.ledger,
    );
    const hidden = oneEpisodePerPlanRun(
      run.hiddenEpisodeIds.filter(id => trackedTrialEligible(id, candidate.id, this.ledger, this.learning)),
      this.ledger,
    );
    const consumed = oneEpisodePerPlanRun(run.consumedTrialEpisodeIds, this.ledger);
    const trackedSamplesChanged = stableIds(selection) !== stableIds(run.selectionEpisodeIds)
      || stableIds(hidden) !== stableIds(run.hiddenEpisodeIds)
      || stableIds(consumed) !== stableIds(run.consumedTrialEpisodeIds);
    const allocations = this.learning.listExperimentAllocations(candidate.id).filter(value => value.state !== 'abandoned');
    if (allocations.length === 0) {
      const baselineChanged = stableIds(run.baselineEpisodeIds) !== stableIds(episodeIds)
        || run.candidateGeneration !== identity.generation
        || run.candidateContentHash !== identity.contentHash
        || trackedSamplesChanged;
      if (baselineChanged) {
        this.learning.upsertValidationRun({
          ...withoutTimestamps(run),
          createdAt: run.createdAt,
          candidateGeneration: identity.generation,
          candidateContentHash: identity.contentHash,
          candidateEvidenceCutoffAt: latestEpisodeTime(episodeIds, this.ledger),
          baselineEpisodeIds: episodeIds,
          baselineCutoffOccurredAt: latestEpisodeTime(episodeIds, this.ledger),
          selectionEpisodeIds: selection,
          hiddenEpisodeIds: hidden,
          consumedTrialEpisodeIds: consumed,
        });
      }
      return null;
    }
    if (run.candidateGeneration !== identity.generation || run.candidateContentHash !== identity.contentHash) return null;

    if (!run.baselineCutoffOccurredAt) {
      run = this.learning.upsertValidationRun({
        ...withoutTimestamps(run),
        createdAt: run.createdAt,
        baselineCutoffOccurredAt: latestEpisodeTime(run.baselineEpisodeIds, this.ledger),
      });
    }

    const known = new Set([...run.baselineEpisodeIds, ...selection, ...hidden, ...consumed]);
    const baseline = [...run.baselineEpisodeIds];
    const representedTrials = representedPlanRunIds([...selection, ...hidden, ...consumed], this.ledger);
    const explicitTrialEpisodeIds = this.ledger.listEpisodes({ state: 'finalized' })
      .filter(episode => finalizedTrialEligible(episode, candidate.id, this.learning))
      .map(episode => episode.sessionId);
    for (const episodeId of unique([...episodeIds, ...explicitTrialEpisodeIds])) {
      if (known.has(episodeId)) continue;
      const episode = this.ledger.getEpisode(episodeId);
      const planRunKey = episode?.planRunId ?? `episode:${episodeId}`;
      if (representedTrials.has(planRunKey)) continue;
      known.add(episodeId);
      if (episodeTime(episodeId, this.ledger) <= run.baselineCutoffOccurredAt) {
        baseline.push(episodeId);
      } else if (episodeUsesCandidate(episodeId, candidate.id, this.ledger)) {
        const split = episodeExperimentSplit(episodeId, this.ledger);
        if ((split === 'selection' || split === 'legacy') && selection.length < candidate.validationSpec.minimumSelectionSamples) {
          selection.push(episodeId);
          representedTrials.add(planRunKey);
        } else if ((split === 'hidden' || split === 'legacy') && hidden.length < candidate.validationSpec.minimumHiddenSamples) {
          hidden.push(episodeId);
          representedTrials.add(planRunKey);
        }
      }
    }
    run = this.learning.upsertValidationRun({ ...withoutTimestamps(run), createdAt: run.createdAt, baselineEpisodeIds: baseline, selectionEpisodeIds: selection, hiddenEpisodeIds: hidden, consumedTrialEpisodeIds: consumed });
    if (
      selection.length < candidate.validationSpec.minimumSelectionSamples
      || hidden.length < candidate.validationSpec.minimumHiddenSamples
    ) return null;

    this.learning.upsertValidationRun({ ...withoutTimestamps(run), createdAt: run.createdAt, status: 'evaluating' });
    const baselineMetrics = this.metrics(run.baselineEpisodeIds);
    return {
      candidateId: candidate.id,
      attempt: run.attempt,
      baselineEpisodeIds: [...run.baselineEpisodeIds],
      selectionEpisodeIds: selection,
      hiddenEpisodeIds: hidden,
      control: { selection: baselineMetrics, hidden: baselineMetrics, triggered: true, compliant: true, comparable: true },
      treatment: {
        selection: this.metrics(selection),
        hidden: this.metrics(hidden),
        triggered: [...selection, ...hidden].every(id => episodeUsesCandidate(id, candidate.id, this.ledger)),
        compliant: [...selection, ...hidden].every(id => episodeUsesCandidate(id, candidate.id, this.ledger)),
        comparable: true,
      },
    };
  }

  settle(
    ready: CandidateEvaluationReady,
    decision: 'promote' | 'reject' | 'inconclusive' | 'blacklist',
    allowRetry = true,
  ): 'completed' | 'retry' | 'exhausted' | 'rejected' {
    const run = this.learning.getValidationRun(ready.candidateId);
    if (!run) return 'rejected';
    if (decision === 'promote') {
      this.learning.upsertValidationRun({ ...withoutTimestamps(run), createdAt: run.createdAt, status: 'promoted' });
      return 'completed';
    }
    if (decision === 'blacklist') {
      this.learning.upsertValidationRun({ ...withoutTimestamps(run), createdAt: run.createdAt, status: 'blacklisted' });
      return 'rejected';
    }
    if (run.attempt >= 3) {
      this.learning.upsertValidationRun({ ...withoutTimestamps(run), createdAt: run.createdAt, status: 'rejected' });
      return 'rejected';
    }
    if (!allowRetry) {
      this.learning.upsertValidationRun({ ...withoutTimestamps(run), createdAt: run.createdAt, status: 'rejected' });
      return 'exhausted';
    }
    this.learning.upsertValidationRun({
      ...withoutTimestamps(run),
      createdAt: run.createdAt,
      selectionEpisodeIds: [],
      hiddenEpisodeIds: [],
      consumedTrialEpisodeIds: unique([...run.consumedTrialEpisodeIds, ...run.selectionEpisodeIds, ...run.hiddenEpisodeIds]),
      attempt: run.attempt + 1,
      status: 'collecting',
    });
    return 'retry';
  }

  private metrics(ids: string[]): PolicyMetrics {
    const episodes = ids.map(id => this.ledger.getEpisode(id)).filter((value): value is PlannerLeafEpisode => value != null);
    const plans = uniqueByPlan(episodes).map(episode => planMetrics(episode, this.ledger, this.attributor));
    const samples = plans.length;
    const durations = plans.map(plan => plan.durationMs).sort((a, b) => a - b);
    const actions = plans.map(plan => plan.actions).sort((a, b) => a - b);
    const llmRounds = plans.map(plan => plan.llmRounds).sort((a, b) => a - b);
    const noProgressActions = plans.map(plan => plan.noProgressActions).sort((a, b) => a - b);
    const recoveryCounts = plans.map(plan => plan.recoveryCount).sort((a, b) => a - b);
    const replanCounts = plans.map(plan => plan.replanCount).sort((a, b) => a - b);
    const invalidActions = plans.map(plan => plan.invalidActions).sort((a, b) => a - b);
    return {
      successRate: samples === 0 ? 0 : plans.filter(plan => plan.succeeded).length / samples,
      medianDurationMs: median(durations),
      medianActions: median(actions),
      medianLlmRounds: median(llmRounds),
      p95DurationMs: percentile(durations, .95),
      p95Actions: percentile(actions, .95),
      p95LlmRounds: percentile(llmRounds, .95),
      medianNoProgressActions: median(noProgressActions),
      medianRecoveryCount: median(recoveryCounts),
      medianReplanCount: median(replanCounts),
      medianInvalidActions: median(invalidActions),
      interventionRate: samples === 0 ? 0 : plans.filter(plan => plan.intervention).length / samples,
      safetyViolations: plans.filter(plan => plan.safetyViolation).length,
      samples,
    };
  }
}

function oneEpisodePerPlanRun(ids: readonly string[], ledger: EpisodeLedger): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    const key = ledger.getEpisode(id)?.planRunId ?? `episode:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(id);
  }
  return result;
}

function representedPlanRunIds(ids: readonly string[], ledger: EpisodeLedger): Set<string> {
  return new Set(ids.map(id => ledger.getEpisode(id)?.planRunId ?? `episode:${id}`));
}

function trackedTrialEligible(
  id: string,
  candidateId: string,
  ledger: EpisodeLedger,
  learning: PlannerLearningStore,
): boolean {
  const episode = ledger.getEpisode(id);
  if (!episode) return false;
  const allocation = learning.getExperimentAllocation(episode.planRunId);
  return allocation
    ? candidateExperimentEvidenceEligible(episode, candidateId, allocation)
    : false;
}

function finalizedTrialEligible(
  episode: PlannerLeafEpisode,
  candidateId: string,
  learning: PlannerLearningStore,
): boolean {
  const allocation = learning.getExperimentAllocation(episode.planRunId);
  return !!allocation && candidateExperimentEvidenceEligible(episode, candidateId, allocation);
}

interface PlanMetricSample {
  succeeded: boolean;
  durationMs: number;
  actions: number;
  llmRounds: number;
  noProgressActions: number;
  recoveryCount: number;
  replanCount: number;
  invalidActions: number;
  intervention: boolean;
  safetyViolation: boolean;
}

function planMetrics(
  seed: PlannerLeafEpisode,
  ledger: EpisodeLedger,
  attributor: ExperienceAttributor,
): PlanMetricSample {
  const bound = seed.facts.find(fact => fact.eventType === 'execution.plan.bound');
  const episodes = bound
    ? ledger.listEpisodes({ state: 'finalized' }).filter(episode => episode.planRunId === seed.planRunId)
    : [seed];
  const attributions = episodes.map(episode => attributor.classify(episode));
  const latest = latestPlanEpisodes(episodes);
  const expectedNodes = declaredPlanNodeCount(episodes);
  const starts = episodes
    .map(episode => episode.facts.find(fact => fact.eventType === 'execution.session.started')?.occurredAt)
    .filter((value): value is string => !!value)
    .map(Date.parse);
  const terminals = episodes
    .map(episode => episode.facts.find(fact => fact.eventType === 'execution.session.terminal')?.occurredAt)
    .filter((value): value is string => !!value)
    .map(Date.parse);
  return {
    succeeded: latest.length >= expectedNodes && latest.every(episode => episode.outcome === 'succeeded'),
    durationMs: starts.length > 0 && terminals.length > 0
      ? Math.max(0, Math.max(...terminals) - Math.min(...starts))
      : episodes.reduce((total, episode) => total + durationMs(episode), 0),
    actions: episodes.reduce(
      (total, episode) => total + episode.facts.filter(fact => fact.eventType === 'execution.action.proposed').length,
      0,
    ),
    llmRounds: episodes.reduce((total, episode) => total + episodeLlmRounds(episode), 0),
    noProgressActions: episodes.reduce((total, episode) => total + episode.facts.filter(
      fact => fact.eventType === 'execution.progress.observed' && fact.payload.meaningful === false,
    ).length, 0),
    recoveryCount: episodes.reduce((total, episode) => total + episode.facts.filter(
      fact => fact.eventType === 'execution.recovery.decided',
    ).length, 0),
    replanCount: Math.max(0, ...episodes.map(episode => episode.planRevision - 1)),
    invalidActions: episodes.reduce((total, episode) => total + episode.facts.filter(isInvalidActionFact).length, 0),
    intervention: attributions.some(item => item.reason === 'decision.need_owner' || item.failure?.ownerActionable),
    safetyViolation: attributions.some(item => item.category === 'safety_violation'),
  };
}

function isInvalidActionFact(fact: PlannerLeafEpisode['facts'][number]): boolean {
  if (fact.eventType !== 'execution.recovery.decided') return false;
  const failure = isRecord(fact.payload.failure) ? fact.payload.failure : null;
  return failure?.origin === 'contract' || String(failure?.code ?? '').startsWith('contract.');
}

function episodeLlmRounds(episode: PlannerLeafEpisode): number {
  const reported = episode.facts
    .filter(fact => fact.eventType === 'execution.progress.observed')
    .map(fact => fact.payload.progress)
    .filter((value): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value))
    .map(value => Number(value.llmRounds ?? 0))
    .filter(Number.isFinite)
    .reduce((max, value) => Math.max(max, value), 0);
  if (reported > 0) return reported;
  return episode.facts.filter(fact =>
    fact.eventType === 'execution.action.proposed'
    && isRecord(fact.payload.proposal)
    && fact.payload.proposal.source === 'slow_llm'
  ).length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function uniqueByPlan(episodes: PlannerLeafEpisode[]): PlannerLeafEpisode[] {
  const seen = new Set<string>();
  return episodes.filter(episode => {
    const key = episode.facts.some(fact => fact.eventType === 'execution.plan.bound')
      ? episode.planRunId
      : episode.sessionId;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function durationMs(episode: PlannerLeafEpisode): number {
  const started = episode.facts.find(fact => fact.eventType === 'execution.session.started')?.occurredAt;
  const terminal = episode.facts.find(fact => fact.eventType === 'execution.session.terminal')?.occurredAt;
  if (!started || !terminal) return 0;
  return Math.max(0, Date.parse(terminal) - Date.parse(started));
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const middle = Math.floor(values.length / 2);
  return values.length % 2 === 1 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
}

function percentile(values: number[], ratio: number): number {
  if (values.length === 0) return 0;
  const index = Math.max(0, Math.min(values.length - 1, Math.ceil(values.length * ratio) - 1));
  return values[index];
}

function unique(values: string[]): string[] { return [...new Set(values)]; }
function stableIds(values: string[]): string { return [...new Set(values)].sort().join('\u0000'); }
function withoutTimestamps(run: CandidateValidationRun): Omit<CandidateValidationRun, 'updatedAt' | 'createdAt'> {
  const { updatedAt: _updatedAt, createdAt: _createdAt, ...rest } = run;
  return rest;
}

function episodeTime(id: string, ledger: EpisodeLedger): string {
  const episode = ledger.getEpisode(id);
  return episode?.facts.find(fact => fact.eventType === 'execution.session.terminal')?.occurredAt
    ?? episode?.facts[episode.facts.length - 1]?.occurredAt
    ?? '';
}

function latestEpisodeTime(ids: string[], ledger: EpisodeLedger): string {
  return ids.map(id => episodeTime(id, ledger)).sort().at(-1) ?? '';
}

function episodeUsesCandidate(id: string, candidateId: string, ledger: EpisodeLedger): boolean {
  const episode = ledger.getEpisode(id);
  const bound = episode?.facts.find(fact => fact.eventType === 'execution.plan.bound');
  // Legacy standalone Episodes predate parent PlanGraph provenance. Preserve
  // their historical evaluation semantics; production parent plans must carry
  // an explicit candidate snapshot.
  if (!bound) return true;
  return episode ? candidateExperimentEvidenceEligible(episode, candidateId) : false;
}

export function candidateExperimentEvidenceEligible(
  episode: PlannerLeafEpisode,
  candidateId: string,
  allocation?: CandidateExperimentAllocation,
): boolean {
  const bound = episode.facts.find(fact => fact.eventType === 'execution.plan.bound');
  const eligible = bound?.payload.candidateId === candidateId
    && Number.isInteger(bound.payload.candidateGeneration)
    && typeof bound.payload.candidateContentHash === 'string'
    && bound.payload.experienceMode === 'experiment'
    && typeof bound.payload.experimentId === 'string'
    && typeof bound.payload.experimentAuthorizationId === 'string'
    && bound.payload.experimentContextComparable === true
    && ['selection', 'hidden'].includes(String(bound.payload.experimentSplit));
  if (!eligible || !allocation) return eligible;
  return allocation.planRunId === episode.planRunId
    && allocation.candidateId === candidateId
    && allocation.candidateGeneration === bound?.payload.candidateGeneration
    && allocation.candidateContentHash === bound.payload.candidateContentHash
    && allocation.experimentId === bound?.payload.experimentId
    && allocation.authorizationId === bound.payload.experimentAuthorizationId
    && allocation.split === bound.payload.experimentSplit
    && allocation.contextSignatureHash === bound.payload.contextSignatureHash
    && allocation.state === 'finalized';
}

function episodeExperimentSplit(id: string, ledger: EpisodeLedger): 'selection' | 'hidden' | 'legacy' | null {
  const bound = ledger.getEpisode(id)?.facts.find(fact => fact.eventType === 'execution.plan.bound');
  if (!bound) return 'legacy';
  return bound?.payload.experimentSplit === 'selection' || bound?.payload.experimentSplit === 'hidden'
    ? bound.payload.experimentSplit
    : null;
}
