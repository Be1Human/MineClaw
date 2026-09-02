import { tuning } from '../../infra/tuning.js';
import type { FactRegion, WorldFact, WorldFactRequirement } from '../contracts/worldFact.js';

export function observationIsFresh(observedAt: number, now: number, maxAgeMs: number): boolean {
  const futureSkew = tuning().goalEvidence.maxFutureSkewMs;
  return [observedAt, now, maxAgeMs, futureSkew].every(Number.isFinite) && maxAgeMs >= 0 && futureSkew >= 0
    && observedAt <= now + futureSkew && now - observedAt <= maxAgeMs;
}

/** Returns a reason rather than turning missing/partial observations into negative world facts. */
export function worldFactIssue(fact: WorldFact, required: WorldFactRequirement, now: number): string | null {
  if (fact.providerId !== required.providerId || fact.version !== required.version) return 'fact_identity_or_version_mismatch';
  if (!fact.complete || fact.truncated) return 'fact_incomplete_or_truncated';
  if (!observationIsFresh(fact.observedAt, now, tuning().goalEvidence.maxFactAgeMs)) return 'fact_stale_or_invalid_time';
  if (!required.dimension || fact.bounds.dimension !== required.dimension) return 'fact_dimension_mismatch';
  if (required.worldId !== undefined && fact.bounds.worldId !== required.worldId) return 'fact_world_mismatch';
  if (required.region && (!isFactRegion(required.region) || !isFactRegion(fact.bounds.region)
    || !regionContains(fact.bounds.region, required.region))) return 'fact_region_not_covered';
  if (!fact.evidenceRefs.length || fact.evidenceRefs.some(ref => typeof ref !== 'string' || !ref.trim())) return 'fact_evidence_missing';
  return null;
}

export function isFactRegion(value: unknown): value is FactRegion {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const region = value as FactRegion;
  return Boolean(region.min && region.max && ['x', 'y', 'z'].every(key => {
    const axis = key as 'x' | 'y' | 'z';
    return Number.isFinite(region.min[axis]) && Number.isFinite(region.max[axis]) && region.min[axis] <= region.max[axis];
  }));
}

export function regionContains(outer: FactRegion, inner: FactRegion): boolean {
  return (['x', 'y', 'z'] as const).every(axis => outer.min[axis] <= inner.min[axis] && outer.max[axis] >= inner.max[axis]);
}
