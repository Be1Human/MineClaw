import { createHash } from 'node:crypto';
import type { ContextSignature, GoalSignature } from '../plannerContracts.js';
import type { ExperimentAuthorizationV1 } from '../experience/experienceContracts.js';
import type { EpisodeLedger, PlannerLeafEpisode } from './episodeLedger.js';
import type {
  CandidateExperimentAllocation,
  CandidateValidationRun,
  PlannerLearningStore,
  ResearchAgendaRecord,
} from './learningStore.js';
import type { ExperienceCandidate } from './plannerOptimizer.js';
import { candidateExperimentEvidenceEligible } from './candidateTrialScheduler.js';
import { comparableContextHash } from '../contextEncoder.js';
import { candidateIdentity } from './candidateIdentity.js';

export interface CandidateExperimentRequest {
  planRunId: string;
  goalSignature: GoalSignature;
  context: ContextSignature;
  enabled: boolean;
  maxEstimatedActions?: number;
}

/**
 * Allocates explicit, persisted Treatment authorizations for future PlanRuns.
 * It never starts a task and never talks to Coordinator/Atomic. The caller may
 * only use the returned authorization while freezing the same parent PlanRun.
 */
export class CandidateExperimentOrchestrator {
  constructor(
    private readonly ledger: EpisodeLedger,
    private readonly learning: PlannerLearningStore,
  ) {}

  authorize(request: CandidateExperimentRequest): ExperimentAuthorizationV1 | null {
    if (!request.enabled) return null;
    this.reconcile();

    const existing = this.learning.getExperimentAllocation(request.planRunId);
    if (existing && existing.state !== 'abandoned') {
      const candidate = this.learning.getCandidate(existing.candidateId);
      if (!candidate?.validationSpec) return null;
      const identity = candidateIdentity(candidate);
      if (identity.generation !== existing.candidateGeneration || identity.contentHash !== existing.candidateContentHash) {
        this.learning.updateExperimentAllocationState(request.planRunId, 'abandoned');
        return null;
      }
      return authorizationFrom(existing, candidate);
    }

    const agenda = new Map(this.learning.listAgenda().map(item => [item.candidateId, item]));
    const candidates = this.learning.listCandidates()
      .filter(candidate => candidate.status === 'candidate' && !!candidate.validationSpec)
      .filter(candidate => candidateMatchesGoal(candidate, request.goalSignature))
      .filter(candidate => contextComparable(candidate, request.context))
      .filter(candidate => isSchedulable(agenda.get(candidate.id)))
      .sort((left, right) => agendaPriority(agenda.get(right.id)) - agendaPriority(agenda.get(left.id)) || left.id.localeCompare(right.id));

    for (const candidate of candidates) {
      const validation = this.learning.getValidationRun(candidate.id);
      if (!validation || validation.status !== 'collecting' || !candidate.validationSpec) continue;
      const requestContextHash = comparableContextHash(request.context);
      const baselineHashes = validation.baselineEpisodeIds
        .map(id => episodeContextHash(this.ledger.getEpisode(id)))
        .filter((value):value is string=>!!value);
      if (validation.baselineEpisodeIds.length > 0
        && (baselineHashes.length !== validation.baselineEpisodeIds.length || !baselineHashes.includes(requestContextHash))) continue;
      const allocations = this.learning.listExperimentAllocations(candidate.id);
      const represented = representedPlanRuns(validation, this.ledger);
      const outstanding = allocations.filter(allocation => allocation.state !== 'abandoned' && !represented.has(allocation.planRunId));
      // One candidate trial at a time. This keeps the experiment serial and
      // avoids spending the whole sample budget before the first result lands.
      if (outstanding.some(allocation => allocation.state === 'allocated')) continue;

      const selectionCount = representedPlanRunCount(validation.selectionEpisodeIds, this.ledger)
        + outstanding.filter(allocation => allocation.split === 'selection').length;
      const hiddenCount = representedPlanRunCount(validation.hiddenEpisodeIds, this.ledger)
        + outstanding.filter(allocation => allocation.split === 'hidden').length;
      const split = selectionCount < candidate.validationSpec.minimumSelectionSamples
        ? 'selection'
        : hiddenCount < candidate.validationSpec.minimumHiddenSamples
          ? 'hidden'
          : null;
      if (!split) continue;

      const contextSignatureHash = requestContextHash;
      const allocation = this.learning.allocateExperiment({
        planRunId: request.planRunId,
        candidateId: candidate.id,
        candidateGeneration: candidateIdentity(candidate).generation,
        candidateContentHash: candidateIdentity(candidate).contentHash,
        experimentId: `experiment:${candidate.id}:attempt:${validation.attempt}`,
        authorizationId: `authorization:${hash(`${candidate.id}:${validation.attempt}:${request.planRunId}`).slice(0, 24)}`,
        split,
        contextSignatureHash,
        maxEstimatedActions: Math.max(1, Math.floor(request.maxEstimatedActions ?? 180)),
        state: 'allocated',
      });
      markAgendaRunning(this.learning, agenda.get(candidate.id));
      return authorizationFrom(allocation, candidate);
    }
    return null;
  }

  reconcile(): void {
    const finalized = this.ledger.listEpisodes({ state: 'finalized' });
    for (const allocation of this.learning.listExperimentAllocations().filter(value => value.state === 'allocated')) {
      const episodes = finalized.filter(episode => episode.planRunId === allocation.planRunId);
      if (episodes.length === 0) continue;
      if (episodes.some(episode => !allocationMatchesEpisode(allocation, episode))) {
        this.learning.updateExperimentAllocationState(allocation.planRunId, 'abandoned');
      }
    }
  }

  /** Planner parent terminal is the authoritative experiment sample boundary. */
  finalizePlanRun(
    planRunId: string,
    outcome: 'succeeded' | 'failed' | 'cancelled',
    detail = '',
  ): void {
    const allocation = this.learning.getExperimentAllocation(planRunId);
    if (!allocation || allocation.state !== 'allocated') return;
    const cancelled = outcome === 'cancelled' || detail.toLowerCase().includes('cancel');
    this.learning.updateExperimentAllocationState(
      planRunId,
      cancelled ? 'abandoned' : 'finalized',
    );
  }

  abandon(planRunId: string): void {
    this.learning.updateExperimentAllocationState(planRunId, 'abandoned');
  }
}

function authorizationFrom(allocation: CandidateExperimentAllocation, candidate: ExperienceCandidate): ExperimentAuthorizationV1 {
  if (!candidate.validationSpec) throw new Error(`candidate has no validation spec: ${candidate.id}`);
  return {
    schema: 'mineclaw.planner-experiment-authorization/v1',
    experimentId: allocation.experimentId,
    candidateId: allocation.candidateId,
    candidateGeneration: allocation.candidateGeneration,
    candidateContentHash: allocation.candidateContentHash,
    validationSpec: structuredClone(candidate.validationSpec),
    split: allocation.split,
    budget: {
      authorizationId: allocation.authorizationId,
      maxPlanRuns: 1,
      maxEstimatedActions: allocation.maxEstimatedActions,
      authorized: true,
    },
    contextComparable: true,
  };
}

function candidateMatchesGoal(
  candidate: ExperienceCandidate,
  goal: GoalSignature,
): boolean {
  if (!goal.compatibleTaskFamilies.includes(candidate.taskFamily)) return false;
  const rules = candidate.content.applicability.filter(isRecord);
  if (rules.some(rule => rule.goalSignature === goal.key)) return true;
  if (rules.some(rule => normalizeId(rule.targetId) === goal.targetId)) return true;
  return false;
}

function contextComparable(candidate: ExperienceCandidate, context: ContextSignature): boolean {
  for (const rule of candidate.content.applicability.filter(isRecord)) {
    if (typeof rule.requiresCapability === 'string' && !context.capabilities.includes(rule.requiresCapability)) return false;
    if (typeof rule.maxDangerLevel === 'number' && context.dangerLevel > rule.maxDangerLevel) return false;
    if (typeof rule.contextFacilityMissing === 'string' && context.nearbyFacilities.includes(rule.contextFacilityMissing)) return false;
  }
  return true;
}

function representedPlanRuns(run: CandidateValidationRun, ledger: EpisodeLedger): Set<string> {
  const result = new Set<string>();
  for (const id of [...run.selectionEpisodeIds, ...run.hiddenEpisodeIds, ...run.consumedTrialEpisodeIds]) {
    const episode = ledger.getEpisode(id);
    if (episode) result.add(episode.planRunId);
  }
  return result;
}

function representedPlanRunCount(episodeIds: readonly string[], ledger: EpisodeLedger): number {
  return new Set(episodeIds.map(id => ledger.getEpisode(id)?.planRunId ?? `episode:${id}`)).size;
}

function allocationMatchesEpisode(allocation: CandidateExperimentAllocation, episode: PlannerLeafEpisode): boolean {
  if (!candidateExperimentEvidenceEligible(episode, allocation.candidateId)) return false;
  const bound = episode.facts.find(fact => fact.eventType === 'execution.plan.bound');
  return bound?.payload.experimentId === allocation.experimentId
    && bound.payload.candidateGeneration === allocation.candidateGeneration
    && bound.payload.candidateContentHash === allocation.candidateContentHash
    && bound.payload.experimentAuthorizationId === allocation.authorizationId
    && bound.payload.experimentSplit === allocation.split;
}

function episodeContextHash(episode: PlannerLeafEpisode | null): string | null {
  const bound=episode?.facts.find(fact=>fact.eventType==='execution.plan.bound');
  return typeof bound?.payload.contextSignatureHash==='string'?bound.payload.contextSignatureHash:null;
}

function isSchedulable(item: ResearchAgendaRecord | undefined): boolean {
  return !!item && ['queued', 'running', 'inconclusive'].includes(item.status) && item.retryBudget > 0 && item.safetyRisk === 0;
}

function agendaPriority(item: ResearchAgendaRecord | undefined): number {
  if (!item) return -Infinity;
  return (item.expectedInformationGain * item.uncertainty * item.impactScope * item.headroom)
    / Math.max(0.001, item.estimatedCost + item.safetyRisk);
}

function markAgendaRunning(store: PlannerLearningStore, current: ResearchAgendaRecord | undefined): void {
  if (!current || current.status === 'running') return;
  const { updatedAt: _updatedAt, ...input } = current;
  store.upsertAgenda({ ...input, status: 'running', reason: 'experiment_allocated' });
}

function normalizeId(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const normalized = value.trim().toLowerCase();
  return normalized.includes(':') ? normalized : `minecraft:${normalized}`;
}
function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
