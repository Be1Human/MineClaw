import type { CapabilityPackageSnapshot } from './types.js';
import type { GoalAgentStateV1 } from '../task/goalAgent/goalAgentState.js';
import type { GoalProgressGuidance, GoalProgressPolicyPort } from '../task/goalAgent/ports/goalProgressPort.js';
import type { GoalSuccessCriterion } from '../task/contracts/goalTypes.js';
import { legacyProgressFacts } from '../task/goalAgent/legacyProgressFacts.js';
import { validatePredicateArguments } from '../task/goalRunner/goalPredicateEvaluation.js';

/** Domain wait/owner decisions are installed through packages, never central business branches. */
export class CapabilityProgressPolicy implements GoalProgressPolicyPort {
  constructor(private readonly snapshot: () => Pick<CapabilityPackageSnapshot, 'progressProviders' | 'predicateEvaluators'>) {}

  assess(state: Readonly<GoalAgentStateV1>): GoalProgressGuidance | null {
    const guidance = this.snapshot().progressProviders.map(provider => provider.assess(state)).filter((value): value is GoalProgressGuidance => value !== null);
    return guidance.find(value => value.kind === 'needs_owner') ?? guidance.find(value => value.kind === 'unsupported') ?? guidance[0] ?? null;
  }

  project(state: Readonly<GoalAgentStateV1>): unknown {
    const snapshot = this.snapshot();
    const criteria = [...(state.rootGoal?.successCriteria ?? []), ...(state.plan.graph?.nodes.flatMap(node => node.goal.metadata?.structuredSuccessCriteria ?? []) ?? [])] as GoalSuccessCriterion[];
    const factIds = new Set<string>();
    for (const criterion of criteria.filter(value => value.type === 'predicate' && value.predicateVersion)) {
      const evaluator = snapshot.predicateEvaluators.find(value => value.id === criterion.predicate);
      if (!evaluator) continue;
      const args = validatePredicateArguments(criterion, evaluator);
      for (const requirement of evaluator.factRequirements?.(args) ?? []) factIds.add(requirement.providerId);
    }
    return { legacy: legacyProgressFacts(state),
      facts: (state.world.latest?.capabilityFacts ?? []).filter(fact => factIds.has(fact.providerId))
        .map(fact => ({ providerId: fact.providerId, version: fact.version ?? null, complete: fact.complete, truncated: fact.truncated, bounds: fact.bounds, value: fact.value }))
        .sort((a, b) => a.providerId.localeCompare(b.providerId)),
      domains: snapshot.progressProviders.map(provider => ({ id: provider.id, facts: provider.project(state) ?? null })),
    };
  }
}
