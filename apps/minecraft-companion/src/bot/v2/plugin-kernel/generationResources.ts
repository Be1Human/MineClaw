import { createHash } from 'node:crypto';
import type { RegistrySnapshotRef } from '../plugin-sdk/identity.js';
import type { PublishedGenerationSlot, StagedContributionRecord } from './registration.js';
import { splitSkillFile } from '../skills/skillLoader.js';
import type {
  GoalAgentSkillDocumentEvidence,
  GoalAgentSkillIndexEvidence,
  GoalAgentSkillKnowledgePort,
  GoalAgentSkillLookupResult,
  GoalAgentSkillSearchInput,
} from '../skills/goalAgentSkillKnowledge.js';
import {
  DomainKnowledgeRegistry,
  parseDomainKnowledgeContent,
  type DomainKnowledgeDocument,
  type GoalAgentDomainKnowledgePort,
} from '../knowledge/domainKnowledge.js';

type ProjectedSkill = GoalAgentSkillDocumentEvidence & { readonly agent: 'main' | 'goal' | 'both' };

/** Skill view backed exclusively by immutable content in one published Generation. */
export class GenerationSkillKnowledgePort implements GoalAgentSkillKnowledgePort {
  constructor(
    private readonly slot: () => PublishedGenerationSlot | null,
    private readonly snapshot: () => RegistrySnapshotRef,
    private readonly toolNames?: () => readonly string[],
  ) {}

  catalog(input: { readonly limit?: number } = {}): GoalAgentSkillIndexEvidence[] {
    return this.skills().slice(0, bounded(input.limit ?? 32, 64)).map(skill => index(skill, 0));
  }

  search(input: GoalAgentSkillSearchInput): GoalAgentSkillIndexEvidence[] {
    const query = normalize([input.query, input.goalSignature, input.activeStep, input.failureCode].filter(Boolean).join(' '));
    if (!query) return [];
    return this.skills()
      .map(skill => ({ skill, score: skillScore(skill, query) }))
      .filter(value => value.score > 0)
      .sort((left, right) => right.score - left.score || left.skill.name.localeCompare(right.skill.name))
      .slice(0, bounded(input.limit, 20))
      .map(value => index(value.skill, value.score));
  }

  get(input: { readonly ref: string; readonly expectedVersion?: string; readonly maxTokens?: number }): GoalAgentSkillLookupResult {
    const skill = this.skills().find(value => value.ref === input.ref.trim());
    if (!skill) return { ok: false, reason: 'not_found', ref: input.ref };
    if (input.expectedVersion && input.expectedVersion !== skill.version) {
      return { ok: false, reason: 'stale', ref: skill.ref, expectedVersion: input.expectedVersion, actualVersion: skill.version };
    }
    if (skill.toolCompatibility?.state === 'unsupported_tools') {
      return { ok: false, reason: 'unsupported_tools', ref: skill.ref, missingTools: skill.toolCompatibility.missingTools };
    }
    const maxTokens = input.maxTokens ?? 8_192;
    if (skill.estimatedTokens > maxTokens) {
      return { ok: false, reason: 'budget_exceeded', ref: skill.ref, estimatedTokens: skill.estimatedTokens, maxTokens };
    }
    return { ok: true, skill };
  }

  private skills(): ProjectedSkill[] {
    const slot = this.slot();
    if (!slot) return [];
    const record = resolveRecord(slot, this.snapshot());
    const availableTools = this.toolNames ? new Set(this.toolNames()) : null;
    return entries(record, 'skill').flatMap(entry => {
      if (entry.contribution.kind !== 'skill' || !entry.contribution.content?.trim()) return [];
      const parsed = splitSkillFile(entry.contribution.content);
      if (!parsed.fm.name || !parsed.fm.description || !parsed.body.trim()) return [];
      const agent = parsed.fm.agent ?? 'both';
      if (agent !== 'goal' && agent !== 'both') return [];
      const uses = Object.freeze([...(parsed.fm.uses ?? [])]);
      const missingTools = Object.freeze(availableTools ? uses.filter(name => !availableTools.has(name)) : []);
      const ref = `plugin-skill:${entry.ref.contributionId}`;
      const version = exactVersion(entry, entry.contribution.content);
      return [Object.freeze({
        ref,
        name: parsed.fm.name,
        description: parsed.fm.description,
        triggers: Object.freeze([...(parsed.fm.triggers ?? [])]),
        uses,
        version,
        score: 0,
        evidenceRef: contributionEvidence(entry),
        toolCompatibility: Object.freeze({ state: missingTools.length ? 'unsupported_tools' : 'compatible', missingTools }),
        body: parsed.body.trim(),
        contentHash: `sha256:${sha(entry.contribution.content)}`,
        estimatedTokens: Math.max(1, Math.ceil(entry.contribution.content.length / 4)),
        agent,
      })];
    }).sort((left, right) => left.name.localeCompare(right.name));
  }
}

/** Knowledge view backed exclusively by immutable content in one published Generation. */
export class GenerationDomainKnowledgePort implements GoalAgentDomainKnowledgePort {
  constructor(private readonly slot: () => PublishedGenerationSlot | null, private readonly snapshot: () => RegistrySnapshotRef) {}

  ids(): readonly string[] { return this.registry().ids(); }
  search(input: { readonly query: string; readonly limit: number }) { return this.registry().search(input); }
  get(input: { readonly ref: string; readonly expectedVersion?: string; readonly maxTokens?: number }) { return this.registry().get(input); }

  private registry(): DomainKnowledgeRegistry {
    const slot = this.slot();
    if (!slot) return new DomainKnowledgeRegistry([]);
    const record = resolveRecord(slot, this.snapshot());
    const documents = entries(record, 'knowledge').flatMap(entry => {
      if (entry.contribution.kind !== 'knowledge' || !entry.contribution.content?.trim()) return [];
      const parsed = parseDomainKnowledgeContent(entry.contribution.content, entry.contribution.contentRef);
      const version = exactVersion(entry, entry.contribution.content);
      const ref = `plugin-knowledge:${entry.ref.contributionId}`;
      return [Object.freeze({
        ...parsed,
        ref,
        version,
        evidenceRef: contributionEvidence(entry),
      }) satisfies DomainKnowledgeDocument];
    });
    return new DomainKnowledgeRegistry(documents);
  }
}

function resolveRecord(slot: PublishedGenerationSlot, snapshot: RegistrySnapshotRef) {
  const set = slot.read();
  const record = set.active.generationId === snapshot.generationId ? set.active : set.drainingById.get(snapshot.generationId);
  if (!record || record.buildId !== snapshot.buildId || record.graphHash !== snapshot.graphHash) {
    throw new Error(`needs_rebind:generation_unavailable:${snapshot.generationId}`);
  }
  return record;
}

function entries(record: ReturnType<typeof resolveRecord>, kind: 'skill' | 'knowledge'): StagedContributionRecord[] {
  const disabled = new Set(record.registry.disabledIds);
  return (record.registry.byKind.get(kind) ?? []).flatMap(id => {
    const entry = record.registry.byId.get(id);
    return entry && !disabled.has(id) ? [entry] : [];
  });
}

function contributionEvidence(entry: StagedContributionRecord): string {
  const ref = entry.ref;
  return `contribution:${ref.pluginId}@${ref.pluginVersion}/${ref.contributionId}@${ref.contributionVersion}`;
}

function exactVersion(entry: StagedContributionRecord, content: string): string {
  return `${entry.ref.pluginVersion}/${entry.ref.contributionVersion}/sha256:${sha(content)}`;
}

function sha(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function normalize(value: string): string { return value.toLowerCase().replace(/[\s，。！？、；：,.!?;:'"“”‘’]+/g, ''); }
function bounded(value: number, max: number): number {
  if (!Number.isInteger(value) || value < 1) throw new Error('resource limit must be a positive integer');
  return Math.min(value, max);
}
function skillScore(skill: ProjectedSkill, query: string): number {
  const fields = [skill.name, skill.description, ...skill.triggers].map(normalize);
  if (fields.some(value => value === query)) return 1;
  if (fields.some(value => value.includes(query) || query.includes(value))) return 0.8;
  const tokens = query.match(/[a-z0-9_]+|[\u3400-\u9fff]{2,}/gu) ?? [];
  return Math.min(0.7, tokens.filter(token => fields.some(value => value.includes(token))).length * 0.2);
}
function index(skill: ProjectedSkill, score: number): GoalAgentSkillIndexEvidence {
  const { body: _body, contentHash: _hash, estimatedTokens: _tokens, agent: _agent, ...value } = skill;
  return Object.freeze({ ...value, score });
}
