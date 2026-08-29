import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse } from 'yaml';

export interface DomainKnowledgeDocument {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly tags: readonly string[];
  readonly body: string;
  readonly sourcePath: string;
  readonly ref: string;
  readonly version: string;
  readonly evidenceRef: string;
  readonly estimatedTokens: number;
}

export interface DomainKnowledgeIndexEvidence {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly tags: readonly string[];
  readonly ref: string;
  readonly version: string;
  readonly evidenceRef: string;
  readonly score: number;
}

export type DomainKnowledgeLookupResult =
  | { readonly ok: true; readonly document: DomainKnowledgeDocument }
  | {
      readonly ok: false;
      readonly reason: 'not_found' | 'stale' | 'budget_exceeded';
      readonly ref: string;
      readonly expectedVersion?: string;
      readonly actualVersion?: string;
      readonly estimatedTokens?: number;
      readonly maxTokens?: number;
    };

export interface GoalAgentDomainKnowledgePort {
  ids(): readonly string[];
  search(input: { readonly query: string; readonly limit: number }): DomainKnowledgeIndexEvidence[];
  get(input: {
    readonly ref: string;
    readonly expectedVersion?: string;
    readonly maxTokens?: number;
  }): DomainKnowledgeLookupResult;
}

/** Read-only, versioned Markdown knowledge catalog. It never exposes executable resources. */
export class DomainKnowledgeRegistry implements GoalAgentDomainKnowledgePort {
  private readonly byId = new Map<string, DomainKnowledgeDocument>();
  private readonly byRef = new Map<string, DomainKnowledgeDocument>();

  constructor(documents: readonly DomainKnowledgeDocument[]) {
    for (const document of documents) {
      if (this.byId.has(document.id)) throw new Error(`duplicate domain knowledge id: ${document.id}`);
      if (this.byRef.has(document.ref)) throw new Error(`duplicate domain knowledge ref: ${document.ref}`);
      this.byId.set(document.id, document);
      this.byRef.set(document.ref, document);
    }
  }

  /**
   * BUG-CROSS-80 · 延迟装配：追加一批文档（如 bot spawn 后才可生成的配方知识）。
   * 已存在的 id 跳过（幂等），重复 ref 报错。
   */
  addAll(documents: readonly DomainKnowledgeDocument[]): number {
    let added = 0;
    for (const document of documents) {
      if (this.byId.has(document.id)) continue;
      if (this.byRef.has(document.ref)) throw new Error(`duplicate domain knowledge ref: ${document.ref}`);
      this.byId.set(document.id, document);
      this.byRef.set(document.ref, document);
      added += 1;
    }
    return added;
  }

  ids(): readonly string[] {
    return Object.freeze([...this.byId.keys()].sort());
  }

  search(input: { readonly query: string; readonly limit: number }): DomainKnowledgeIndexEvidence[] {
    const query = normalize(input.query);
    if (!query) return [];
    const limit = boundedLimit(input.limit, 12);
    return [...this.byId.values()]
      .map(document => ({ document, score: relevance(document, query) }))
      .filter(value => value.score > 0)
      .sort((left, right) => right.score - left.score || left.document.id.localeCompare(right.document.id))
      .slice(0, limit)
      .map(({ document, score }) => Object.freeze({
        id: document.id,
        title: document.title,
        summary: document.summary,
        tags: Object.freeze([...document.tags]),
        ref: document.ref,
        version: document.version,
        evidenceRef: document.evidenceRef,
        score,
      }));
  }

  get(input: { readonly ref: string; readonly expectedVersion?: string; readonly maxTokens?: number }): DomainKnowledgeLookupResult {
    const ref = input.ref.trim();
    const document = this.byRef.get(ref);
    if (!document) return { ok: false, reason: 'not_found', ref };
    if (input.expectedVersion && input.expectedVersion !== document.version) {
      return { ok: false, reason: 'stale', ref, expectedVersion: input.expectedVersion, actualVersion: document.version };
    }
    const maxTokens = input.maxTokens ?? 8_192;
    if (!Number.isInteger(maxTokens) || maxTokens < 1) throw new Error('Domain knowledge maxTokens must be a positive integer');
    if (document.estimatedTokens > maxTokens) {
      return { ok: false, reason: 'budget_exceeded', ref, estimatedTokens: document.estimatedTokens, maxTokens };
    }
    return { ok: true, document };
  }
}

/** Recursively loads knowledge/*.md while refusing symlinks and malformed frontmatter. */
export function loadDomainKnowledge(rootDir: string): DomainKnowledgeDocument[] {
  if (!fs.existsSync(rootDir)) throw new Error(`domain knowledge root does not exist: ${rootDir}`);
  const root = fs.realpathSync(rootDir);
  const files: string[] = [];
  collectMarkdown(root, files);
  return files.sort().map(file => loadDomainKnowledgeFile(root, file));
}

export function loadDomainKnowledgeFile(rootDir: string, filePath: string): DomainKnowledgeDocument {
  const root = fs.realpathSync(rootDir);
  const file = fs.realpathSync(filePath);
  if (!isWithin(root, file)) throw new Error(`domain knowledge path escapes root: ${filePath}`);
  if (path.extname(file).toLowerCase() !== '.md') throw new Error(`domain knowledge must be Markdown: ${filePath}`);
  const content = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  const split = splitFrontmatter(content, file);
  const raw = parse(split.frontmatter) as unknown;
  if (!isRecord(raw)) throw new Error(`invalid domain knowledge frontmatter: ${file}`);
  const id = requiredText(raw.id, 'id', file).toLowerCase();
  const title = requiredText(raw.title, 'title', file);
  const summary = requiredText(raw.summary, 'summary', file);
  const tags = stringArray(raw.tags, 'tags', file);
  const body = split.body.trim();
  if (!body) throw new Error(`domain knowledge body is required: ${file}`);
  const canonical = JSON.stringify({ id, title, summary, tags, body });
  const version = `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
  const ref = domainKnowledgeRef(id);
  return Object.freeze({
    id,
    title,
    summary,
    tags: Object.freeze(tags),
    body,
    sourcePath: file,
    ref,
    version,
    evidenceRef: `${ref}@${version}`,
    estimatedTokens: estimateTokens(body),
  });
}

export function domainKnowledgeRef(id: string): string {
  const digest = createHash('sha256').update(`mineclaw-domain-knowledge:${id.trim().toLowerCase()}`).digest('hex').slice(0, 24);
  return `knowledge:${digest}`;
}

function collectMarkdown(directory: string, output: string[]): void {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`domain knowledge symlink is not allowed: ${target}`);
    if (entry.isDirectory()) collectMarkdown(target, output);
    else if (entry.isFile() && path.extname(entry.name).toLowerCase() === '.md') output.push(target);
  }
}

function splitFrontmatter(content: string, file: string): { frontmatter: string; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(content);
  if (!match) throw new Error(`domain knowledge frontmatter is required: ${file}`);
  return { frontmatter: match[1]!, body: match[2]! };
}

function relevance(document: DomainKnowledgeDocument, query: string): number {
  const id = normalize(document.id);
  const title = normalize(document.title);
  const summary = normalize(document.summary);
  const tags = document.tags.map(normalize);
  let score = 0;
  if (query === id || query === title) score += 1;
  else {
    if (id.includes(query) || query.includes(id)) score += 0.7;
    if (title.includes(query) || query.includes(title)) score += 0.8;
    if (summary.includes(query) || query.includes(summary)) score += 0.5;
    for (const tag of tags) if (tag && (tag.includes(query) || query.includes(tag))) score += 0.35;
  }
  for (const token of query.split(/[^\p{L}\p{N}_:-]+/u).filter(Boolean)) {
    if (token.length < 2) continue;
    if (title.includes(token)) score += 0.2;
    if (summary.includes(token)) score += 0.1;
    if (tags.some(tag => tag.includes(token))) score += 0.12;
  }
  return Math.round(Math.min(1, score) * 1_000) / 1_000;
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[\s，。！？、；：,.!?;:'"“”‘’]+/g, '');
}

function boundedLimit(value: number, max: number): number {
  if (!Number.isInteger(value) || value < 1) throw new Error('Domain knowledge limit must be a positive integer');
  return Math.min(max, value);
}

function estimateTokens(value: string): number {
  return Math.max(1, Math.ceil(Buffer.byteLength(value, 'utf8') / 3));
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requiredText(value: unknown, field: string, file: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`domain knowledge ${field} is required: ${file}`);
  return value.trim();
}

function stringArray(value: unknown, field: string, file: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every(item => typeof item === 'string' && item.trim())) {
    throw new Error(`domain knowledge ${field} must be a non-empty string array: ${file}`);
  }
  return [...new Set(value.map(item => (item as string).trim().toLowerCase()))];
}
