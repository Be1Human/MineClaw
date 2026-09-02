import type { IBehavior } from '../behavior/types.js';
import type { GoalTargetDefinition } from '../knowledge/goalTargetKnowledge.js';
import type { GoalSuccessCriterion } from '../task/contracts/goalTypes.js';
import type { GoalAgentStateV1 } from '../task/goalAgent/goalAgentState.js';
import type { GoalAgentActionCandidate } from '../task/goalAgent/ports/executionPort.js';
import type { GoalPredicateEvaluator } from '../task/goalRunner/goalCriteriaEvaluator.js';
import type { WorldFact } from '../task/contracts/worldFact.js';
import type { GoalScopeBinding } from '../task/contracts/goalDraft.js';
import type { CapabilityOperationSemantics } from '../task/goalAgent/ports/goalPlanPort.js';
import type { CapabilityProgressProvider } from '../task/goalAgent/ports/goalProgressPort.js';
import type { WorldStateView } from '../types.js';
import type { CapabilityOperationDefinition } from './capabilityOperation.js';
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
  readonly schema: 'mineclaw/capability-manifest@1' | 'mineclaw/capability-manifest@2';
  readonly id: string;
  readonly version: number;
  readonly description: string;
  readonly goalTargets: readonly GoalTargetDefinition[];
  readonly skills: readonly string[];
  readonly knowledge: readonly string[];
  readonly requires: CapabilityRequirementRefs;
  readonly proactiveTicks?: readonly ProactiveTickManifestEntry[];
  /** @2 descriptions reference installed code; they never install executors. */
  readonly operations?: readonly CapabilityOperationDefinition[];
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

export interface CapabilityPredicateEvaluator extends GoalPredicateEvaluator {}

export interface CapabilityWorldFact<TValue = unknown> extends WorldFact<TValue> {}

export interface CapabilityWorldFactProvider<TValue = unknown> {
  readonly id: string;
  readonly version?: string;
  readonly inputSchema?: Readonly<Record<string, unknown>>;
  observe(input: {
    readonly world: WorldStateView;
    readonly params?: Readonly<Record<string, unknown>>;
    readonly signal?: AbortSignal;
  }): Promise<CapabilityWorldFact<TValue>> | CapabilityWorldFact<TValue>;
}

export interface CapabilityGoalBindingProvider {
  readonly id: string;
  list(state: Readonly<GoalAgentStateV1>): readonly GoalScopeBinding[];
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
  readonly goalBindingProviders?: readonly CapabilityGoalBindingProvider[];
  readonly operationSemantics?: readonly CapabilityOperationSemantics[];
  readonly progressProviders?: readonly CapabilityProgressProvider[];
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
  readonly taskKinds?: readonly string[];
}

export interface CapabilityPackageSnapshot {
  readonly packages: readonly CapabilityPackageDefinition[];
  readonly goalTargets: readonly GoalTargetDefinition[];
  readonly behaviors: readonly IBehavior[];
  readonly actionProviders: readonly CapabilityActionCandidateProvider[];
  readonly worldFactProviders: readonly CapabilityWorldFactProvider[];
  readonly goalBindingProviders: readonly CapabilityGoalBindingProvider[];
  readonly operationSemantics: readonly CapabilityOperationSemantics[];
  readonly progressProviders: readonly CapabilityProgressProvider[];
  readonly predicateEvaluators: readonly CapabilityPredicateEvaluator[];
  readonly proactiveTicks: readonly RegisteredProactiveTickCapability[];
  readonly operations: readonly {
    readonly packageId: string;
    readonly packageVersion: number;
    readonly definition: CapabilityOperationDefinition;
  }[];
}
