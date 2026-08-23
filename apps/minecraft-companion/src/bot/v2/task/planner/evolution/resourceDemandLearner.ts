import type { PlannerPolicyContent } from './policyStore.js';
import type { PlannerLeafEpisode } from './episodeLedger.js';
import {
  boundedEvidenceRefs,
  EXPERIENCE_ITEM_EVIDENCE_REF_LIMIT,
} from '../evidenceRefBudget.js';

export interface ResourceDemandEvidence {
  basis: 'success_consumption_budget' | 'success_peak_held' | 'failure_conservative_acquisition';
  peakHeld: number;
  totalAcquired: number;
  totalConsumed: number;
  evidenceRefs: string[];
}

export interface LearnedResourceMilestone {
  stage: string;
  goalText: string;
  structuredSuccessCriteria: Array<{ type: 'inventory'; item: string; count: number }>;
  successCriteria: Array<{ type: 'inventory'; item: string; count: number }>;
  evidenceRefs: string[];
  order: number;
  demandEvidence?: ResourceDemandEvidence;
}

interface ResourceObservation {
  item: string;
  peakHeld: number;
  totalAcquired: number;
  totalConsumed: number;
  firstPositiveOrder: number;
  positiveBursts: number;
  evidenceRefs: string[];
}

/**
 * Derives a sufficient resource budget from one completed parent plan.
 * Consumables use total downstream consumption; non-consumable tools and
 * facilities use the highest verified held count. This deliberately avoids
 * treating a momentary inventory peak as the whole-plan budget.
 */
export function successfulResourceMilestones(
  episode: PlannerLeafEpisode,
  targetItem: string | null,
): LearnedResourceMilestone[] {
  const target = targetItem ? normalizeItem(targetItem) : null;
  const referenced = referencedItems(episode);
  return observe(episode)
    .filter(value => value.totalAcquired > 0)
    .filter(value => value.item !== target)
    .filter(value => value.totalConsumed > 0 || referenced.has(value.item))
    .map(value => {
      const consumed = value.totalConsumed > 0;
      const count = Math.max(1, Math.floor(consumed ? value.totalConsumed : value.peakHeld));
      const criterion = { type: 'inventory' as const, item: value.item, count };
      const evidenceRefs = boundedEvidenceRefs(value.evidenceRefs, EXPERIENCE_ITEM_EVIDENCE_REF_LIMIT);
      const basis: ResourceDemandEvidence['basis'] = consumed
        ? 'success_consumption_budget'
        : 'success_peak_held';
      return {
        stage: `obtain:${value.item}`,
        goalText: `获得至少 ${count} 个 ${value.item}，作为后续任务依赖`,
        structuredSuccessCriteria: [criterion],
        successCriteria: [criterion],
        evidenceRefs,
        order: value.firstPositiveOrder,
        demandEvidence: {
          basis,
          peakHeld: value.peakHeld,
          totalAcquired: value.totalAcquired,
          totalConsumed: value.totalConsumed,
          evidenceRefs,
        },
      };
    })
    .sort((left, right) => left.order - right.order || left.stage.localeCompare(right.stage))
    .slice(0, 12);
}

/** Selects one complete successful trace instead of mixing local minima from
 * different plans into a schema that has never succeeded as a whole. */
export function lowestCostSuccessfulEpisode(episodes: PlannerLeafEpisode[]): PlannerLeafEpisode | null {
  return episodes.slice().sort((left, right) => compareCost(planCost(left), planCost(right))
    || left.planRunId.localeCompare(right.planRunId)
    || left.sessionId.localeCompare(right.sessionId))[0] ?? null;
}

/**
 * Failure evidence may only make an existing resource threshold more
 * conservative. It never lowers a quantity or invents an unobserved stage.
 */
export function repairResourceDemandContent(
  parent: PlannerPolicyContent,
  failedEpisodes: PlannerLeafEpisode[],
): PlannerPolicyContent {
  if (failedEpisodes.length === 0) return structuredClone(parent);
  const byItem = combinedFailureObservations(failedEpisodes);
  return {
    ...structuredClone(parent),
    taskSchemas: parent.taskSchemas.map(value => repairContainer(value, byItem)),
    planFragments: parent.planFragments.map(value => repairStage(value, byItem)),
  };
}

function observe(episode: PlannerLeafEpisode): ResourceObservation[] {
  const running = new Map<string, number>();
  const values = new Map<string, Omit<ResourceObservation, 'item' | 'evidenceRefs'> & { evidenceRefs: Set<string> }>();
  const facts = [...episode.facts].sort((left, right) => left.occurredAt.localeCompare(right.occurredAt)
    || left.sequence - right.sequence);
  let positiveOrder = 0;
  for (const fact of facts) {
    if (fact.eventType !== 'execution.progress.observed') continue;
    for (const [rawItem, delta] of Object.entries(inventoryDelta(fact.payload))) {
      if (!Number.isFinite(delta) || delta === 0) continue;
      const item = normalizeItem(rawItem);
      const current = running.get(item) ?? 0;
      const next = current + delta;
      running.set(item, next);
      const existing = values.get(item) ?? {
        peakHeld: 0,
        totalAcquired: 0,
        totalConsumed: 0,
        firstPositiveOrder: Number.MAX_SAFE_INTEGER,
        positiveBursts: 0,
        evidenceRefs: new Set<string>(),
      };
      if (delta > 0) {
        existing.totalAcquired += delta;
        existing.positiveBursts += 1;
        if (existing.firstPositiveOrder === Number.MAX_SAFE_INTEGER) existing.firstPositiveOrder = positiveOrder++;
      } else {
        existing.totalConsumed += Math.abs(delta);
      }
      existing.peakHeld = Math.max(existing.peakHeld, next);
      existing.evidenceRefs.add(fact.eventId);
      values.set(item, existing);
    }
  }
  return [...values.entries()].map(([item, value]) => ({
    item,
    peakHeld: Math.max(0, value.peakHeld),
    totalAcquired: Math.max(0, value.totalAcquired),
    totalConsumed: Math.max(0, value.totalConsumed),
    firstPositiveOrder: value.firstPositiveOrder,
    positiveBursts: value.positiveBursts,
    evidenceRefs: [...value.evidenceRefs],
  }));
}

function combinedFailureObservations(episodes: PlannerLeafEpisode[]): Map<string, ResourceObservation> {
  const combined = new Map<string, ResourceObservation>();
  for (const episode of episodes) {
    for (const value of observe(episode)) {
      const existing = combined.get(value.item);
      if (!existing || value.totalAcquired > existing.totalAcquired
        || (value.totalAcquired === existing.totalAcquired && value.totalConsumed > existing.totalConsumed)) {
        combined.set(value.item, structuredClone(value));
      } else if (existing) {
        existing.evidenceRefs = boundedEvidenceRefs(
          [...existing.evidenceRefs, ...value.evidenceRefs],
          EXPERIENCE_ITEM_EVIDENCE_REF_LIMIT,
        );
      }
    }
  }
  return combined;
}

function repairContainer(value: unknown, byItem: Map<string, ResourceObservation>): unknown {
  if (!isRecord(value) || !Array.isArray(value.stages)) return structuredClone(value);
  return { ...structuredClone(value), stages: value.stages.map(stage => repairStage(stage, byItem)) };
}

function repairStage(value: unknown, byItem: Map<string, ResourceObservation>): unknown {
  if (!isRecord(value)) return structuredClone(value);
  const criteria = structuredCriteria(value);
  if (criteria.length === 0) return structuredClone(value);
  const changedObservations: ResourceObservation[] = [];
  const repaired = criteria.map(criterion => {
    const item = normalizeItem(criterion.item);
    const observation = byItem.get(item);
    if (!observation) return criterion;
    const current = Math.max(1, Math.floor(criterion.count));
    // A failed trace must demonstrate that more of this same resource was
    // actually acquired than the plan requested. This is conservative and
    // cannot reduce or hallucinate a budget.
    if (observation.totalAcquired <= current) return criterion;
    changedObservations.push(observation);
    return { ...criterion, count: Math.max(current, Math.floor(observation.totalAcquired)) };
  });
  if (changedObservations.length === 0) return structuredClone(value);
  const firstChanged = criteria.find(criterion => changedObservations.some(
    observation => observation.item === normalizeItem(criterion.item),
  ))!;
  const first = repaired.find(criterion => normalizeItem(criterion.item) === normalizeItem(firstChanged.item))!;
  const observation = byItem.get(normalizeItem(first.item))!;
  const evidenceRefs = boundedEvidenceRefs(
    changedObservations.flatMap(entry => entry.evidenceRefs),
    EXPERIENCE_ITEM_EVIDENCE_REF_LIMIT,
  );
  const result: Record<string, unknown> = {
    ...structuredClone(value),
    goalText: rewriteGoalCount(typeof value.goalText === 'string' ? value.goalText : '', first.item, first.count),
    structuredSuccessCriteria: repaired,
    successCriteria: repairSuccessCriteria(value.successCriteria, repaired),
    evidenceRefs: boundedEvidenceRefs([
      ...(Array.isArray(value.evidenceRefs) ? value.evidenceRefs.filter((entry): entry is string => typeof entry === 'string') : []),
      ...evidenceRefs,
    ], EXPERIENCE_ITEM_EVIDENCE_REF_LIMIT),
    demandEvidence: {
      basis: 'failure_conservative_acquisition',
      peakHeld: observation.peakHeld,
      totalAcquired: observation.totalAcquired,
      totalConsumed: observation.totalConsumed,
      evidenceRefs,
    } satisfies ResourceDemandEvidence,
  };
  return result;
}

function structuredCriteria(value: Record<string, unknown>): Array<{ type: 'inventory'; item: string; count: number }> {
  if (!Array.isArray(value.structuredSuccessCriteria)) return [];
  return value.structuredSuccessCriteria.flatMap(entry => isRecord(entry)
    && entry.type === 'inventory'
    && typeof entry.item === 'string'
    && typeof entry.count === 'number'
    && Number.isFinite(entry.count)
    ? [{ type: 'inventory' as const, item: normalizeItem(entry.item), count: entry.count }]
    : []);
}

function repairSuccessCriteria(
  value: unknown,
  repaired: Array<{ type: 'inventory'; item: string; count: number }>,
): unknown {
  if (!Array.isArray(value)) return structuredClone(repaired);
  if (value.every(isRecord)) return structuredClone(repaired);
  return value.map(entry => {
    if (typeof entry !== 'string') return structuredClone(entry);
    const criterion = repaired.find(item => entry.includes(item.item));
    return criterion ? JSON.stringify(criterion) : entry;
  });
}

function rewriteGoalCount(goalText: string, item: string, count: number): string {
  if (!goalText) return `获得至少 ${count} 个 ${item}，作为后续任务依赖`;
  if (/获得至少\s*\d+\s*个/.test(goalText)) return goalText.replace(/获得至少\s*\d+\s*个/, `获得至少 ${count} 个`);
  if (/至少\s*\d+\s*个/.test(goalText)) return goalText.replace(/至少\s*\d+\s*个/, `至少 ${count} 个`);
  return goalText;
}

function referencedItems(episode: PlannerLeafEpisode): Set<string> {
  const result = new Set<string>();
  for (const fact of episode.facts.filter(value => value.eventType === 'execution.action.proposed')) {
    const proposal = isRecord(fact.payload.proposal) ? fact.payload.proposal : null;
    if (proposal) collectReferencedItems(proposal, result);
  }
  return result;
}

function collectReferencedItems(value: unknown, result: Set<string>): void {
  if (Array.isArray(value)) {
    for (const entry of value) collectReferencedItems(entry, result);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    if (['itemName', 'item', 'material', 'fuelName', 'toolName'].includes(key)
      && typeof entry === 'string' && entry.trim()) result.add(normalizeItem(entry));
    else collectReferencedItems(entry, result);
  }
}

function inventoryDelta(payload: Record<string, unknown>): Record<string, number> {
  const direct = isRecord(payload.inventoryDelta) ? payload.inventoryDelta : null;
  const nested = isRecord(payload.progress) && isRecord(payload.progress.inventoryDelta)
    ? payload.progress.inventoryDelta
    : null;
  const value = direct ?? nested ?? {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, number] => typeof entry[1] === 'number'));
}

function planCost(episode: PlannerLeafEpisode): [number, number, number, number] {
  const proposed = episode.facts.filter(fact => fact.eventType === 'execution.action.proposed');
  const noProgress = episode.facts
    .filter(fact => fact.eventType === 'execution.progress.observed')
    .reduce((sum, fact) => sum + numeric(fact.payload.noProgress), 0);
  const slowLlm = proposed.filter(fact => isRecord(fact.payload.proposal)
    && fact.payload.proposal.source === 'slow_llm').length;
  const timestamps = episode.facts.map(fact => Date.parse(fact.occurredAt)).filter(Number.isFinite);
  const duration = timestamps.length > 1 ? Math.max(...timestamps) - Math.min(...timestamps) : 0;
  return [proposed.length, noProgress, slowLlm, duration];
}

function compareCost(left: [number, number, number, number], right: [number, number, number, number]): number {
  for (let index = 0; index < left.length; index++) {
    const delta = left[index]! - right[index]!;
    if (delta !== 0) return delta;
  }
  return 0;
}

function numeric(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;
}
function normalizeItem(value: string): string { return value.trim().toLowerCase().replace(/^minecraft:/, ''); }
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
