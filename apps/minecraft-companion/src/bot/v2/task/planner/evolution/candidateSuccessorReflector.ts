import type { PlannerLeafEpisode } from './episodeLedger.js';
import { ExperienceAttributor, type EpisodeAttribution } from './attributor.js';
import { PlannerOptimizer, type ExperienceCandidate } from './plannerOptimizer.js';
import type { PlannerPolicyContent } from './policyStore.js';
import { canonicalGoalText } from './goalCanonicalizer.js';
import {
  boundedEvidenceRefs,
  CANDIDATE_EVIDENCE_REF_LIMIT,
} from '../evidenceRefBudget.js';
import { repairResourceDemandContent } from './resourceDemandLearner.js';

/**
 * Turns settled Selection evidence into a successor proposal. It is deliberately
 * separate from PlannerOptimizer so Hidden and in-flight Treatment can never
 * mutate the frozen generation being evaluated.
 */
export class CandidateSuccessorReflector {
  constructor(
    private readonly optimizer = new PlannerOptimizer(),
    private readonly attributor = new ExperienceAttributor(),
  ) {}

  reflect(parent: ExperienceCandidate, episodes: PlannerLeafEpisode[]): ExperienceCandidate | null {
    const selection = episodes.filter(episode => isSelectionFor(episode, parent.id));
    if (selection.length === 0) return null;
    const samples = selection.map(episode => ({ episode, attribution: this.attributor.classify(episode) }));
    if (samples.some(sample => sample.attribution.category === 'safety_violation')) return null;
    const learned = this.optimizer.propose(samples).find(proposal =>
      proposal.taskFamily === parent.taskFamily
      && canonicalGoalText(proposal.goalPattern) === canonicalGoalText(parent.goalPattern)
    );
    if (!learned) return null;

    const learnable = samples.filter(sample => sample.attribution.learnable);
    if (learnable.length === 0) return null;
    const negative = learnable.filter(sample =>
      sample.attribution.category === 'planning_error'
      || sample.attribution.category === 'environment_impossible'
    );
    const repairedParent = repairResourceDemandContent(
      parent.content,
      negative.map(sample => sample.episode),
    );
    const content = mergeContent(repairedParent, learned.content, negative.map(sample => sample.attribution));
    return {
      ...learned,
      id: parent.lineageId ?? parent.id,
      lineageId: parent.lineageId ?? parent.id,
      generation: undefined,
      contentHash: undefined,
      evolvedFromCandidateId: undefined,
      content,
      evidenceIds: boundedEvidenceRefs(
        learnable.flatMap(sample => sample.attribution.evidenceIds),
        CANDIDATE_EVIDENCE_REF_LIMIT,
      ),
      positiveEpisodeIds: learned.positiveEpisodeIds,
      negativeEpisodeIds: learned.negativeEpisodeIds,
      status: 'candidate',
      validationSpec: parent.validationSpec ?? learned.validationSpec,
    };
  }
}

function isSelectionFor(episode: PlannerLeafEpisode, candidateId: string): boolean {
  const bound = episode.facts.find(fact => fact.eventType === 'execution.plan.bound');
  return bound?.payload.experienceMode === 'experiment'
    && bound.payload.experimentSplit === 'selection'
    && bound.payload.candidateId === candidateId;
}

function mergeContent(
  parent: PlannerPolicyContent,
  learned: PlannerPolicyContent,
  failures: EpisodeAttribution[],
): PlannerPolicyContent {
  const learnedSchemas = learned.taskSchemas.some(hasStructuredStages)
    ? learned.taskSchemas
    : parent.taskSchemas;
  const reflectionPolicies = failures.map(failure => ({
    id: `meta:selection-reflection:${slug(failure.reason)}`,
    rule: 'on_repeated_planning_failure_refresh_context_and_replan_affected_subgraph',
    trigger: failure.reason,
    source: 'settled_selection',
  }));
  return {
    taskSchemas: uniqueItems([...learnedSchemas, ...parent.taskSchemas]),
    planFragments: uniqueItems([...learned.planFragments, ...parent.planFragments]),
    planRecoveryPatterns: uniqueItems([...learned.planRecoveryPatterns, ...parent.planRecoveryPatterns]),
    metaPolicies: uniqueItems([...reflectionPolicies, ...learned.metaPolicies, ...parent.metaPolicies]),
    applicability: uniqueItems([...parent.applicability, ...learned.applicability]),
  };
}

function hasStructuredStages(value: unknown): boolean {
  if (!isRecord(value) || !Array.isArray(value.stages)) return false;
  return value.stages.some(stage => isRecord(stage)
    && (Array.isArray(stage.structuredSuccessCriteria) || Array.isArray(stage.successCriteria)));
}

function uniqueItems(values: unknown[]): unknown[] {
  const seen = new Set<string>();
  return values.flatMap(value => {
    const key = isRecord(value) && typeof value.id === 'string' ? `id:${value.id}` : `value:${stable(value)}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [structuredClone(value)];
  });
}

function slug(value: string): string {
  return canonicalGoalText(value).replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'unknown';
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
