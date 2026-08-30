import type { IBehavior } from '../behavior/types.js';
import type { GoalTargetDefinition } from '../knowledge/goalTargetKnowledge.js';
import type { GoalSuccessCriterion } from '../task/contracts/goalTypes.js';
import type { GoalAgentStateV1 } from '../task/goalAgent/goalAgentState.js';
import type { GoalAgentActionCandidate } from '../task/goalAgent/ports/executionPort.js';
import type {
  GoalCriteriaEvaluation,
  GoalCriterionEvidence,
} from '../task/goalRunner/goalCriteriaEvaluator.js';
import type { WorldStateView } from '../types.js';
import type {
  ProactiveTickCapabilityImplementation,
  ProactiveTickManifestEntry,
  RegisteredProactiveTickCapability,
} from '../proactive/contracts.js';

export interface CapabilityRequirementRefs {
  readonly atomics: readonly string[];
  readonly behaviors?: readonly string[];
  readonly strategies?: readonly string[];
}

export interface CapabilityManifestDefinition {
  readonly schema: 'mineclaw/capability-manifest@1';
  readonly id: string;
  readonly version: number;
  readonly description: string;
  readonly goalTargets: readonly GoalTargetDefinition[];
  readonly skills: readonly string[];
  readonly knowledge: readonly string[];
  readonly requires: CapabilityRequirementRefs;
  readonly proactiveTicks?: readonly ProactiveTickManifestEntry[];
}

export interface CapabilityActionCandidateProvider {
  readonly id: string;
  list(input: {
    readonly state: Readonly<GoalAgentStateV1>;
    readonly planNodeId?: string;
    readonly criteria: readonly GoalSuccessCriterion[];
    readonly goalText: string;
    readonly world: WorldStateView;
    readonly signal: AbortSignal;
  }): Promise<readonly GoalAgentActionCandidate[]> | readonly GoalAgentActionCandidate[];
}

export interface CapabilityPredicateEvaluator {
  readonly id: string;
  evaluate(input: {
    readonly criterion: GoalSuccessCriterion;
    readonly world: WorldStateView;
    readonly evidence: GoalCriterionEvidence;
  }): GoalCriteriaEvaluation;
}

export interface CapabilityWorldFact<TValue = unknown> {
  readonly providerId: string;
  readonly observedAt: number;
  readonly complete: boolean;
  readonly truncated: boolean;
  readonly bounds: Readonly<Record<string, unknown>>;
  readonly value: TValue;
  readonly evidenceRefs: readonly string[];
}

export interface CapabilityWorldFactProvider<TValue = unknown> {
  readonly id: string;
  observe(input: {
    readonly world: WorldStateView;
    readonly params?: Readonly<Record<string, unknown>>;
    readonly signal?: AbortSignal;
  }): Promise<CapabilityWorldFact<TValue>> | CapabilityWorldFact<TValue>;
}

/**
 * One domain-owned vertical slice. It declares knowledge and references to
 * executable resources; it cannot define or grant new Atomic actions.
 */
export interface CapabilityPackageDefinition {
  readonly manifest: CapabilityManifestDefinition;
  readonly behaviors?: readonly IBehavior[];
  readonly actionProviders: readonly CapabilityActionCandidateProvider[];
  readonly worldFactProviders?: readonly CapabilityWorldFactProvider[];
  readonly predicateEvaluators: readonly CapabilityPredicateEvaluator[];
  readonly proactiveTicks?: readonly ProactiveTickCapabilityImplementation[];
}

export interface CapabilityPackageEnvironment {
  readonly atomicIds: readonly string[];
  readonly behaviorIds: readonly string[];
  readonly strategyIds?: readonly string[];
  readonly skillNames: readonly string[];
  readonly knowledgeIds: readonly string[];
  readonly goalTargetIds?: readonly string[];
}

export interface CapabilityPackageSnapshot {
  readonly packages: readonly CapabilityPackageDefinition[];
  readonly goalTargets: readonly GoalTargetDefinition[];
  readonly behaviors: readonly IBehavior[];
  readonly actionProviders: readonly CapabilityActionCandidateProvider[];
  readonly worldFactProviders: readonly CapabilityWorldFactProvider[];
  readonly predicateEvaluators: readonly CapabilityPredicateEvaluator[];
  readonly proactiveTicks: readonly RegisteredProactiveTickCapability[];
}
