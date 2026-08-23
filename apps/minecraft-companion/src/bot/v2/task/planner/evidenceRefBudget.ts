export const CANDIDATE_EVIDENCE_REF_LIMIT = 32;
export const MANIFEST_ENTRY_EVIDENCE_REF_LIMIT = 8;
export const BUNDLE_EVIDENCE_REF_LIMIT = 32;
export const EXPERIENCE_ITEM_EVIDENCE_REF_LIMIT = 8;

/**
 * Keeps embedded provenance small and deterministic. Full facts remain in the
 * EpisodeLedger/graph and are resolved through their stable IDs when needed.
 */
export function boundedEvidenceRefs(
  values: Iterable<string | null | undefined>,
  limit = CANDIDATE_EVIDENCE_REF_LIMIT,
): string[] {
  if (!Number.isInteger(limit) || limit < 1) return [];
  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== 'string' || !value.trim() || seen.has(value)) continue;
    seen.add(value);
    ordered.push(value);
  }
  return ordered.slice(Math.max(0, ordered.length - limit));
}
