import { createHash } from 'node:crypto';
import type { PlannerPolicyRecord } from '../evolution/policyStore.js';
import type { GraphRetrievalResult, RetrievedPolicyCandidate } from './graphRetriever.js';
import type { ExperienceFreezeRequest, ExperienceSelectionEntry, ExperienceSelectionManifest } from './experienceContracts.js';
import {
  boundedEvidenceRefs,
  BUNDLE_EVIDENCE_REF_LIMIT,
  MANIFEST_ENTRY_EVIDENCE_REF_LIMIT,
} from '../evidenceRefBudget.js';

export interface ExperienceBundleBudget {
  taskSchemas: number;
  planFragments: number;
  recoveryPatterns: number;
  metaPolicies: number;
}

export interface CompiledPlannerExperienceBundle {
  bundleId: string;
  mode: 'production' | 'experiment';
  policySnapshotId: string;
  policyIds: readonly string[];
  policyId: string;
  policyVersion: number;
  policyRevision: number;
  taskSchemas: readonly unknown[];
  planFragments: readonly unknown[];
  planRecoveryPatterns: readonly unknown[];
  metaPolicies: readonly unknown[];
  applicability: readonly unknown[];
  evidenceRefs: readonly string[];
  confidenceLowerBound: number;
  selectionManifest: ExperienceSelectionManifest;
  selectionManifestId: string;
  frozenAt: string;
  contentHash: string;
}

const DEFAULT_BUDGET: ExperienceBundleBudget = { taskSchemas: 1, planFragments: 3, recoveryPatterns: 2, metaPolicies: 1 };

export class ExperienceBundleCompiler {
  constructor(private readonly budget: ExperienceBundleBudget = DEFAULT_BUDGET) {}

  compile(request: ExperienceFreezeRequest, retrieval: GraphRetrievalResult): CompiledPlannerExperienceBundle | null {
    if (retrieval.candidates.length === 0) return null;
    const rejected = [...retrieval.rejected];
    const selected: ExperienceSelectionEntry[] = [];
    const taskSchemas = pickItems('task_schema', 'taskSchemas', retrieval.candidates, this.budget.taskSchemas, selected, rejected);
    const planFragments = pickItems('plan_fragment', 'planFragments', retrieval.candidates, this.budget.planFragments, selected, rejected);
    const planRecoveryPatterns = pickItems('recovery_pattern', 'planRecoveryPatterns', retrieval.candidates, this.budget.recoveryPatterns, selected, rejected);
    const metaPolicies = pickItems('meta_policy', 'metaPolicies', retrieval.candidates, this.budget.metaPolicies, selected, rejected);
    if (selected.length === 0) return null;
    const policies = uniquePolicies(retrieval.candidates, selected);
    const policySnapshotId = policies.length === 1
      ? `${policies[0].id}@${policies[0].revision}`
      : `snapshot:${hash(policies.map(policy => `${policy.id}@${policy.revision}`).join('|')).slice(0, 24)}`;
    const manifestBase = {
      planRunId: request.planRunId,
      query: { goalSignature: request.goalSignature.key, contextSignatureHash: retrieval.contextSignatureHash },
      selected,
      rejected,
    };
    const selectionManifestId = `manifest:${hash(stableStringify(manifestBase)).slice(0, 24)}`;
    const selectionManifest: ExperienceSelectionManifest = { id: selectionManifestId, ...manifestBase };
    const evidenceRefs = boundedEvidenceRefs(
      selected.flatMap(entry => entry.evidenceRefs),
      BUNDLE_EVIDENCE_REF_LIMIT,
    );
    const content = {
      mode: request.mode ?? 'production', policySnapshotId,
      policyIds: policies.map(policy => policy.id), taskSchemas, planFragments,
      planRecoveryPatterns, metaPolicies, evidenceRefs, selectionManifest,
    };
    const contentHash = hash(stableStringify(content));
    const primary = policies[0];
    return deepFreeze({
      bundleId: `bundle:${hash(`${request.planRunId}|${contentHash}`).slice(0, 24)}`,
      mode: request.mode ?? 'production', policySnapshotId,
      policyIds: policies.map(policy => policy.id),
      policyId: primary.id, policyVersion: primary.version, policyRevision: primary.revision,
      taskSchemas, planFragments, planRecoveryPatterns, metaPolicies,
      applicability: policies.flatMap(policy => structuredClone(policy.content.applicability)),
      evidenceRefs, confidenceLowerBound: Math.min(...policies.map(policy => policy.confidenceLowerBound)),
      selectionManifest, selectionManifestId, frozenAt: new Date().toISOString(), contentHash,
    });
  }
}

function pickItems(
  type: ExperienceSelectionEntry['type'], key: keyof PlannerPolicyRecord['content'],
  candidates: RetrievedPolicyCandidate[], limit: number, selected: ExperienceSelectionEntry[],
  rejected: ExperienceSelectionManifest['rejected'],
): unknown[] {
  const ranked = candidates.flatMap(candidate => candidate.policy.content[key].map((value, index) => ({ candidate, value, index })));
  const picked = ranked.slice(0, limit);
  for (const item of picked) {
    selected.push({
      experienceId: itemId(item.value, item.candidate.policy.id, type, item.index),
      policyId: item.candidate.policy.id, type,
      score: Number(item.candidate.score.toFixed(6)), reasons: [...item.candidate.reasons],
      evidenceRefs: boundedEvidenceRefs(
        item.candidate.policy.evidenceIds,
        MANIFEST_ENTRY_EVIDENCE_REF_LIMIT,
      ),
    });
  }
  for (const item of ranked.slice(limit)) {
    rejected.push({
      experienceId: itemId(item.value, item.candidate.policy.id, type, item.index),
      policyId: item.candidate.policy.id, reason: 'budget_trimmed',
    });
  }
  return picked.map(item => structuredClone(item.value));
}
function uniquePolicies(candidates: RetrievedPolicyCandidate[], selected: ExperienceSelectionEntry[]): PlannerPolicyRecord[] {
  const ids = new Set(selected.map(entry => entry.policyId));
  return candidates.map(candidate => candidate.policy).filter(policy => ids.has(policy.id));
}
function itemId(value: unknown, policyId: string, type: string, index: number): string {
  if (value && typeof value === 'object' && !Array.isArray(value) && typeof (value as Record<string, unknown>).id === 'string') {
    return String((value as Record<string, unknown>).id);
  }
  return `${policyId}:${type}:${index + 1}`;
}
function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
