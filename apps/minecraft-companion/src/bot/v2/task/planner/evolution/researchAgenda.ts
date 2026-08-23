import type { ExperienceCandidate } from './plannerOptimizer.js';
import type { PlannerLearningStore, ResearchAgendaRecord } from './learningStore.js';

export class ResearchAgenda {
  constructor(private readonly store: PlannerLearningStore) {}

  schedule(candidates: ExperienceCandidate[]): ResearchAgendaRecord[] {
    const existing = new Map(this.store.listAgenda().map(item => [item.candidateId, item]));
    const items = candidates.map(candidate => {
      const uncertainty = 1 - candidate.confidenceLowerBound;
      const impactScope = Math.max(1, candidate.content.taskSchemas.length + candidate.content.planFragments.length);
      const headroom = Math.max(0, 1 - candidate.confidenceLowerBound);
      const safetyRisk = candidate.status === 'blacklisted' ? 1 : 0;
      const estimatedCost = Math.max(1, candidate.validationSpec?.minimumSelectionSamples ?? 1);
      const expectedInformationGain = uncertainty * Math.log2(2 + candidate.evidenceIds.length);
      const previous = existing.get(candidate.id);
      const computedStatus = !candidate.validationSpec ? 'backlog' : safetyRisk > 0 || headroom === 0 ? 'closed' : 'queued';
      const status = previous && ['closed', 'backlog', 'inconclusive', 'running'].includes(previous.status) ? previous.status : computedStatus;
      const computedReason = !candidate.validationSpec ? 'validator_missing' : safetyRisk > 0 ? 'safety_veto' : undefined;
      const reason = previous?.status === status && previous.reason ? previous.reason : computedReason;
      return this.store.upsertAgenda({
        candidateId: candidate.id,
        status,
        expectedInformationGain,
        uncertainty,
        impactScope,
        estimatedCost,
        safetyRisk,
        headroom,
        retryBudget: previous?.retryBudget ?? 2,
        ...(candidate.validationSpec ? { validationSpec: candidate.validationSpec } : {}),
        ...(reason ? { reason } : {}),
      });
    });
    return items.sort((a, b) => priority(b) - priority(a) || a.candidateId.localeCompare(b.candidateId));
  }

  settle(candidateId: string, outcome: 'completed' | 'inconclusive' | 'rejected'): ResearchAgendaRecord {
    const current = this.store.listAgenda().find(item => item.candidateId === candidateId);
    if (!current) throw new Error(`agenda item not found: ${candidateId}`);
    const retryBudget = outcome === 'inconclusive' ? Math.max(0, current.retryBudget - 1) : current.retryBudget;
    return this.store.upsertAgenda({
      ...current,
      retryBudget,
      status: outcome === 'completed' || outcome === 'rejected' ? 'closed' : retryBudget > 0 ? 'inconclusive' : 'backlog',
      ...(outcome === 'inconclusive' ? { reason: retryBudget > 0 ? 'retry_available' : 'retry_exhausted' } : {}),
    });
  }
}

function priority(item: ResearchAgendaRecord): number {
  if (item.status !== 'queued') return -Infinity;
  return (item.expectedInformationGain * item.uncertainty * item.impactScope * item.headroom)
    / Math.max(0.001, item.estimatedCost + item.safetyRisk);
}
