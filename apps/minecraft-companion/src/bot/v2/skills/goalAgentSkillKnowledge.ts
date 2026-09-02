import { createHash } from 'node:crypto';
import type { GoalAgentStepRole } from '../task/goalAgent/goalAgentState.js';
import type { AgentSkillRegistry } from './skillRegistry.js';
import type { AgentSkill } from './types.js';

export interface GoalAgentSkillSearchInput {
  readonly query: string;
  readonly objective: GoalAgentStepRole;
  readonly goalSignature?: string;
  readonly activeStep?: string;
  readonly failureCode?: string;
  readonly limit: number;
}

export interface GoalAgentSkillGetInput {
  readonly ref: string;
  readonly expectedVersion?: string;
  readonly maxTokens?: number;
}

export interface GoalAgentSkillIndexEvidence {
  readonly ref: string;
  readonly name: string;
  readonly description: string;
  readonly triggers: readonly string[];
  readonly uses: readonly string[];
  readonly version: string;
  readonly score: number;
  readonly evidenceRef: string;
  readonly toolCompatibility?: {
    readonly state: 'compatible' | 'unsupported_tools';
    readonly missingTools: readonly string[];
  };
}

export interface GoalAgentSkillDocumentEvidence extends GoalAgentSkillIndexEvidence {
  readonly body: string;
  readonly contentHash: string;
  readonly estimatedTokens: number;
}

export type GoalAgentSkillLookupFailureReason = 'not_found' | 'stale' | 'corrupt' | 'budget_exceeded' | 'unsupported_tools';

export type GoalAgentSkillLookupResult =
  | { readonly ok: true; readonly skill: GoalAgentSkillDocumentEvidence }
  | {
      readonly ok: false;
      readonly reason: GoalAgentSkillLookupFailureReason;
      readonly ref: string;
      readonly expectedVersion?: string;
      readonly actualVersion?: string;
      readonly estimatedTokens?: number;
      readonly maxTokens?: number;
      readonly missingTools?: readonly string[];
    };

export interface GoalAgentSkillKnowledgePort {
  catalog?(input?: { readonly limit?: number }): Promise<GoalAgentSkillIndexEvidence[]> | GoalAgentSkillIndexEvidence[];
  search(input: GoalAgentSkillSearchInput): Promise<GoalAgentSkillIndexEvidence[]> | GoalAgentSkillIndexEvidence[];
  get(input: GoalAgentSkillGetInput): Promise<GoalAgentSkillLookupResult> | GoalAgentSkillLookupResult;
}

/**
 * Read-only GoalAgent view over AgentSkillRegistry.
 *
 * The adapter deliberately recomputes visibility, refs and versions instead of
 * trusting a caller-provided subset. A mistakenly injected full registry still
 * cannot expose an agent=main document through either search or get.
 */
export class GoalAgentSkillKnowledgeAdapter implements GoalAgentSkillKnowledgePort {
  constructor(
    private readonly registry: Pick<AgentSkillRegistry, 'list'>,
    private readonly toolNames?: () => readonly string[],
  ) {}

  private compatibility(skill: AgentSkill): Pick<GoalAgentSkillIndexEvidence, 'toolCompatibility'> {
    if (!this.toolNames) return {};
    const available = new Set(this.toolNames());
    const missingTools = Object.freeze([...(skill.meta.uses ?? [])].filter(name => !available.has(name)));
    return { toolCompatibility: Object.freeze({ state: missingTools.length ? 'unsupported_tools' : 'compatible', missingTools }) };
  }

  catalog(input: { readonly limit?: number } = {}): GoalAgentSkillIndexEvidence[] {
    const limit = boundedLimit(input.limit ?? 32, 64);
    return this.registry.list()
      .filter(isGoalVisible)
      .filter(isValidSkill)
      .sort((left, right) => left.meta.name.localeCompare(right.meta.name))
      .slice(0, limit)
      .map(skill => Object.freeze({ ...indexEvidence(skill), ...this.compatibility(skill), score: 0 }));
  }

  search(input: GoalAgentSkillSearchInput): GoalAgentSkillIndexEvidence[] {
    const query = input.query.trim();
    if (!query) return [];
    const limit = boundedLimit(input.limit);
    const context = [query, input.goalSignature, input.activeStep, input.failureCode]
      .filter((value): value is string => Boolean(value?.trim()))
      .join(' ');

    return this.registry.list()
      .filter(isGoalVisible)
      .filter(isValidSkill)
      .map(skill => ({ skill, score: relevance(skill, context, input.objective) }))
      .filter(value => value.score > 0)
      .sort((left, right) => right.score - left.score || left.skill.meta.name.localeCompare(right.skill.meta.name))
      .slice(0, limit)
      .map(({ skill, score }) => Object.freeze({
        ...indexEvidence(skill),
        ...this.compatibility(skill),
        score,
      }));
  }

  get(input: GoalAgentSkillGetInput): GoalAgentSkillLookupResult {
    const ref = input.ref.trim();
    if (!ref) return { ok: false, reason: 'not_found', ref };
    const skill = this.registry.list().find(candidate => isGoalVisible(candidate) && goalAgentSkillRef(candidate.meta.name) === ref);
    if (!skill) return { ok: false, reason: 'not_found', ref };
    if (!isValidSkill(skill)) return { ok: false, reason: 'corrupt', ref };

    const index = indexEvidence(skill);
    if (input.expectedVersion && input.expectedVersion !== index.version) {
      return {
        ok: false,
        reason: 'stale',
        ref,
        expectedVersion: input.expectedVersion,
        actualVersion: index.version,
      };
    }
    const compatibility = this.compatibility(skill);
    if (compatibility.toolCompatibility?.state === 'unsupported_tools') {
      return { ok: false, reason: 'unsupported_tools', ref, missingTools: compatibility.toolCompatibility.missingTools };
    }
    const estimatedTokens = estimateTokens(skill.body);
    const maxTokens = input.maxTokens ?? 8_192;
    if (!Number.isInteger(maxTokens) || maxTokens < 1) {
      throw new Error('GoalAgent skill maxTokens must be a positive integer');
    }
    if (estimatedTokens > maxTokens) {
      return { ok: false, reason: 'budget_exceeded', ref, estimatedTokens, maxTokens };
    }
    return {
      ok: true,
      skill: Object.freeze({
        ...index,
        ...compatibility,
        score: 1,
        body: skill.body,
        contentHash: index.version,
        estimatedTokens,
      }),
    };
  }
}

export function goalAgentSkillRef(name: string): string {
  const digest = createHash('sha256').update(`mineclaw-goal-skill:${name.trim()}`).digest('hex').slice(0, 24);
  return `skill:${digest}`;
}

function indexEvidence(skill: AgentSkill): Omit<GoalAgentSkillIndexEvidence, 'score'> {
  const ref = goalAgentSkillRef(skill.meta.name);
  const version = skillVersion(skill);
  return {
    ref,
    name: skill.meta.name,
    description: skill.meta.description,
    triggers: Object.freeze([...(skill.meta.triggers ?? [])]),
    uses: Object.freeze([...(skill.meta.uses ?? [])]),
    version,
    evidenceRef: `${ref}@${version}`,
  };
}

function skillVersion(skill: AgentSkill): string {
  const canonical = JSON.stringify({
    name: skill.meta.name,
    description: skill.meta.description,
    category: skill.meta.category ?? null,
    triggers: skill.meta.triggers ?? [],
    uses: skill.meta.uses ?? [],
    agent: skill.meta.agent ?? 'both',
    body: skill.body,
  });
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

function isGoalVisible(skill: AgentSkill): boolean {
  const agent = skill.meta.agent ?? 'both';
  return agent === 'goal' || agent === 'both';
}

function isValidSkill(skill: AgentSkill): boolean {
  return typeof skill.meta.name === 'string'
    && Boolean(skill.meta.name.trim())
    && typeof skill.meta.description === 'string'
    && Boolean(skill.meta.description.trim())
    && typeof skill.body === 'string'
    && Boolean(skill.body.trim())
    && stringArray(skill.meta.triggers)
    && stringArray(skill.meta.uses);
}

function stringArray(value: readonly string[] | undefined): boolean {
  return value === undefined || (Array.isArray(value) && value.every(item => typeof item === 'string'));
}

function relevance(skill: AgentSkill, rawContext: string, objective: GoalAgentStepRole): number {
  const context = normalize(rawContext);
  const name = normalize(skill.meta.name);
  const description = normalize(skill.meta.description);
  let score = 0;
  if (context === name) score += 1;
  else if (context.includes(name) || name.includes(context)) score += 0.72;
  if (description.includes(context) || context.includes(description)) score += 0.45;
  for (const trigger of skill.meta.triggers ?? []) {
    const normalized = normalize(trigger);
    if (normalized && context.includes(normalized)) score += 0.55;
  }
  for (const token of tokens(context)) {
    if (token.length < 2) continue;
    if (name.includes(token)) score += 0.18;
    if (description.includes(token)) score += 0.08;
  }
  if (score > 0 && objectiveAffinity(objective, skill.meta.category)) score += 0.05;
  return Math.round(Math.min(1, score) * 1_000) / 1_000;
}

function objectiveAffinity(node: GoalAgentStepRole, category: string | undefined): boolean {
  if (!category) return false;
  if (node === 'query') return category === 'query' || category === 'perception';
  if (node === 'understand' || node === 'plan' || node === 'act' || node === 'recover') {
    return category === 'task' || category === 'meta';
  }
  if (node === 'evaluate' || node === 'monitor') return category === 'meta' || category === 'perception';
  return false;
}

function tokens(value: string): string[] {
  const words = value.split(/[^a-z0-9_\u3400-\u9fff]+/u).filter(Boolean);
  const cjk = [...value.matchAll(/[\u3400-\u9fff]{2,}/gu)]
    .flatMap(match => Array.from({ length: Math.max(0, match[0].length - 1) }, (_, index) => match[0].slice(index, index + 2)));
  return [...new Set([...words, ...cjk])];
}

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function boundedLimit(limit: number, maximum = 20): number {
  if (!Number.isInteger(limit) || limit < 1) throw new Error('GoalAgent skill search limit must be a positive integer');
  return Math.min(limit, maximum);
}

function estimateTokens(value: string): number {
  return Math.max(1, Math.ceil(value.length / 4));
}
