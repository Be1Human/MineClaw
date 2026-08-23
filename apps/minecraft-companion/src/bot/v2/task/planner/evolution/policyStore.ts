import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { openSqliteDatabase, type SqliteDatabase } from '../../../infra/sqliteDatabase.js';
import { boundedEvidenceRefs, CANDIDATE_EVIDENCE_REF_LIMIT } from '../evidenceRefBudget.js';

export type PlannerPolicyState = 'candidate' | 'trusted' | 'disabled' | 'rejected' | 'blacklisted' | 'superseded';

export interface PlannerPolicyContent {
  taskSchemas: unknown[];
  planFragments: unknown[];
  planRecoveryPatterns: unknown[];
  metaPolicies: unknown[];
  applicability: unknown[];
}

export interface PlannerPolicyRecord {
  id: string;
  version: number;
  revision: number;
  state: PlannerPolicyState;
  content: PlannerPolicyContent;
  evidenceIds: string[];
  evolvedFrom?: string;
  sourceCandidateId?: string;
  taskFamily?: string;
  goalPattern?: string;
  goalSignature?: string;
  confidenceLowerBound: number;
  createdAt: string;
  updatedAt: string;
  trustedAt?: string;
}

export interface PromotionGate {
  decision: 'promote' | 'reject';
  selectionDelta: number;
  hiddenRegression: boolean;
  safetyViolations: number;
  efficiencyImproved?: boolean;
  evaluationId: string;
}

export interface PlannerPolicyAuditRecord {
  id: number;
  policyId: string;
  action: string;
  detail: Record<string, unknown>;
  createdAt: string;
}

interface PolicyRow {
  id: string;
  version: number;
  revision: number;
  state: PlannerPolicyState;
  content_json: string;
  evidence_json: string;
  evolved_from: string | null;
  source_candidate_id: string | null;
  task_family: string | null;
  goal_pattern: string | null;
  goal_signature: string | null;
  confidence_lower_bound: number;
  created_at: string;
  updated_at: string;
  trusted_at: string | null;
}

export class PolicyConflictError extends Error {}

export class PlannerPolicyStore {
  private readonly db: SqliteDatabase;

  constructor(dbPath = 'data/planner-evolution.db') {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.db = openSqliteDatabase(dbPath);
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    if (dbPath !== ':memory:') this.db.pragma('journal_mode = WAL');
    this.initSchema();
  }

  createCandidate(input: Omit<PlannerPolicyRecord, 'revision' | 'state' | 'createdAt' | 'updatedAt' | 'trustedAt'>): PlannerPolicyRecord {
    if (!input.id || !Number.isInteger(input.version) || input.version < 1) throw new Error('policy identity is invalid');
    if (input.evidenceIds.length === 0) throw new Error('candidate policy requires evidence');
    if (input.confidenceLowerBound < 0 || input.confidenceLowerBound > 1) throw new Error('confidenceLowerBound is invalid');
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO planner_policies (
        id, version, revision, state, content_json, evidence_json, evolved_from,
        source_candidate_id, task_family, goal_pattern, goal_signature,
        confidence_lower_bound, created_at, updated_at, trusted_at
      ) VALUES (?, ?, 1, 'candidate', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    `).run(
      input.id, input.version, JSON.stringify(input.content),
      JSON.stringify(boundedEvidenceRefs(input.evidenceIds, CANDIDATE_EVIDENCE_REF_LIMIT)), input.evolvedFrom ?? null,
      input.sourceCandidateId ?? null, input.taskFamily ?? null, input.goalPattern ?? null, input.goalSignature ?? null,
      input.confidenceLowerBound, now, now,
    );
    return this.require(input.id);
  }

  promote(id: string, expectedRevision: number, gate: PromotionGate): PlannerPolicyRecord {
    return this.db.transaction(() => {
      const policy = this.requireRevision(id, expectedRevision);
      if (policy.state !== 'candidate') throw new Error(`policy ${id} is not candidate`);
      if (
        gate.decision !== 'promote'
        || (gate.selectionDelta <= 0 && gate.efficiencyImproved !== true)
        || gate.hiddenRegression
        || gate.safetyViolations !== 0
      ) {
        throw new Error('promotion gate rejected policy');
      }
      const now = new Date().toISOString();
      const slot = slotForPolicy(policy);
      const active = this.activeInSlot(slot);
      if (active) this.updateState(active.id, active.revision, 'superseded', now);
      this.updateState(id, expectedRevision, 'trusted', now, now);
      this.db.prepare(`
        INSERT INTO planner_policy_active (slot, policy_id, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(slot) DO UPDATE SET policy_id = excluded.policy_id, updated_at = excluded.updated_at
      `).run(slot, id, now);
      this.db.prepare(`
        INSERT INTO planner_policy_audit (policy_id, action, detail_json, created_at)
        VALUES (?, 'promote', ?, ?)
      `).run(id, JSON.stringify(gate), now);
      return this.require(id);
    })();
  }

  disable(id: string, expectedRevision: number, reason: string): PlannerPolicyRecord {
    if (!reason.trim()) throw new Error('disable reason is required');
    return this.db.transaction(() => {
      const policy = this.requireRevision(id, expectedRevision);
      if (!['trusted', 'superseded'].includes(policy.state)) throw new Error(`policy ${id} cannot be disabled`);
      const now = new Date().toISOString();
      this.updateState(id, expectedRevision, 'disabled', now);
      this.db.prepare('DELETE FROM planner_policy_active WHERE policy_id = ?').run(id);
      this.audit(id, 'disable', { reason }, now);
      return this.require(id);
    })();
  }

  rollback(id: string, expectedRevision: number, reason: string): PlannerPolicyRecord {
    if (!reason.trim()) throw new Error('rollback reason is required');
    return this.db.transaction(() => {
      const target = this.requireRevision(id, expectedRevision);
      if (!target.trustedAt || target.state === 'blacklisted') throw new Error('rollback target was not trusted');
      const now = new Date().toISOString();
      const slot = slotForPolicy(target);
      const active = this.activeInSlot(slot);
      if (active && active.id !== id) this.updateState(active.id, active.revision, 'superseded', now);
      this.updateState(id, expectedRevision, 'trusted', now, target.trustedAt);
      this.db.prepare(`
        INSERT INTO planner_policy_active (slot, policy_id, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(slot) DO UPDATE SET policy_id = excluded.policy_id, updated_at = excluded.updated_at
      `).run(slot, id, now);
      this.audit(id, 'rollback', { reason }, now);
      return this.require(id);
    })();
  }

  blacklist(id: string, expectedRevision: number, reason: string): PlannerPolicyRecord {
    if (!reason.trim()) throw new Error('blacklist reason is required');
    return this.db.transaction(() => {
      this.requireRevision(id, expectedRevision);
      const now = new Date().toISOString();
      this.updateState(id, expectedRevision, 'blacklisted', now);
      this.db.prepare('DELETE FROM planner_policy_active WHERE policy_id = ?').run(id);
      this.audit(id, 'blacklist', { reason }, now);
      return this.require(id);
    })();
  }

  reject(id: string, expectedRevision: number, reason: string): PlannerPolicyRecord {
    if (!reason.trim()) throw new Error('reject reason is required');
    return this.db.transaction(() => {
      const policy = this.requireRevision(id, expectedRevision);
      if (policy.state !== 'candidate') throw new Error(`policy ${id} is not candidate`);
      const now = new Date().toISOString();
      this.updateState(id, expectedRevision, 'rejected', now);
      this.audit(id, 'reject', { reason }, now);
      return this.require(id);
    })();
  }

  get(id: string): PlannerPolicyRecord | null {
    const row = this.db.prepare('SELECT * FROM planner_policies WHERE id = ?').get(id) as PolicyRow | undefined;
    return row ? toPolicy(row) : null;
  }

  active(): PlannerPolicyRecord | null {
    return this.activeInSlot('default') ?? this.listActive()[0] ?? null;
  }

  activeForTaskFamily(taskFamily: string): PlannerPolicyRecord | null {
    return this.listTrustedForTaskFamily(taskFamily)[0] ?? null;
  }

  /** 返回与候选完全相同目标作用域的可信父版本，禁止跨目标继承。 */
  activeForContent(content: PlannerPolicyContent): PlannerPolicyRecord | null {
    return this.activeInSlot(slotForContent(content));
  }

  /** Multiple trusted goal-scoped policies may coexist inside one task family. */
  listTrustedForTaskFamily(taskFamily: string): PlannerPolicyRecord[] {
    const prefix = `family:${taskFamily}`;
    return (this.db.prepare(`
      SELECT p.* FROM planner_policy_active a
      JOIN planner_policies p ON p.id = a.policy_id
      WHERE p.state = 'trusted' AND (a.slot = ? OR a.slot LIKE ? OR a.slot = 'default')
      ORDER BY CASE WHEN a.slot = 'default' THEN 1 ELSE 0 END, a.slot, p.id
    `).all(prefix, `${prefix}:%`) as PolicyRow[]).map(toPolicy);
  }

  listActive(): PlannerPolicyRecord[] {
    return (this.db.prepare(`
      SELECT p.* FROM planner_policy_active a
      JOIN planner_policies p ON p.id = a.policy_id
      WHERE p.state = 'trusted'
      ORDER BY a.slot
    `).all() as PolicyRow[]).map(toPolicy);
  }

  nextVersion(): number {
    const row = this.db.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM planner_policies').get() as { version:number };
    return row.version + 1;
  }

  /** 版本号在具体经验作用域内递增，而不是在整个 Profile 全局递增。 */
  nextVersionForContent(content: PlannerPolicyContent): number {
    const slot = slotForContent(content);
    const versions = this.list().filter(policy => slotForPolicy(policy) === slot).map(policy => policy.version);
    return Math.max(0, ...versions) + 1;
  }

  private activeInSlot(slot: string): PlannerPolicyRecord | null {
    const row = this.db.prepare(`
      SELECT p.* FROM planner_policy_active a
      JOIN planner_policies p ON p.id = a.policy_id
      WHERE a.slot = ? AND p.state = 'trusted'
    `).get(slot) as PolicyRow | undefined;
    return row ? toPolicy(row) : null;
  }

  list(): PlannerPolicyRecord[] {
    return (this.db.prepare('SELECT * FROM planner_policies ORDER BY version, created_at').all() as PolicyRow[]).map(toPolicy);
  }

  listAudit(policyId?: string): PlannerPolicyAuditRecord[] {
    const rows = policyId
      ? this.db.prepare('SELECT * FROM planner_policy_audit WHERE policy_id = ? ORDER BY id').all(policyId)
      : this.db.prepare('SELECT * FROM planner_policy_audit ORDER BY id').all();
    return (rows as Array<{ id:number; policy_id:string; action:string; detail_json:string; created_at:string }>).map(row => ({
      id: row.id,
      policyId: row.policy_id,
      action: row.action,
      detail: JSON.parse(row.detail_json) as Record<string, unknown>,
      createdAt: row.created_at,
    }));
  }

  close(): void { this.db.close(); }

  private require(id: string): PlannerPolicyRecord {
    const policy = this.get(id);
    if (!policy) throw new Error(`policy not found: ${id}`);
    return policy;
  }

  private requireRevision(id: string, expectedRevision: number): PlannerPolicyRecord {
    const policy = this.require(id);
    if (policy.revision !== expectedRevision) {
      throw new PolicyConflictError(`policy revision conflict: expected ${expectedRevision}, actual ${policy.revision}`);
    }
    return policy;
  }

  private updateState(
    id: string,
    expectedRevision: number,
    state: PlannerPolicyState,
    updatedAt: string,
    trustedAt?: string,
  ): void {
    const result = this.db.prepare(`
      UPDATE planner_policies
      SET state = ?, revision = revision + 1, updated_at = ?,
        trusted_at = COALESCE(?, trusted_at)
      WHERE id = ? AND revision = ?
    `).run(state, updatedAt, trustedAt ?? null, id, expectedRevision);
    if (result.changes !== 1) throw new PolicyConflictError(`policy changed concurrently: ${id}`);
  }

  private audit(id: string, action: string, detail: Record<string, unknown>, at: string): void {
    this.db.prepare(`
      INSERT INTO planner_policy_audit (policy_id, action, detail_json, created_at)
      VALUES (?, ?, ?, ?)
    `).run(id, action, JSON.stringify(detail), at);
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS planner_policies (
        id TEXT PRIMARY KEY,
        version INTEGER NOT NULL,
        revision INTEGER NOT NULL,
        state TEXT NOT NULL,
        content_json TEXT NOT NULL,
        evidence_json TEXT NOT NULL,
        evolved_from TEXT,
        source_candidate_id TEXT,
        task_family TEXT,
        goal_pattern TEXT,
        goal_signature TEXT,
        confidence_lower_bound REAL NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        trusted_at TEXT
      );
      CREATE TABLE IF NOT EXISTS planner_policy_active (
        slot TEXT PRIMARY KEY,
        policy_id TEXT NOT NULL REFERENCES planner_policies(id),
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS planner_policy_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        policy_id TEXT NOT NULL,
        action TEXT NOT NULL,
        detail_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    // 旧 schema 把 version 当 Profile 全局序号。现在版本属于具体经验作用域，
    // 不同 GoalSignature 允许各自拥有 V1/V2，因此迁移为普通查询索引。
    this.db.exec(`
      DROP INDEX IF EXISTS idx_planner_policy_version;
      CREATE INDEX IF NOT EXISTS idx_planner_policy_version ON planner_policies(version);
    `);
    const policyColumns = this.db.prepare('PRAGMA table_info(planner_policies)').all() as Array<{ name: string }>;
    for (const [name, sql] of [
      ['source_candidate_id', 'ALTER TABLE planner_policies ADD COLUMN source_candidate_id TEXT'],
      ['task_family', 'ALTER TABLE planner_policies ADD COLUMN task_family TEXT'],
      ['goal_pattern', 'ALTER TABLE planner_policies ADD COLUMN goal_pattern TEXT'],
      ['goal_signature', 'ALTER TABLE planner_policies ADD COLUMN goal_signature TEXT'],
    ] as const) if (!policyColumns.some(column => column.name === name)) this.db.exec(sql);
  }
}

function toPolicy(row: PolicyRow): PlannerPolicyRecord {
  return {
    id: row.id,
    version: row.version,
    revision: row.revision,
    state: row.state,
    content: JSON.parse(row.content_json) as PlannerPolicyContent,
    evidenceIds: boundedEvidenceRefs(
      JSON.parse(row.evidence_json) as string[],
      CANDIDATE_EVIDENCE_REF_LIMIT,
    ),
    ...(row.evolved_from ? { evolvedFrom: row.evolved_from } : {}),
    ...(row.source_candidate_id ? { sourceCandidateId: row.source_candidate_id } : {}),
    ...(row.task_family ? { taskFamily: row.task_family } : {}),
    ...(row.goal_pattern ? { goalPattern: row.goal_pattern } : {}),
    ...(row.goal_signature ? { goalSignature: row.goal_signature } : {}),
    confidenceLowerBound: row.confidence_lower_bound,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.trusted_at ? { trustedAt: row.trusted_at } : {}),
  };
}

function slotForPolicy(policy: PlannerPolicyRecord): string {
  return slotForContent(policy.content);
}

function slotForContent(content: PlannerPolicyContent): string {
  for (const value of content.applicability) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
    const taskFamily = (value as Record<string, unknown>).taskFamily;
    if (typeof taskFamily === 'string' && taskFamily.trim()) {
      const rule = value as Record<string, unknown>;
      const scope = [rule.goalSignature, rule.targetId, rule.goalContains]
        .find(candidate => typeof candidate === 'string' && candidate.trim()) as string | undefined;
      return scope
        ? `family:${taskFamily.trim()}:goal:${scope.trim().toLowerCase()}`
        : `family:${taskFamily.trim()}`;
    }
  }
  return 'default';
}
