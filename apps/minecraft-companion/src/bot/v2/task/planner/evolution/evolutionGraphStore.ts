import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { openSqliteDatabase, type SqliteDatabase } from '../../../infra/sqliteDatabase.js';

export type EvolutionNodeType =
  | 'goal_pattern'
  | 'task_schema'
  | 'plan_fragment'
  | 'plan_graph'
  | 'plan_node'
  | 'plan_recovery_pattern'
  | 'meta_policy'
  | 'failure_pattern'
  | 'episode'
  | 'policy'
  | 'candidate'
  | 'evidence'
  | 'context'
  | 'selection_manifest'
  | 'experience_rejection';

export interface EvolutionNode {
  id: string;
  type: EvolutionNodeType;
  label: string;
  summary: string;
  state?: string;
  evidenceIds: string[];
  data: Record<string, unknown>;
  validFrom: string;
  validTo?: string;
}

export interface EvolutionEdge {
  id: string;
  from: string;
  to: string;
  type: string;
  evidenceIds: string[];
  confidenceLowerBound?: number;
  validFrom: string;
  validTo?: string;
}

export interface EvolutionSubgraph {
  nodes: EvolutionNode[];
  edges: EvolutionEdge[];
  truncated: boolean;
}

export interface EvolutionGraphQuery {
  at?: string;
  types?: EvolutionNodeType[];
  states?: string[];
  search?: string;
  limit?: number;
}

interface NodeRow {
  id: string;
  type: EvolutionNodeType;
  label: string;
  summary: string;
  state: string | null;
  evidence_json: string;
  data_json: string;
  valid_from: string;
  valid_to: string | null;
}

interface EdgeRow {
  id: string;
  from_id: string;
  to_id: string;
  type: string;
  evidence_json: string;
  confidence_lower_bound: number | null;
  valid_from: string;
  valid_to: string | null;
}

export class EvolutionGraphStore {
  private readonly db: SqliteDatabase;

  constructor(dbPath = 'data/planner-evolution.db') {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.db = openSqliteDatabase(dbPath);
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    if (dbPath !== ':memory:') this.db.pragma('journal_mode = WAL');
    this.initSchema();
  }

  upsertNode(node: EvolutionNode): void {
    validateNode(node);
    this.db.prepare(`
      INSERT INTO evolution_nodes (
        id, type, label, summary, state, evidence_json, data_json, valid_from, valid_to
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        type = excluded.type,
        label = excluded.label,
        summary = excluded.summary,
        state = excluded.state,
        evidence_json = excluded.evidence_json,
        data_json = excluded.data_json,
        valid_from = excluded.valid_from,
        valid_to = excluded.valid_to
    `).run(
      node.id, node.type, node.label, node.summary, node.state ?? null,
      JSON.stringify(unique(node.evidenceIds)), JSON.stringify(node.data),
      node.validFrom, node.validTo ?? null,
    );
  }

  upsertEdge(edge: EvolutionEdge): void {
    validateEdge(edge);
    const missing = [edge.from, edge.to].filter(id => !this.getNode(id));
    if (missing.length > 0) throw new Error(`evolution edge has missing nodes: ${missing.join(',')}`);
    this.db.prepare(`
      INSERT INTO evolution_edges (
        id, from_id, to_id, type, evidence_json,
        confidence_lower_bound, valid_from, valid_to
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        from_id = excluded.from_id,
        to_id = excluded.to_id,
        type = excluded.type,
        evidence_json = excluded.evidence_json,
        confidence_lower_bound = excluded.confidence_lower_bound,
        valid_from = excluded.valid_from,
        valid_to = excluded.valid_to
    `).run(
      edge.id, edge.from, edge.to, edge.type, JSON.stringify(unique(edge.evidenceIds)),
      edge.confidenceLowerBound ?? null, edge.validFrom, edge.validTo ?? null,
    );
  }

  getNode(id: string): EvolutionNode | null {
    const row = this.db.prepare('SELECT * FROM evolution_nodes WHERE id = ?').get(id) as NodeRow | undefined;
    return row ? toNode(row) : null;
  }

  retireNode(id: string, validTo = new Date().toISOString()): boolean {
    if (Number.isNaN(Date.parse(validTo))) throw new Error('evolution node validTo is invalid');
    return this.db.transaction(() => {
      const result = this.db.prepare(`
        UPDATE evolution_nodes
        SET valid_to = ?
        WHERE id = ? AND (valid_to IS NULL OR valid_to > ?)
      `).run(validTo, id, validTo);
      if (result.changes === 0) return false;
      this.db.prepare(`
        UPDATE evolution_edges
        SET valid_to = ?
        WHERE (from_id = ? OR to_id = ?) AND (valid_to IS NULL OR valid_to > ?)
      `).run(validTo, id, id, validTo);
      return true;
    })();
  }

  listNodes(options: EvolutionGraphQuery = {}): EvolutionNode[] {
    const at = options.at ?? new Date().toISOString();
    const limit = clampInteger(options.limit, 200, 1, 5001);
    const where = [
      'valid_from <= ?',
      '(valid_to IS NULL OR valid_to > ?)',
    ];
    const params: unknown[] = [at, at];
    const types = unique(options.types ?? []);
    const states = unique(options.states ?? []);
    if (types.length > 0) {
      where.push(`type IN (${types.map(() => '?').join(',')})`);
      params.push(...types);
    }
    if (states.length > 0) {
      where.push(`state IN (${states.map(() => '?').join(',')})`);
      params.push(...states);
    }
    const search = options.search?.trim().slice(0, 160);
    if (search) {
      where.push('(label LIKE ? OR summary LIKE ?)');
      params.push(`%${search}%`, `%${search}%`);
    }
    params.push(limit);
    const rows = this.db.prepare(`
      SELECT * FROM evolution_nodes
      WHERE ${where.join(' AND ')}
      ORDER BY type, label, id
      LIMIT ?
    `).all(...params) as NodeRow[];
    return rows.map(toNode);
  }

  listEdges(options: { at?: string; limit?: number } = {}): EvolutionEdge[] {
    const at = options.at ?? new Date().toISOString();
    const limit = clampInteger(options.limit, 400, 1, 10001);
    const rows = this.db.prepare(`
      SELECT * FROM evolution_edges
      WHERE valid_from <= ? AND (valid_to IS NULL OR valid_to > ?)
      ORDER BY type, id
      LIMIT ?
    `).all(at, at, limit) as EdgeRow[];
    return rows.map(toEdge);
  }

  querySubgraph(
    rootIds: string[],
    options: { depth?: number; maxNodes?: number; maxEdges?: number; at?: string; types?: EvolutionNodeType[] } = {},
  ): EvolutionSubgraph {
    const depth = clampInteger(options.depth, 2, 0, 8);
    const maxNodes = clampInteger(options.maxNodes, 300, 1, 5000);
    const maxEdges = clampInteger(options.maxEdges, 600, 1, 10000);
    const at = options.at ?? new Date().toISOString();
    const allowedTypes = new Set(unique(options.types ?? []));
    const visited = new Set<string>();
    let frontier = unique(rootIds).filter(id => this.getNode(id) != null);
    let truncated = false;

    for (let level = 0; level <= depth && frontier.length > 0; level += 1) {
      const next: string[] = [];
      for (const id of frontier) {
        if (visited.size >= maxNodes) { truncated = true; break; }
        if (visited.has(id)) continue;
        visited.add(id);
        if (level === depth) continue;
        for (const edge of this.edgesForNode(id, at)) {
          const neighbor = edge.from === id ? edge.to : edge.from;
          if (allowedTypes.size > 0) {
            const neighborNode = this.getNode(neighbor);
            if (!neighborNode || !allowedTypes.has(neighborNode.type)) continue;
          }
          if (!visited.has(neighbor)) next.push(neighbor);
        }
      }
      if (truncated) break;
      frontier = unique(next);
    }

    const nodes = [...visited]
      .map(id => this.getNode(id))
      .filter((node): node is EvolutionNode => node != null && activeAt(node, at));
    const allowed = new Set(nodes.map(node => node.id));
    const edges = this.allActiveEdges(at).filter(edge => allowed.has(edge.from) && allowed.has(edge.to));
    if (edges.length > maxEdges) truncated = true;
    return { nodes, edges: edges.slice(0, maxEdges), truncated };
  }

  close(): void {
    this.db.close();
  }

  private edgesForNode(nodeId: string, at: string): EvolutionEdge[] {
    const rows = this.db.prepare(`
      SELECT * FROM evolution_edges
      WHERE (from_id = ? OR to_id = ?)
        AND valid_from <= ?
        AND (valid_to IS NULL OR valid_to > ?)
      ORDER BY id
    `).all(nodeId, nodeId, at, at) as EdgeRow[];
    return rows.map(toEdge);
  }

  private allActiveEdges(at: string): EvolutionEdge[] {
    const rows = this.db.prepare(`
      SELECT * FROM evolution_edges
      WHERE valid_from <= ? AND (valid_to IS NULL OR valid_to > ?)
      ORDER BY id
    `).all(at, at) as EdgeRow[];
    return rows.map(toEdge);
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS evolution_nodes (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        label TEXT NOT NULL,
        summary TEXT NOT NULL,
        state TEXT,
        evidence_json TEXT NOT NULL,
        data_json TEXT NOT NULL,
        valid_from TEXT NOT NULL,
        valid_to TEXT
      );
      CREATE TABLE IF NOT EXISTS evolution_edges (
        id TEXT PRIMARY KEY,
        from_id TEXT NOT NULL REFERENCES evolution_nodes(id),
        to_id TEXT NOT NULL REFERENCES evolution_nodes(id),
        type TEXT NOT NULL,
        evidence_json TEXT NOT NULL,
        confidence_lower_bound REAL,
        valid_from TEXT NOT NULL,
        valid_to TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_evolution_edges_from ON evolution_edges(from_id);
      CREATE INDEX IF NOT EXISTS idx_evolution_edges_to ON evolution_edges(to_id);
    `);
  }
}

function validateNode(node: EvolutionNode): void {
  if (!node.id || !node.label || !node.summary) throw new Error('evolution node identity is required');
  if (Number.isNaN(Date.parse(node.validFrom))) throw new Error('evolution node validFrom is invalid');
  if (node.state !== 'draft' && node.evidenceIds.length === 0) {
    throw new Error(`evolution node ${node.id} requires evidence`);
  }
}

function validateEdge(edge: EvolutionEdge): void {
  if (!edge.id || !edge.from || !edge.to || !edge.type) throw new Error('evolution edge identity is required');
  if (edge.evidenceIds.length === 0) throw new Error(`evolution edge ${edge.id} requires evidence`);
  if (edge.confidenceLowerBound != null && (edge.confidenceLowerBound < 0 || edge.confidenceLowerBound > 1)) {
    throw new Error('confidenceLowerBound must be between 0 and 1');
  }
}

function toNode(row: NodeRow): EvolutionNode {
  return {
    id: row.id, type: row.type, label: row.label, summary: row.summary,
    ...(row.state ? { state: row.state } : {}),
    evidenceIds: JSON.parse(row.evidence_json) as string[],
    data: JSON.parse(row.data_json) as Record<string, unknown>,
    validFrom: row.valid_from,
    ...(row.valid_to ? { validTo: row.valid_to } : {}),
  };
}

function toEdge(row: EdgeRow): EvolutionEdge {
  return {
    id: row.id, from: row.from_id, to: row.to_id, type: row.type,
    evidenceIds: JSON.parse(row.evidence_json) as string[],
    ...(row.confidence_lower_bound == null ? {} : { confidenceLowerBound: row.confidence_lower_bound }),
    validFrom: row.valid_from,
    ...(row.valid_to ? { validTo: row.valid_to } : {}),
  };
}

function activeAt(value: { validFrom: string; validTo?: string }, at: string): boolean {
  return value.validFrom <= at && (value.validTo == null || value.validTo > at);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function clampInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  const candidate = Number.isInteger(value) ? Number(value) : fallback;
  return Math.min(max, Math.max(min, candidate));
}
