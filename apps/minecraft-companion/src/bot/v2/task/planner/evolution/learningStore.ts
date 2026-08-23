import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { openSqliteDatabase, type SqliteDatabase } from '../../../infra/sqliteDatabase.js';
import { boundedEvidenceRefs, CANDIDATE_EVIDENCE_REF_LIMIT } from '../evidenceRefBudget.js';
import type { ExperienceCandidate, ValidationSpec } from './plannerOptimizer.js';
import type { GateDecision, PolicyMetrics } from './evalGate.js';
import { candidateIdentity, withCandidateIdentity } from './candidateIdentity.js';

export type DatasetSplit = 'online' | 'train' | 'selection' | 'hidden';

export interface PolicyEvaluationRecord {
  id: string;
  policyId: string;
  baselinePolicyId?: string;
  split: DatasetSplit;
  metrics: PolicyMetrics;
  decision?: GateDecision;
  episodeIds: string[];
  createdAt: string;
}

export interface LearningCurvePoint {
  id: number;
  policyId: string;
  policyVersion: number;
  split: DatasetSplit;
  metrics: PolicyMetrics;
  episodeIds: string[];
  valid: boolean;
  createdAt: string;
}

export interface ResearchAgendaRecord {
  candidateId: string;
  status: 'queued' | 'running' | 'inconclusive' | 'backlog' | 'closed';
  expectedInformationGain: number;
  uncertainty: number;
  impactScope: number;
  estimatedCost: number;
  safetyRisk: number;
  headroom: number;
  retryBudget: number;
  validationSpec?: ValidationSpec;
  reason?: string;
  updatedAt: string;
}

export interface CandidateValidationRun {
  candidateId: string;
  candidateGeneration: number;
  candidateContentHash: string;
  candidateEvidenceCutoffAt: string;
  baselineEpisodeIds: string[];
  baselineCutoffOccurredAt: string;
  selectionEpisodeIds: string[];
  hiddenEpisodeIds: string[];
  consumedTrialEpisodeIds: string[];
  attempt: number;
  status: 'collecting' | 'evaluating' | 'promoted' | 'rejected' | 'blacklisted';
  createdAt: string;
  updatedAt: string;
}

export type CandidateExperimentAllocationState = 'allocated' | 'finalized' | 'abandoned';

export interface CandidateExperimentAllocation {
  planRunId: string;
  candidateId: string;
  candidateGeneration: number;
  candidateContentHash: string;
  experimentId: string;
  authorizationId: string;
  split: 'selection' | 'hidden';
  contextSignatureHash: string;
  maxEstimatedActions: number;
  state: CandidateExperimentAllocationState;
  createdAt: string;
  updatedAt: string;
}

interface CandidateRow { id:string; lineage_id:string|null; generation:number|null; content_hash:string|null; evolved_from_candidate_id:string|null; task_family:string; goal_pattern:string; content_json:string; evidence_json:string; positive_json:string; negative_json:string; confidence_lower_bound:number; status:ExperienceCandidate['status']; validation_json:string|null; created_at:string; updated_at:string }
interface EvaluationRow { id:string; policy_id:string; baseline_policy_id:string|null; split:DatasetSplit; metrics_json:string; decision_json:string|null; episode_json:string; created_at:string }
interface CurveRow { id:number; policy_id:string; policy_version:number; split:DatasetSplit; metrics_json:string; episode_json:string; valid:number; created_at:string }
interface AgendaRow { candidate_id:string; status:ResearchAgendaRecord['status']; expected_information_gain:number; uncertainty:number; impact_scope:number; estimated_cost:number; safety_risk:number; headroom:number; retry_budget:number; validation_json:string|null; reason:string|null; updated_at:string }
interface ValidationRunRow { candidate_id:string; candidate_generation:number|null; candidate_content_hash:string|null; candidate_evidence_cutoff_at:string|null; baseline_json:string; baseline_cutoff_at:string|null; selection_json:string; hidden_json:string; consumed_json:string|null; attempt:number; status:CandidateValidationRun['status']; created_at:string|null; updated_at:string }
interface ExperimentAllocationRow { plan_run_id:string; candidate_id:string; candidate_generation:number|null; candidate_content_hash:string|null; experiment_id:string; authorization_id:string; split:CandidateExperimentAllocation['split']; context_signature_hash:string; max_estimated_actions:number; state:CandidateExperimentAllocationState; created_at:string; updated_at:string }

export class PlannerLearningStore {
  private readonly db: SqliteDatabase;

  constructor(dbPath = 'data/planner-evolution.db') {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.db = openSqliteDatabase(dbPath);
    this.db.pragma('busy_timeout = 5000');
    if (dbPath !== ':memory:') this.db.pragma('journal_mode = WAL');
    this.initSchema();
  }

  upsertCandidate(candidate: ExperienceCandidate): ExperienceCandidate {
    const normalized = withCandidateIdentity({
      ...candidate,
      evidenceIds: boundedEvidenceRefs(candidate.evidenceIds, CANDIDATE_EVIDENCE_REF_LIMIT),
    });
    const existing = this.getCandidate(normalized.id);
    // Once a validation run exists, this candidate generation is immutable.
    // New production evidence must become a successor generation instead of
    // silently changing the treatment under an active/finished experiment.
    if (existing) {
      const validation = this.getValidationRun(existing.id);
      const allocated = this.listExperimentAllocations(existing.id).some(value => value.state !== 'abandoned');
      if (validation && (validation.status !== 'collecting' || allocated || existing.evolvedFromCandidateId)) return existing;
    }
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO experience_candidates
      (id, lineage_id, generation, content_hash, evolved_from_candidate_id, task_family, goal_pattern, content_json, evidence_json, positive_json, negative_json, confidence_lower_bound, status, validation_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET lineage_id=excluded.lineage_id, generation=excluded.generation,
        content_hash=excluded.content_hash, evolved_from_candidate_id=excluded.evolved_from_candidate_id,
        content_json=excluded.content_json, evidence_json=excluded.evidence_json,
        positive_json=excluded.positive_json, negative_json=excluded.negative_json,
        confidence_lower_bound=excluded.confidence_lower_bound, status=excluded.status,
        validation_json=excluded.validation_json, updated_at=excluded.updated_at`).run(
      normalized.id, normalized.lineageId, normalized.generation, normalized.contentHash,
      normalized.evolvedFromCandidateId ?? null, normalized.taskFamily, normalized.goalPattern,
      JSON.stringify(normalized.content), JSON.stringify(normalized.evidenceIds), JSON.stringify(normalized.positiveEpisodeIds),
      JSON.stringify(normalized.negativeEpisodeIds), normalized.confidenceLowerBound, normalized.status,
      normalized.validationSpec ? JSON.stringify(normalized.validationSpec) : null, now, now,
    );
    return this.getCandidate(normalized.id) ?? normalized;
  }

  /**
   * Registers one semantic proposal without mutating an evaluated generation.
   * The first generation keeps the canonical legacy ID; successors receive a
   * deterministic :gN suffix and only use fresh evidence not already owned by
   * an earlier generation. Production Optimizer and the post-settlement
   * Selection reflector are the only callers allowed to propose successors.
   */
  registerCandidateProposal(proposal: ExperienceCandidate): ExperienceCandidate {
    // A proposal may be derived from a persisted generation and therefore
    // carry its old hash. Recompute from the proposed treatment content; only
    // persisted/evaluating generations are allowed to trust a stored hash.
    const normalized = withCandidateIdentity({
      ...proposal,
      contentHash: undefined,
      lineageId: proposal.lineageId ?? proposal.id,
    });
    const lineage = this.listCandidatesForLineage(normalized.lineageId!);
    const latest = lineage.at(-1);
    if (!latest) return this.upsertCandidate(normalized);

    const validation = this.getValidationRun(latest.id);
    if (latest.evolvedFromCandidateId) return latest;
    if (!validation || validation.status === 'collecting') {
      const allocated = this.listExperimentAllocations(latest.id).some(value => value.state !== 'abandoned');
      return allocated ? latest : this.upsertCandidate({ ...normalized, id: latest.id, generation: latest.generation ?? 1 });
    }

    const nextHash = candidateIdentity(normalized).contentHash;
    if (nextHash === candidateIdentity(latest).contentHash) return latest;
    const oldPositive = new Set(lineage.flatMap(candidate => candidate.positiveEpisodeIds));
    const oldNegative = new Set(lineage.flatMap(candidate => candidate.negativeEpisodeIds));
    const positiveEpisodeIds = normalized.positiveEpisodeIds.filter(id => !oldPositive.has(id));
    const negativeEpisodeIds = normalized.negativeEpisodeIds.filter(id => !oldNegative.has(id));
    if (positiveEpisodeIds.length + negativeEpisodeIds.length === 0) return latest;

    const generation = (latest.generation ?? 1) + 1;
    return this.upsertCandidate({
      ...normalized,
      id: `${normalized.lineageId}:g${generation}`,
      generation,
      evolvedFromCandidateId: latest.id,
      positiveEpisodeIds,
      negativeEpisodeIds,
    });
  }

  getCandidate(id: string): ExperienceCandidate | null {
    const row = this.db.prepare('SELECT * FROM experience_candidates WHERE id = ?').get(id) as CandidateRow | undefined;
    return row ? toCandidate(row) : null;
  }

  listCandidates(): ExperienceCandidate[] {
    return (this.db.prepare('SELECT * FROM experience_candidates ORDER BY updated_at DESC').all() as CandidateRow[]).map(toCandidate);
  }

  listCandidatesForLineage(lineageId: string): ExperienceCandidate[] {
    return (this.db.prepare(`
      SELECT * FROM experience_candidates
      WHERE COALESCE(lineage_id, id) = ?
      ORDER BY COALESCE(generation, 1), created_at, id
    `).all(lineageId) as CandidateRow[]).map(toCandidate);
  }

  retireSupersededCandidates(activeCandidateIds: string[]): string[] {
    const active = new Set(activeCandidateIds);
    const retired = (this.db.prepare("SELECT id, COALESCE(lineage_id, id) AS lineage_id FROM experience_candidates WHERE status = 'candidate'").all() as Array<{ id: string; lineage_id:string }>)
      .filter(row => !active.has(row.lineage_id))
      .map(row => row.id);
    return this.retireCandidates(retired, 'candidate_superseded_by_canonicalization');
  }

  retireCandidates(candidateIds: string[], reason: string): string[] {
    const ids = [...new Set(candidateIds)];
    if (ids.length === 0) return [];
    const active = new Set((this.db.prepare("SELECT id FROM experience_candidates WHERE status = 'candidate'").all() as Array<{ id:string }>).map(row => row.id));
    const retired = ids.filter(id => active.has(id));
    if (retired.length === 0) return [];

    const now = new Date().toISOString();
    const retireCandidate = this.db.prepare("UPDATE experience_candidates SET status = 'backlog', updated_at = ? WHERE id = ? AND status = 'candidate'");
    const closeAgenda = this.db.prepare("UPDATE research_agenda SET status = 'closed', reason = ?, updated_at = ? WHERE candidate_id = ?");
    this.db.transaction(() => {
      for (const id of retired) {
        retireCandidate.run(now, id);
        closeAgenda.run(reason, now, id);
      }
    })();
    return retired;
  }

  addEvaluation(record: Omit<PolicyEvaluationRecord, 'createdAt'>): PolicyEvaluationRecord {
    const createdAt = new Date().toISOString();
    this.db.prepare(`INSERT OR REPLACE INTO policy_evaluations
      (id, policy_id, baseline_policy_id, split, metrics_json, decision_json, episode_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      record.id, record.policyId, record.baselinePolicyId ?? null, record.split,
      JSON.stringify(record.metrics), record.decision ? JSON.stringify(record.decision) : null,
      JSON.stringify(record.episodeIds), createdAt,
    );
    return { ...record, createdAt };
  }

  listEvaluations(policyId?: string): PolicyEvaluationRecord[] {
    const rows = policyId
      ? this.db.prepare('SELECT * FROM policy_evaluations WHERE policy_id = ? ORDER BY created_at').all(policyId) as EvaluationRow[]
      : this.db.prepare('SELECT * FROM policy_evaluations ORDER BY created_at').all() as EvaluationRow[];
    return rows.map(toEvaluation);
  }

  addCurvePoint(input: Omit<LearningCurvePoint, 'id' | 'createdAt'>): LearningCurvePoint {
    const createdAt = new Date().toISOString();
    const result = this.db.prepare(`INSERT INTO learning_curve_points
      (policy_id, policy_version, split, metrics_json, episode_json, valid, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(input.policyId, input.policyVersion, input.split,
      JSON.stringify(input.metrics), JSON.stringify(input.episodeIds), input.valid ? 1 : 0, createdAt);
    return { ...input, id: Number(result.lastInsertRowid), createdAt };
  }

  listCurvePoints(policyId?: string): LearningCurvePoint[] {
    const rows = policyId
      ? this.db.prepare('SELECT * FROM learning_curve_points WHERE policy_id = ? ORDER BY created_at, id').all(policyId) as CurveRow[]
      : this.db.prepare('SELECT * FROM learning_curve_points ORDER BY created_at, id').all() as CurveRow[];
    return rows.map(row => ({ id:row.id, policyId:row.policy_id, policyVersion:row.policy_version, split:row.split, metrics:JSON.parse(row.metrics_json) as PolicyMetrics, episodeIds:JSON.parse(row.episode_json) as string[], valid:row.valid === 1, createdAt:row.created_at }));
  }

  upsertAgenda(item: Omit<ResearchAgendaRecord, 'updatedAt'>): ResearchAgendaRecord {
    const updatedAt = new Date().toISOString();
    this.db.prepare(`INSERT INTO research_agenda
      (candidate_id, status, expected_information_gain, uncertainty, impact_scope, estimated_cost, safety_risk, headroom, retry_budget, validation_json, reason, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(candidate_id) DO UPDATE SET status=excluded.status, expected_information_gain=excluded.expected_information_gain,
        uncertainty=excluded.uncertainty, impact_scope=excluded.impact_scope, estimated_cost=excluded.estimated_cost,
        safety_risk=excluded.safety_risk, headroom=excluded.headroom, retry_budget=excluded.retry_budget,
        validation_json=excluded.validation_json, reason=excluded.reason, updated_at=excluded.updated_at`).run(
      item.candidateId, item.status, item.expectedInformationGain, item.uncertainty, item.impactScope,
      item.estimatedCost, item.safetyRisk, item.headroom, item.retryBudget,
      item.validationSpec ? JSON.stringify(item.validationSpec) : null, item.reason ?? null, updatedAt,
    );
    return { ...item, updatedAt };
  }

  listAgenda(): ResearchAgendaRecord[] {
    return (this.db.prepare('SELECT * FROM research_agenda').all() as AgendaRow[]).map(toAgenda);
  }

  getValidationRun(candidateId: string): CandidateValidationRun | null {
    const row = this.db.prepare('SELECT * FROM candidate_validation_runs WHERE candidate_id = ?').get(candidateId) as ValidationRunRow | undefined;
    return row ? toValidationRun(row) : null;
  }

  listValidationRuns(): CandidateValidationRun[] {
    return (this.db.prepare('SELECT * FROM candidate_validation_runs ORDER BY updated_at').all() as ValidationRunRow[]).map(toValidationRun);
  }

  upsertValidationRun(input: Omit<CandidateValidationRun, 'updatedAt' | 'createdAt' | 'candidateGeneration' | 'candidateContentHash' | 'candidateEvidenceCutoffAt'> & Partial<Pick<CandidateValidationRun, 'candidateGeneration' | 'candidateContentHash' | 'candidateEvidenceCutoffAt'>> & { createdAt?: string }): CandidateValidationRun {
    const updatedAt = new Date().toISOString();
    const createdAt = input.createdAt ?? updatedAt;
    const candidate = this.getCandidate(input.candidateId);
    if (!candidate) throw new Error(`candidate not found for validation: ${input.candidateId}`);
    const identity = candidateIdentity(candidate);
    const candidateGeneration = input.candidateGeneration ?? identity.generation;
    const candidateContentHash = input.candidateContentHash ?? identity.contentHash;
    const candidateEvidenceCutoffAt = input.candidateEvidenceCutoffAt ?? input.baselineCutoffOccurredAt ?? createdAt;
    const existing = this.getValidationRun(input.candidateId);
    if (existing && (existing.candidateGeneration !== candidateGeneration || existing.candidateContentHash !== candidateContentHash)) {
      const allocated = this.listExperimentAllocations(input.candidateId).some(value => value.state !== 'abandoned');
      if (existing.status !== 'collecting' || allocated) {
        throw new Error(`candidate snapshot mismatch for validation: ${input.candidateId}`);
      }
    }
    this.db.prepare(`INSERT INTO candidate_validation_runs
      (candidate_id, candidate_generation, candidate_content_hash, candidate_evidence_cutoff_at, baseline_json, baseline_cutoff_at, selection_json, hidden_json, consumed_json, attempt, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(candidate_id) DO UPDATE SET baseline_json=excluded.baseline_json,
        candidate_generation=excluded.candidate_generation,
        candidate_content_hash=excluded.candidate_content_hash,
        candidate_evidence_cutoff_at=excluded.candidate_evidence_cutoff_at,
        baseline_cutoff_at=excluded.baseline_cutoff_at,
        selection_json=excluded.selection_json, hidden_json=excluded.hidden_json, consumed_json=excluded.consumed_json,
        attempt=excluded.attempt, status=excluded.status, updated_at=excluded.updated_at`).run(
      input.candidateId, candidateGeneration, candidateContentHash, candidateEvidenceCutoffAt,
      JSON.stringify(input.baselineEpisodeIds), input.baselineCutoffOccurredAt,
      JSON.stringify(input.selectionEpisodeIds), JSON.stringify(input.hiddenEpisodeIds),
      JSON.stringify(input.consumedTrialEpisodeIds), input.attempt, input.status, createdAt, updatedAt,
    );
    return { ...input, candidateGeneration, candidateContentHash, candidateEvidenceCutoffAt, createdAt, updatedAt };
  }

  allocateExperiment(input: Omit<CandidateExperimentAllocation, 'createdAt' | 'updatedAt' | 'candidateGeneration' | 'candidateContentHash'> & Partial<Pick<CandidateExperimentAllocation, 'candidateGeneration' | 'candidateContentHash'>>): CandidateExperimentAllocation {
    const now = new Date().toISOString();
    const candidate = this.getCandidate(input.candidateId);
    if (!candidate) throw new Error(`candidate not found for experiment: ${input.candidateId}`);
    const identity = candidateIdentity(candidate);
    const candidateGeneration = input.candidateGeneration ?? identity.generation;
    const candidateContentHash = input.candidateContentHash ?? identity.contentHash;
    this.db.prepare(`INSERT INTO candidate_experiment_allocations
      (plan_run_id, candidate_id, candidate_generation, candidate_content_hash, experiment_id, authorization_id, split, context_signature_hash, max_estimated_actions, state, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(plan_run_id) DO NOTHING`).run(
      input.planRunId, input.candidateId, candidateGeneration, candidateContentHash, input.experimentId, input.authorizationId,
      input.split, input.contextSignatureHash, input.maxEstimatedActions, input.state, now, now,
    );
    return this.getExperimentAllocation(input.planRunId) ?? { ...input, candidateGeneration, candidateContentHash, createdAt: now, updatedAt: now };
  }

  getExperimentAllocation(planRunId: string): CandidateExperimentAllocation | null {
    const row = this.db.prepare('SELECT * FROM candidate_experiment_allocations WHERE plan_run_id = ?').get(planRunId) as ExperimentAllocationRow | undefined;
    return row ? toExperimentAllocation(row) : null;
  }

  listExperimentAllocations(candidateId?: string): CandidateExperimentAllocation[] {
    const rows = candidateId
      ? this.db.prepare('SELECT * FROM candidate_experiment_allocations WHERE candidate_id = ? ORDER BY created_at, plan_run_id').all(candidateId)
      : this.db.prepare('SELECT * FROM candidate_experiment_allocations ORDER BY created_at, plan_run_id').all();
    return (rows as ExperimentAllocationRow[]).map(toExperimentAllocation);
  }

  updateExperimentAllocationState(planRunId: string, state: CandidateExperimentAllocationState): CandidateExperimentAllocation | null {
    this.db.prepare('UPDATE candidate_experiment_allocations SET state = ?, updated_at = ? WHERE plan_run_id = ?')
      .run(state, new Date().toISOString(), planRunId);
    return this.getExperimentAllocation(planRunId);
  }

  markProjected(sessionId: string): void {
    this.db.prepare('INSERT OR IGNORE INTO planner_episode_projections (session_id, projected_at) VALUES (?, ?)').run(sessionId, new Date().toISOString());
  }
  isProjected(sessionId: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 AS ok FROM planner_episode_projections WHERE session_id = ?').get(sessionId));
  }
  close(): void { this.db.close(); }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS experience_candidates (id TEXT PRIMARY KEY, lineage_id TEXT, generation INTEGER, content_hash TEXT, evolved_from_candidate_id TEXT, task_family TEXT NOT NULL, goal_pattern TEXT NOT NULL, content_json TEXT NOT NULL, evidence_json TEXT NOT NULL, positive_json TEXT NOT NULL, negative_json TEXT NOT NULL, confidence_lower_bound REAL NOT NULL, status TEXT NOT NULL, validation_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS policy_evaluations (id TEXT PRIMARY KEY, policy_id TEXT NOT NULL, baseline_policy_id TEXT, split TEXT NOT NULL, metrics_json TEXT NOT NULL, decision_json TEXT, episode_json TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS learning_curve_points (id INTEGER PRIMARY KEY AUTOINCREMENT, policy_id TEXT NOT NULL, policy_version INTEGER NOT NULL, split TEXT NOT NULL, metrics_json TEXT NOT NULL, episode_json TEXT NOT NULL, valid INTEGER NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS research_agenda (candidate_id TEXT PRIMARY KEY, status TEXT NOT NULL, expected_information_gain REAL NOT NULL, uncertainty REAL NOT NULL, impact_scope REAL NOT NULL, estimated_cost REAL NOT NULL, safety_risk REAL NOT NULL, headroom REAL NOT NULL, retry_budget INTEGER NOT NULL, validation_json TEXT, reason TEXT, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS planner_episode_projections (session_id TEXT PRIMARY KEY, projected_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS candidate_validation_runs (
        candidate_id TEXT PRIMARY KEY,
        candidate_generation INTEGER,
        candidate_content_hash TEXT,
        candidate_evidence_cutoff_at TEXT,
        baseline_json TEXT NOT NULL,
        baseline_cutoff_at TEXT,
        selection_json TEXT NOT NULL,
        hidden_json TEXT NOT NULL,
        consumed_json TEXT,
        attempt INTEGER NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS candidate_experiment_allocations (
        plan_run_id TEXT PRIMARY KEY,
        candidate_id TEXT NOT NULL,
        candidate_generation INTEGER,
        candidate_content_hash TEXT,
        experiment_id TEXT NOT NULL,
        authorization_id TEXT NOT NULL,
        split TEXT NOT NULL CHECK (split IN ('selection', 'hidden')),
        context_signature_hash TEXT NOT NULL,
        max_estimated_actions INTEGER NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('allocated', 'finalized', 'abandoned')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_candidate_experiment_allocations_candidate
        ON candidate_experiment_allocations(candidate_id, split, state, created_at);
    `);
    const candidateColumns = this.db.prepare('PRAGMA table_info(experience_candidates)').all() as Array<{ name: string }>;
    for (const [name, sql] of [
      ['lineage_id', 'ALTER TABLE experience_candidates ADD COLUMN lineage_id TEXT'],
      ['generation', 'ALTER TABLE experience_candidates ADD COLUMN generation INTEGER'],
      ['content_hash', 'ALTER TABLE experience_candidates ADD COLUMN content_hash TEXT'],
      ['evolved_from_candidate_id', 'ALTER TABLE experience_candidates ADD COLUMN evolved_from_candidate_id TEXT'],
    ] as const) if (!candidateColumns.some(column => column.name === name)) this.db.exec(sql);
    const validationColumns = this.db.prepare('PRAGMA table_info(candidate_validation_runs)').all() as Array<{ name: string }>;
    if (!validationColumns.some(column => column.name === 'baseline_cutoff_at')) {
      this.db.exec('ALTER TABLE candidate_validation_runs ADD COLUMN baseline_cutoff_at TEXT');
    }
    if (!validationColumns.some(column => column.name === 'created_at')) {
      this.db.exec('ALTER TABLE candidate_validation_runs ADD COLUMN created_at TEXT');
    }
    if (!validationColumns.some(column => column.name === 'consumed_json')) {
      this.db.exec("ALTER TABLE candidate_validation_runs ADD COLUMN consumed_json TEXT DEFAULT '[]'");
    }
    if (!validationColumns.some(column => column.name === 'candidate_generation')) {
      this.db.exec('ALTER TABLE candidate_validation_runs ADD COLUMN candidate_generation INTEGER');
    }
    if (!validationColumns.some(column => column.name === 'candidate_content_hash')) {
      this.db.exec('ALTER TABLE candidate_validation_runs ADD COLUMN candidate_content_hash TEXT');
    }
    if (!validationColumns.some(column => column.name === 'candidate_evidence_cutoff_at')) {
      this.db.exec('ALTER TABLE candidate_validation_runs ADD COLUMN candidate_evidence_cutoff_at TEXT');
    }
    const allocationColumns = this.db.prepare('PRAGMA table_info(candidate_experiment_allocations)').all() as Array<{ name: string }>;
    if (!allocationColumns.some(column => column.name === 'candidate_generation')) {
      this.db.exec('ALTER TABLE candidate_experiment_allocations ADD COLUMN candidate_generation INTEGER');
    }
    if (!allocationColumns.some(column => column.name === 'candidate_content_hash')) {
      this.db.exec('ALTER TABLE candidate_experiment_allocations ADD COLUMN candidate_content_hash TEXT');
    }
    this.db.exec('UPDATE candidate_validation_runs SET created_at = updated_at WHERE created_at IS NULL');
    // Backfill legacy candidates before validation/allocation rows reference
    // their immutable identity. Hashes are derived in application code to use
    // the exact same canonical serialization as new candidates.
    const legacyCandidates = this.db.prepare('SELECT * FROM experience_candidates').all() as CandidateRow[];
    const updateCandidate = this.db.prepare('UPDATE experience_candidates SET lineage_id = ?, generation = ?, content_hash = ? WHERE id = ?');
    for (const row of legacyCandidates) {
      const candidate = toCandidate(row);
      const identity = candidateIdentity(candidate);
      if (!row.lineage_id || !row.generation || !row.content_hash) {
        updateCandidate.run(identity.lineageId, identity.generation, identity.contentHash, row.id);
      }
    }
    this.db.exec(`
      UPDATE candidate_validation_runs
      SET candidate_generation = COALESCE(candidate_generation, (SELECT generation FROM experience_candidates WHERE id = candidate_id), 1),
          candidate_content_hash = COALESCE(NULLIF(candidate_content_hash, ''), (SELECT content_hash FROM experience_candidates WHERE id = candidate_id), ''),
          candidate_evidence_cutoff_at = COALESCE(candidate_evidence_cutoff_at, baseline_cutoff_at, created_at, updated_at);
      UPDATE candidate_experiment_allocations
      SET candidate_generation = COALESCE(candidate_generation, (SELECT generation FROM experience_candidates WHERE id = candidate_id), 1),
          candidate_content_hash = COALESCE(NULLIF(candidate_content_hash, ''), (SELECT content_hash FROM experience_candidates WHERE id = candidate_id), '');
    `);
  }
}

function toCandidate(row: CandidateRow): ExperienceCandidate {
  const base: ExperienceCandidate = { id:row.id, taskFamily:row.task_family, goalPattern:row.goal_pattern, content:JSON.parse(row.content_json), evidenceIds:boundedEvidenceRefs(JSON.parse(row.evidence_json), CANDIDATE_EVIDENCE_REF_LIMIT), positiveEpisodeIds:JSON.parse(row.positive_json), negativeEpisodeIds:JSON.parse(row.negative_json), confidenceLowerBound:row.confidence_lower_bound, status:row.status, ...(row.validation_json ? {validationSpec:JSON.parse(row.validation_json)} : {}) };
  return withCandidateIdentity({
    ...base,
    ...(row.lineage_id ? { lineageId: row.lineage_id } : {}),
    ...(row.generation ? { generation: row.generation } : {}),
    ...(row.content_hash ? { contentHash: row.content_hash } : {}),
    ...(row.evolved_from_candidate_id ? { evolvedFromCandidateId: row.evolved_from_candidate_id } : {}),
  });
}
function toEvaluation(row: EvaluationRow): PolicyEvaluationRecord { return { id:row.id, policyId:row.policy_id, ...(row.baseline_policy_id ? {baselinePolicyId:row.baseline_policy_id}:{}), split:row.split, metrics:JSON.parse(row.metrics_json), ...(row.decision_json ? {decision:JSON.parse(row.decision_json)}:{}), episodeIds:JSON.parse(row.episode_json), createdAt:row.created_at }; }
function toAgenda(row: AgendaRow): ResearchAgendaRecord { return { candidateId:row.candidate_id, status:row.status, expectedInformationGain:row.expected_information_gain, uncertainty:row.uncertainty, impactScope:row.impact_scope, estimatedCost:row.estimated_cost, safetyRisk:row.safety_risk, headroom:row.headroom, retryBudget:row.retry_budget, ...(row.validation_json ? {validationSpec:JSON.parse(row.validation_json)}:{}), ...(row.reason ? {reason:row.reason}:{}), updatedAt:row.updated_at }; }
function toValidationRun(row: ValidationRunRow): CandidateValidationRun { return { candidateId:row.candidate_id, candidateGeneration:row.candidate_generation ?? 1, candidateContentHash:row.candidate_content_hash ?? '', candidateEvidenceCutoffAt:row.candidate_evidence_cutoff_at ?? row.baseline_cutoff_at ?? row.created_at ?? row.updated_at, baselineEpisodeIds:JSON.parse(row.baseline_json), baselineCutoffOccurredAt:row.baseline_cutoff_at ?? '', selectionEpisodeIds:JSON.parse(row.selection_json), hiddenEpisodeIds:JSON.parse(row.hidden_json), consumedTrialEpisodeIds:JSON.parse(row.consumed_json ?? '[]'), attempt:row.attempt, status:row.status, createdAt:row.created_at ?? row.updated_at, updatedAt:row.updated_at }; }
function toExperimentAllocation(row: ExperimentAllocationRow): CandidateExperimentAllocation { return { planRunId:row.plan_run_id, candidateId:row.candidate_id, candidateGeneration:row.candidate_generation ?? 1, candidateContentHash:row.candidate_content_hash ?? '', experimentId:row.experiment_id, authorizationId:row.authorization_id, split:row.split, contextSignatureHash:row.context_signature_hash, maxEstimatedActions:row.max_estimated_actions, state:row.state, createdAt:row.created_at, updatedAt:row.updated_at }; }
