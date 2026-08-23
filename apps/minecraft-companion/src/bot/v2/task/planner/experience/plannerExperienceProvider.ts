import { createHash } from 'node:crypto';
import { PlannerPolicyStore } from '../evolution/policyStore.js';
import type { PlannerLearningStore } from '../evolution/learningStore.js';
import type { ExperienceCandidate } from '../evolution/plannerOptimizer.js';
import type { ContextSignature, GoalSignature } from '../plannerContracts.js';
import { canonicalGoalText, inferPlannerTaskFamily } from '../evolution/goalCanonicalizer.js';
import { ExperienceBundleCompiler, type CompiledPlannerExperienceBundle } from './experienceBundleCompiler.js';
import type { ExperienceColdStart, ExperienceFreezeRequest, ExperienceSelectionManifest, ExperimentAuthorizationV1 } from './experienceContracts.js';
import type { PlannerPolicyRecord } from '../evolution/policyStore.js';
import { PlannerGraphRetriever } from './graphRetriever.js';
import { candidateIdentity } from '../evolution/candidateIdentity.js';
import type { EvolutionGraphStore } from '../evolution/evolutionGraphStore.js';
import { boundedEvidenceRefs, CANDIDATE_EVIDENCE_REF_LIMIT } from '../evidenceRefBudget.js';

export interface PlannerExperienceBundle extends CompiledPlannerExperienceBundle {
  /** Compatibility aliases used by pre-006 execution facts. */
  candidateId?: string;
  candidateGeneration?: number;
  candidateContentHash?: string;
  experimentId?: string;
  experimentSplit?: 'selection' | 'hidden';
  experimentAuthorizationId?: string;
  validationSpecId?: string;
}

export type PlannerExperienceFreezeResult =
  | { status: 'frozen'; bundle: PlannerExperienceBundle }
  | ExperienceColdStart;

export type PlannerExperimentFreezeResult = PlannerExperienceFreezeResult
  | { status: 'rejected'; reason: 'authorization_incomplete' | 'candidate_not_found' | 'candidate_not_eligible' | 'candidate_snapshot_mismatch' | 'validation_mismatch' | 'context_not_comparable' };

/**
 * Production experience boundary.
 * `freeze` is the authoritative API: it reads graph state once and returns an
 * immutable bundle or an explicit cold-start result. It never mutates policy.
 */
export class PlannerExperienceProvider {
  private readonly retriever: PlannerGraphRetriever;
  private readonly compiler = new ExperienceBundleCompiler();
  constructor(
    private readonly policies: PlannerPolicyStore,
    // Retained for the explicit experiment API implemented by 006-003.
    private readonly learning?: Pick<PlannerLearningStore, 'listCandidates'>,
    graph?: Pick<EvolutionGraphStore, 'getNode' | 'querySubgraph'>,
  ) {
    this.retriever = new PlannerGraphRetriever(.55, graph);
  }

  freeze(request: ExperienceFreezeRequest): PlannerExperienceFreezeResult {
    const retrieval = this.retriever.retrieve(this.policies.list(), request.goalSignature, request.context);
    const bundle = this.compiler.compile({ ...request, mode: request.mode ?? 'production' }, retrieval);
    if (bundle) return { status: 'frozen', bundle };
    const reason: ExperienceColdStart['reason'] = retrieval.corrupt
      ? 'graph_corrupt'
      : retrieval.rejected.some(value => value.reason === 'low_confidence')
        ? 'low_confidence'
        : 'no_applicable_experience';
    return {
      status: 'cold_start', reason,
      selectionManifest: coldStartManifest(request, retrieval.contextSignatureHash, retrieval.rejected),
    };
  }

  freezeExperiment(request: ExperienceFreezeRequest, authorization: ExperimentAuthorizationV1): PlannerExperimentFreezeResult {
    const authError = validateAuthorization(authorization);
    if (authError) return { status: 'rejected', reason: authError };
    if (request.mode !== 'experiment') return { status: 'rejected', reason: 'authorization_incomplete' };
    if (!authorization.contextComparable) return { status: 'rejected', reason: 'context_not_comparable' };
    const candidate = this.learning?.listCandidates().find(value => value.id === authorization.candidateId);
    if (!candidate) return { status: 'rejected', reason: 'candidate_not_found' };
    if (candidate.status !== 'candidate' || !candidate.validationSpec) return { status: 'rejected', reason: 'candidate_not_eligible' };
    const identity = candidateIdentity(candidate);
    if (identity.generation !== authorization.candidateGeneration
      || identity.contentHash !== authorization.candidateContentHash) {
      return { status: 'rejected', reason: 'candidate_snapshot_mismatch' };
    }
    if (candidate.validationSpec.id !== authorization.validationSpec.id
      || stable(candidate.validationSpec) !== stable(authorization.validationSpec)) {
      return { status: 'rejected', reason: 'validation_mismatch' };
    }
    if (!request.goalSignature.compatibleTaskFamilies.includes(candidate.taskFamily)) {
      return { status: 'rejected', reason: 'candidate_not_eligible' };
    }
    const synthetic = candidatePolicy(candidate);
    const retrieval = this.retriever.retrieve(
      [synthetic],
      request.goalSignature,
      request.context,
      { rootNodeId: candidate.id, rootNodeType: 'candidate', rootNodeState: 'candidate' },
    );
    const compiled = this.compiler.compile({ ...request, mode: 'experiment' }, retrieval);
    if (!compiled) {
      return { status: 'cold_start', reason: retrieval.corrupt ? 'graph_corrupt' : 'no_applicable_experience', selectionManifest: coldStartManifest(request, retrieval.contextSignatureHash, retrieval.rejected) };
    }
    return { status: 'frozen', bundle: Object.freeze({
      ...compiled,
      candidateId: candidate.id,
      candidateGeneration: authorization.candidateGeneration,
      candidateContentHash: authorization.candidateContentHash,
      experimentId: authorization.experimentId,
      experimentSplit: authorization.split,
      experimentAuthorizationId: authorization.budget.authorizationId,
      validationSpecId: authorization.validationSpec.id,
    }) };
  }

  /** Compatibility read. Production callers still receive trusted data only. */
  retrieve(goalText?: string): PlannerExperienceBundle | null {
    const signature = goalText ? this.signatureForText(goalText) : this.fallbackSignature();
    if (!signature) return null;
    const result = this.freeze({
      planRunId: `compat-${hash(goalText ?? signature.key).slice(0, 16)}`,
      goalSignature: signature,
      context: emptyContext(),
      mode: 'production',
    });
    return result.status === 'frozen' ? result.bundle : null;
  }

  hasExperimentCandidateSource(): boolean { return !!this.learning; }

  /**
   * BUG-CROSS-55 · 自然语言 → 结构化目标只属于 GoalAgent Resolution Loop。
   * 经验兼容读取只按任务族与规范化文本检索，不再自建物品白名单反解目标。
   */
  private signatureForText(goalText: string): GoalSignature | null {
    const canonical = canonicalGoalText(goalText);
    if (!canonical) return null;
    const digest = hash(canonical).slice(0, 16);
    return Object.freeze({
      key: `text:${digest}`,
      outcome: 'obtain' as const,
      targetKind: 'state' as const,
      targetId: `text:${digest}`,
      quantity: 1,
      constraintsHash: hash('[]').slice(0, 16),
      compatibleTaskFamilies: Object.freeze([inferPlannerTaskFamily(goalText)]),
      schemaVersion: 1 as const,
    });
  }

  private fallbackSignature(): GoalSignature | null {
    const policy = this.policies.listActive()[0];
    if (!policy) return null;
    const rule = policy.content.applicability.find(value => value && typeof value === 'object' && !Array.isArray(value)) as Record<string, unknown> | undefined;
    const family = typeof rule?.taskFamily === 'string' ? rule.taskFamily : 'general';
    return {
      key: `compat:${family}:policy`, outcome: 'obtain', targetKind: 'state', targetId: 'compat:policy',
      quantity: 1, constraintsHash: hash('[]').slice(0, 16), compatibleTaskFamilies: [family], schemaVersion: 1,
    };
  }
}

export function formatPlannerExperienceBundle(bundle: PlannerExperienceBundle | null, goalText: string): string {
  if (!bundle) return '';
  const payload = {
    bundleId: bundle.bundleId,
    contentHash: bundle.contentHash,
    policySnapshotId: bundle.policySnapshotId,
    selectionManifestId: bundle.selectionManifestId,
    confidenceLowerBound: bundle.confidenceLowerBound,
    taskSchemas: bundle.taskSchemas.slice(0, 4),
    planFragments: bundle.planFragments.slice(0, 8),
    planRecoveryPatterns: bundle.planRecoveryPatterns.slice(0, 6),
    metaPolicies: bundle.metaPolicies.slice(0, 4),
    evidenceRefs: bundle.evidenceRefs.slice(0, 12),
    ...(bundle.mode === 'experiment' ? {
      candidateId: bundle.candidateId,
      candidateGeneration: bundle.candidateGeneration,
      candidateContentHash: bundle.candidateContentHash,
      experimentId: bundle.experimentId,
      experimentSplit: bundle.experimentSplit,
      validationSpecId: bundle.validationSpecId,
    } : {}),
  };
  const label = bundle.mode === 'experiment'
    ? '候选规划经验 · 已授权实验，不代表可信结论'
    : '可信规划经验 · 只用于规划，不覆盖世界观察或执行判据';
  return `[${label} · ${goalText}]\n${JSON.stringify(payload).slice(0, 6000)}`;
}

function coldStartManifest(
  request: ExperienceFreezeRequest,
  contextSignatureHash: string,
  rejected: ExperienceSelectionManifest['rejected'],
): ExperienceSelectionManifest {
  const base = {
    planRunId: request.planRunId,
    query: { goalSignature: request.goalSignature.key, contextSignatureHash },
    selected: [],
    rejected: structuredClone(rejected),
  };
  return Object.freeze({ id: `manifest:${hash(JSON.stringify(base)).slice(0, 24)}`, ...base });
}

function emptyContext(): ContextSignature {
  return {
    inventory: {}, capabilities: ['goal_queue', 'goal_agent', 'atomic_registry'],
    nearbyFacilities: [], nearbyResources: [], timeBucket: 'unknown',
    dangerLevel: 0, positionRegion: 'unknown', worldRevision: 'unknown',
  };
}
function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }

function validateAuthorization(value: ExperimentAuthorizationV1): 'authorization_incomplete' | null {
  if (value?.schema !== 'mineclaw.planner-experiment-authorization/v1'
    || !value.experimentId?.trim() || !value.candidateId?.trim()
    || !Number.isInteger(value.candidateGeneration) || value.candidateGeneration < 1
    || !value.candidateContentHash?.trim()
    || !value.validationSpec?.id?.trim() || !value.validationSpec.validatorId?.trim()
    || !['selection', 'hidden'].includes(value.split)
    || value.budget?.authorized !== true || !value.budget.authorizationId?.trim()
    || !Number.isInteger(value.budget.maxPlanRuns) || value.budget.maxPlanRuns < 1
    || !Number.isInteger(value.budget.maxEstimatedActions) || value.budget.maxEstimatedActions < 1) {
    return 'authorization_incomplete';
  }
  return null;
}
function candidatePolicy(candidate: ExperienceCandidate): PlannerPolicyRecord {
  const now = new Date().toISOString();
  const identity = candidateIdentity(candidate);
  const scope = candidate.content.applicability.find(value => value && typeof value === 'object' && !Array.isArray(value)) as Record<string, unknown> | undefined;
  return {
    id: candidate.id, version: identity.generation, revision: identity.generation, state: 'trusted', content: structuredClone(candidate.content),
    evidenceIds: boundedEvidenceRefs(candidate.evidenceIds, CANDIDATE_EVIDENCE_REF_LIMIT), sourceCandidateId:candidate.id, taskFamily:candidate.taskFamily,
    goalPattern:candidate.goalPattern,
    ...(typeof scope?.goalSignature==='string'?{goalSignature:scope.goalSignature}:{}),
    confidenceLowerBound: Math.max(.55, candidate.confidenceLowerBound),
    createdAt: now, updatedAt: now,
  };
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
