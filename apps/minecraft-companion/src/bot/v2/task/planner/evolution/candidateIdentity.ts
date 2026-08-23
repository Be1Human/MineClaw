import { createHash } from 'node:crypto';
import type { ExperienceCandidate } from './plannerOptimizer.js';

export interface CandidateIdentity {
  lineageId: string;
  generation: number;
  contentHash: string;
}

/**
 * Candidate identity deliberately excludes mutable evaluation evidence.
 * A generation represents one immutable planning treatment, not a growing bag
 * of Episodes. Evidence cutoff and experiment allocation are stored separately.
 */
export function candidateIdentity(candidate: ExperienceCandidate): CandidateIdentity {
  return {
    lineageId: candidate.lineageId?.trim() || candidate.id,
    generation: Number.isInteger(candidate.generation) && Number(candidate.generation) > 0
      ? Number(candidate.generation)
      : 1,
    contentHash: candidate.contentHash?.trim() || candidateContentHash(candidate),
  };
}

export function candidateContentHash(candidate: Pick<ExperienceCandidate,
  'taskFamily' | 'content' | 'validationSpec'>): string {
  return createHash('sha256').update(stable({
    taskFamily: candidate.taskFamily,
    content: semanticContent(candidate.content),
    validationSpec: candidate.validationSpec ?? null,
  })).digest('hex');
}

export function withCandidateIdentity(candidate: ExperienceCandidate): ExperienceCandidate {
  const identity = candidateIdentity(candidate);
  return {
    ...candidate,
    lineageId: identity.lineageId,
    generation: identity.generation,
    contentHash: identity.contentHash,
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

function semanticContent(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(semanticContent);
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.entries(record)
    .filter(([key]) => !['evidenceRefs', 'evidenceIds', 'sourceEpisodeIds'].includes(key))
    .map(([key, child]) => [key, semanticContent(child)]));
}
