import type { ContextSignature, GoalSignature } from '../plannerContracts.js';

export type ExperienceItemType = 'task_schema' | 'plan_fragment' | 'recovery_pattern' | 'meta_policy';

export interface ExperienceSelectionEntry {
  experienceId: string;
  policyId: string;
  type: ExperienceItemType;
  score: number;
  reasons: string[];
  evidenceRefs: string[];
}

export interface ExperienceRejectionEntry {
  experienceId: string;
  policyId: string;
  reason: 'not_trusted' | 'not_applicable' | 'expired' | 'unsafe' | 'low_confidence' | 'lower_rank' | 'budget_trimmed' | 'corrupt';
  detail?: string;
}

export interface ExperienceSelectionManifest {
  id: string;
  planRunId: string;
  query: { goalSignature: string; contextSignatureHash: string };
  selected: ExperienceSelectionEntry[];
  rejected: ExperienceRejectionEntry[];
}

export interface ExperienceFreezeRequest {
  planRunId: string;
  goalSignature: GoalSignature;
  context: ContextSignature;
  mode?: 'production' | 'experiment';
}

export interface ExperimentAuthorizationV1 {
  schema: 'mineclaw.planner-experiment-authorization/v1';
  experimentId: string;
  candidateId: string;
  candidateGeneration: number;
  candidateContentHash: string;
  validationSpec: {
    id: string;
    validatorId: string;
    primaryMetric: 'success_rate';
    minimumSelectionSamples: number;
    minimumHiddenSamples: number;
    pairing: 'snapshot_pair' | 'stratified_unpaired';
    treatmentField: string;
  };
  split: 'selection' | 'hidden';
  budget: { authorizationId: string; maxPlanRuns: number; maxEstimatedActions: number; authorized: true };
  contextComparable: boolean;
}

export interface ExperienceColdStart {
  status: 'cold_start';
  reason: 'no_applicable_experience' | 'low_confidence' | 'graph_corrupt';
  selectionManifest: ExperienceSelectionManifest;
}
