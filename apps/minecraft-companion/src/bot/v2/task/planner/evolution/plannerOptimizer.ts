import type { PlannerPolicyContent } from './policyStore.js';
import type { PlannerLeafEpisode } from './episodeLedger.js';
import type { EpisodeAttribution } from './attributor.js';
import { canonicalGoalText, inferPlannerTaskFamily } from './goalCanonicalizer.js';
import { declaredPlanNodeCount, latestPlanEpisodes } from './planEpisodeAggregation.js';
import {
  boundedEvidenceRefs,
  CANDIDATE_EVIDENCE_REF_LIMIT,
} from '../evidenceRefBudget.js';
import {
  lowestCostSuccessfulEpisode,
  successfulResourceMilestones,
  type LearnedResourceMilestone,
} from './resourceDemandLearner.js';

export interface ExperienceCandidate {
  id: string;
  /** Stable identity shared by all successor candidates for one concrete task. */
  lineageId?: string;
  /** Monotonic generation inside lineageId. Generation 1 keeps legacy IDs. */
  generation?: number;
  /** Immutable hash of treatment content + ValidationSpec for this generation. */
  contentHash?: string;
  /** Previous candidate generation, distinct from the trusted Policy parent. */
  evolvedFromCandidateId?: string;
  taskFamily: string;
  goalPattern: string;
  content: PlannerPolicyContent;
  evidenceIds: string[];
  positiveEpisodeIds: string[];
  negativeEpisodeIds: string[];
  confidenceLowerBound: number;
  status: 'candidate' | 'backlog' | 'blacklisted';
  validationSpec?: ValidationSpec;
}

export interface ValidationSpec {
  id: string;
  validatorId: string;
  primaryMetric: 'success_rate';
  minimumSelectionSamples: number;
  minimumHiddenSamples: number;
  pairing: 'snapshot_pair' | 'stratified_unpaired';
  treatmentField: string;
}

export class PlannerOptimizer {
  propose(samples: Array<{ episode: PlannerLeafEpisode; attribution: EpisodeAttribution }>): ExperienceCandidate[] {
    const normalizedSamples = aggregatePlanSamples(samples);
    const grouped = new Map<string, Array<{ episode: PlannerLeafEpisode; attribution: EpisodeAttribution }>>();
    for (const sample of normalizedSamples.filter(item => item.attribution.learnable || item.attribution.category === 'safety_violation')) {
      const goal = goalText(sample.episode);
      const family = inferPlannerTaskFamily(goal);
      const key = `${family}:${canonicalGoalText(goal)}`;
      const values = grouped.get(key) ?? [];
      values.push(sample);
      grouped.set(key, values);
    }

    return [...grouped.entries()].map(([key, values]) => {
      const [taskFamily] = key.split(':');
      const goalPattern = goalText(values[0].episode);
      const positives = values.filter(item => item.attribution.category === 'success');
      const negatives = values.filter(item => ['planning_error', 'environment_impossible'].includes(item.attribution.category));
      const safety = values.some(item => item.attribution.category === 'safety_violation');
      const evidenceIds = boundedEvidenceRefs(
        values.flatMap(item => item.attribution.evidenceIds),
        CANDIDATE_EVIDENCE_REF_LIMIT,
      );
      const actions = [...new Set(positives.flatMap(item => proposedActions(item.episode)))];
      const bestSuccess = lowestCostSuccessfulEpisode(positives.map(item => item.episode));
      const intermediateStages = bestSuccess
        ? successfulResourceMilestones(bestSuccess, rootTargetId(bestSuccess))
        : [];
      const finalStage = bestSuccess ? learnedFinalStage(bestSuccess, goalPattern) : null;
      const structuredStages = intermediateStages.length > 0 && finalStage ? [...intermediateStages, finalStage] : [];
      const learnedStages = actions.filter(action => !action.startsWith('atomic:'));
      const recoveryCodes = [...new Set(negatives.map(item => item.attribution.reason))];
      const sampleCount = positives.length + negatives.length;
      const confidenceLowerBound = conservativeRate(positives.length, Math.max(1, sampleCount));
      const id = `candidate:${slug(key)}`;
      const content: PlannerPolicyContent = {
        taskSchemas: [{
          id: `schema:${slug(key)}`,
          taskFamily,
          goalPattern,
          stages: structuredStages.length > 0 ? structuredStages : learnedStages.length > 0 ? learnedStages : inferStages(taskFamily),
        }],
        planFragments: structuredStages.length > 0
          ? structuredStages.map((stage, index) => ({ ...stage, id: `fragment:${slug(key)}:${slug(stage.stage)}`, order: index, applicableTo: goalPattern }))
          : actions.map((action, index) => ({ id: `fragment:${slug(key)}:${slug(action)}`, order: index, action, applicableTo: goalPattern })),
        planRecoveryPatterns: recoveryCodes.map(code => ({ id: `recovery:${slug(code)}`, after: code, graphChange: 'replan_affected_subgraph' })),
        metaPolicies: [{ id: `meta:${slug(taskFamily)}:inspect-first`, rule: 'inspect_context_and_dependencies_before_execution' }],
        applicability: [{
          taskFamily,
          goalContains: canonicalGoalText(goalPattern),
          ...(goalSignature(values[0].episode) ? { goalSignature: goalSignature(values[0].episode) } : {}),
          ...(rootTargetId(values[0].episode) ? { targetId: rootTargetId(values[0].episode) } : {}),
        }],
      };
      return {
        id,
        taskFamily,
        goalPattern,
        content,
        evidenceIds,
        positiveEpisodeIds: positives.map(item => item.episode.sessionId),
        negativeEpisodeIds: negatives.map(item => item.episode.sessionId),
        confidenceLowerBound,
        status: safety ? 'blacklisted' : sampleCount < 1 ? 'backlog' : 'candidate',
        ...(safety ? {} : { validationSpec: {
          id: `validation:${slug(key)}`,
          validatorId: `${taskFamily}-goal-verifier`,
          primaryMetric: 'success_rate' as const,
          minimumSelectionSamples: 2,
          minimumHiddenSamples: 1,
          pairing: 'snapshot_pair' as const,
          treatmentField: 'planner_policy',
        } }),
      };
    });
  }
}

function goalText(episode: PlannerLeafEpisode): string {
  const bound = episode.facts.find(fact => fact.eventType === 'execution.plan.bound');
  if (typeof bound?.payload.parentGoalText === 'string' && bound.payload.parentGoalText.trim()) {
    return bound.payload.parentGoalText.trim();
  }
  const started = episode.facts.find(fact => fact.eventType === 'execution.session.started');
  if (typeof started?.payload.parentGoalText === 'string' && started.payload.parentGoalText.trim()) {
    return started.payload.parentGoalText.trim();
  }
  const value = started?.payload.goalText;
  return typeof value === 'string' && value.trim() ? value.trim() : episode.nodeId;
}

function proposedActions(episode: PlannerLeafEpisode): string[] {
  const bound = episode.facts.find(fact => fact.eventType === 'execution.plan.bound');
  const graph = isRecord(bound?.payload.planGraph) ? bound.payload.planGraph : null;
  const nodes = graph && Array.isArray(graph.nodes) ? graph.nodes.filter(isRecord) : [];
  const plannedGoals = nodes
    .map(node => isRecord(node.goal) && typeof node.goal.goalText === 'string' ? node.goal.goalText.trim() : '')
    .filter(Boolean);
  if (plannedGoals.length > 0) return plannedGoals;
  return episode.facts
    .filter(fact => fact.eventType === 'execution.action.proposed')
    .map(fact => fact.payload.proposal)
    .map(proposal => isRecord(proposal) && typeof proposal.action === 'string' ? proposal.action : null)
    .filter((value): value is string => value != null)
    .map(value => `atomic:${value}`);
}

function learnedFinalStage(episode: PlannerLeafEpisode, goalPattern: string): LearnedResourceMilestone | null {
  const target = rootTargetId(episode)?.replace(/^minecraft:/, '');
  if (!target) return null;
  const criterion = rootInventoryCriterion(episode, target) ?? { type: 'inventory' as const, item: target, count: signatureQuantity(goalSignature(episode)) ?? 1 };
  const bound = episode.facts.find(fact => fact.eventType === 'execution.plan.bound');
  const terminal = [...episode.facts].reverse().find(fact => fact.eventType === 'execution.session.terminal');
  return {
    stage: `complete:${target}`,
    goalText: goalPattern,
    structuredSuccessCriteria: [criterion],
    successCriteria: [criterion],
    evidenceRefs: [bound?.eventId, terminal?.eventId].filter((value): value is string => !!value),
    order: Number.MAX_SAFE_INTEGER,
  };
}

function rootInventoryCriterion(episode: PlannerLeafEpisode, target: string): { type: 'inventory'; item: string; count: number } | null {
  const bound = episode.facts.find(fact => fact.eventType === 'execution.plan.bound');
  const graph = isRecord(bound?.payload.planGraph) ? bound.payload.planGraph : null;
  const nodes = graph && Array.isArray(graph.nodes) ? graph.nodes.filter(isRecord) : [];
  for (const node of nodes) {
    const goal = isRecord(node.goal) ? node.goal : null;
    const metadata = goal && isRecord(goal.metadata) ? goal.metadata : null;
    const criteria = metadata && Array.isArray(metadata.structuredSuccessCriteria) ? metadata.structuredSuccessCriteria.filter(isRecord) : [];
    for (const value of criteria) {
      if (value.type !== 'inventory' || typeof value.item !== 'string' || normalizeItem(value.item) !== target) continue;
      const count = typeof value.count === 'number' && Number.isFinite(value.count) ? Math.max(1, Math.floor(value.count)) : 1;
      return { type: 'inventory', item: target, count };
    }
  }
  return null;
}

function signatureQuantity(signature: string | null): number | null {
  if (!signature) return null;
  const match = signature.match(/:(\d+)$/);
  return match?.[1] ? Math.max(1, Number(match[1])) : null;
}

function goalSignature(episode: PlannerLeafEpisode): string | null {
  const bound = episode.facts.find(fact => fact.eventType === 'execution.plan.bound');
  return typeof bound?.payload.goalSignature === 'string' && bound.payload.goalSignature.trim() ? bound.payload.goalSignature : null;
}

function rootTargetId(episode: PlannerLeafEpisode): string | null {
  const bound = episode.facts.find(fact => fact.eventType === 'execution.plan.bound');
  const graph = isRecord(bound?.payload.planGraph) ? bound.payload.planGraph : null;
  const nodes = graph && Array.isArray(graph.nodes) ? graph.nodes.filter(isRecord) : [];
  for (const node of nodes) {
    const goal = isRecord(node.goal) ? node.goal : null;
    const metadata = goal && isRecord(goal.metadata) ? goal.metadata : null;
    if (typeof metadata?.targetId === 'string' && metadata.targetId.trim()) return normalizeTarget(metadata.targetId);
  }
  const signature = goalSignature(episode);
  if (!signature) return null;
  const match = signature.match(/^(?:obtain|build):item:(.+):\d+$/);
  return match?.[1] ? normalizeTarget(match[1]) : null;
}

function normalizeItem(value: string): string { return value.trim().toLowerCase().replace(/^minecraft:/, ''); }
function normalizeTarget(value: string): string { const normalized=value.trim().toLowerCase();return normalized.includes(':')?normalized:`minecraft:${normalized}`; }

/**
 * A parent PlanGraph is one learning sample even when it contains many leaf
 * Episodes. It becomes positive only after every declared node has a successful
 * terminal; a partial success must never promote the whole plan.
 */
function aggregatePlanSamples(
  samples: Array<{ episode: PlannerLeafEpisode; attribution: EpisodeAttribution }>,
): Array<{ episode: PlannerLeafEpisode; attribution: EpisodeAttribution }> {
  const standalone: Array<{ episode: PlannerLeafEpisode; attribution: EpisodeAttribution }> = [];
  const grouped = new Map<string, Array<{ episode: PlannerLeafEpisode; attribution: EpisodeAttribution }>>();
  for (const sample of samples) {
    const bound = sample.episode.facts.find(fact => fact.eventType === 'execution.plan.bound');
    if (!bound) {
      standalone.push(sample);
      continue;
    }
    const values = grouped.get(sample.episode.planRunId) ?? [];
    values.push(sample);
    grouped.set(sample.episode.planRunId, values);
  }
  for (const values of grouped.values()) {
    const latestEpisodes = latestPlanEpisodes(values.map(value => value.episode));
    const latestSessionIds = new Set(latestEpisodes.map(episode => episode.sessionId));
    const latestValues = values.filter(value => latestSessionIds.has(value.episode.sessionId));
    const expectedNodes = declaredPlanNodeCount(values.map(value => value.episode));
    const uniqueNodes = new Set(latestEpisodes.map(episode => episode.nodeId));
    const safety = values.find(value => value.attribution.category === 'safety_violation');
    const planningFailure = latestValues.find(value => value.attribution.category === 'planning_error');
    const graphComplete = uniqueNodes.size >= expectedNodes;
    // Partial success is not a positive parent-plan sample. A structured
    // graph-level failure is different: the unexecuted suffix is exactly the
    // evidence that the parent decomposition/recovery was insufficient, so it
    // must remain available as a negative Planner sample.
    if (!graphComplete && !safety && !planningFailure) continue;
    const allSucceeded = graphComplete && latestValues.every(value => value.attribution.category === 'success');
    const evidenceIds = boundedEvidenceRefs(
      values.flatMap(value => value.attribution.evidenceIds),
      CANDIDATE_EVIDENCE_REF_LIMIT,
    );
    const representative = allSucceeded ? latestValues[0] : safety ?? planningFailure ?? latestValues.find(value => value.attribution.category !== 'success') ?? latestValues[0];
    const base = representative.attribution;
    const attribution: EpisodeAttribution = allSucceeded
      ? {
          episodeId: representative.episode.planRunId,
          category: 'success',
          confidence: 1,
          learnable: true,
          reason: 'plan_all_nodes_satisfied',
          evidenceIds,
        }
      : {
          ...base,
          episodeId: representative.episode.planRunId,
          evidenceIds,
          learnable: safety ? false : Boolean(planningFailure?.attribution.learnable),
        };
    const mergedEpisode: PlannerLeafEpisode = {
      ...representative.episode,
      facts: latestValues.flatMap(value => value.episode.facts)
        .sort((left, right) => left.occurredAt.localeCompare(right.occurredAt) || left.sequence - right.sequence),
    };
    standalone.push({ episode: mergedEpisode, attribution });
  }
  return standalone;
}

function inferStages(family: string): string[] {
  if (family === 'crafting') return ['inspect_recipe', 'prepare_facilities', 'prepare_materials', 'craft', 'verify_inventory'];
  if (family === 'building') return ['inspect_site', 'prepare_materials', 'build_in_stages', 'verify_structure'];
  if (family === 'exploration') return ['prepare_safety', 'navigate', 'search', 'return', 'verify_result'];
  return ['inspect_context', 'plan_dependencies', 'execute', 'verify'];
}

function conservativeRate(successes: number, total: number): number {
  const p = successes / total;
  const z = 1.96;
  const denominator = 1 + (z * z) / total;
  const center = p + (z * z) / (2 * total);
  const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * total)) / total);
  return Math.max(0, (center - margin) / denominator);
}

function slug(value: string): string { return canonicalGoalText(value).replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'unknown'; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
