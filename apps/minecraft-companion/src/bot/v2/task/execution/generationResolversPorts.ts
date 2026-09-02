/**
 * FEAT-CROSS-26-001-004-003/-004 · generation-pinned driver resolvers (P3-3).
 * The body driver resolves Behavior factories and Atomic executors ONLY through
 * these ports (snapshot + exact ContributionRef); missing records surface as
 * in_doubt — never a live-Registry fallback. The atomic context adapter maps the
 * controlled execution context onto the SDK contract.
 */
import type { GenerationResolvers } from '../../plugin-kernel/lifecycle.js';
import type { RegistrySnapshotRef, ContributionRef } from '../../plugin-sdk/identity.js';
import type { PluginBehaviorFactory } from '../../plugin-sdk/contracts/execution.js';
import type { PluginAtomicExecutor, AtomicExecutionContext } from '../../plugin-sdk/contracts/execution.js';
import type { ControlledExecutionContext } from './ports/controlledExecution.js';

export type ResolverOutcome<T> = { readonly status: 'resolved'; readonly value: T } | { readonly status: 'in_doubt'; readonly reason: string };

export interface GenerationBehaviorResolverPort {
  resolve(snapshot: RegistrySnapshotRef, contributionRef: ContributionRef): ResolverOutcome<PluginBehaviorFactory>;
}

export interface GenerationAtomicResolverPort {
  resolve(snapshot: RegistrySnapshotRef, atomicId: string): ResolverOutcome<PluginAtomicExecutor>;
}

/** Behavior factories come from the pinned generation's execution contributions. */
export function createBehaviorResolver(resolvers: GenerationResolvers): GenerationBehaviorResolverPort {
  return {
    resolve(snapshot, contributionRef) {
      const result = resolvers.resolveContribution(snapshot, contributionRef);
      if (result.status !== 'resolved' || !result.entry) {
        return { status: 'in_doubt', reason: result.reason ?? 'behavior_unresolved' };
      }
      const contribution = result.entry.contribution as { kind?: string; behaviorFactory?: PluginBehaviorFactory };
      if (contribution.kind !== 'execution' || !contribution.behaviorFactory) {
        return { status: 'in_doubt', reason: 'no_behavior_factory_in_generation' };
      }
      return { status: 'resolved', value: contribution.behaviorFactory };
    },
  };
}

/** Atomic executors come from the pinned generation's system atomic catalogs. */
export function createAtomicResolver(resolvers: GenerationResolvers): GenerationAtomicResolverPort {
  return {
    resolve(snapshot, atomicId) {
      const result = resolvers.resolveById(snapshot, 'mineclaw.minecraft-system.execution.atomics');
      if (result.status !== 'resolved' || !result.entry) {
        return { status: 'in_doubt', reason: result.reason ?? 'system_plugin_unresolved' };
      }
      const catalog = (result.entry.contribution as { atomicCatalog?: Array<{ atomicId: string; version: string; executor: PluginAtomicExecutor }> }).atomicCatalog ?? [];
      const entry = catalog.find(candidate => candidate.atomicId === atomicId);
      if (!entry) return { status: 'in_doubt', reason: `atomic_not_in_generation:${atomicId}` };
      return { status: 'resolved', value: entry.executor };
    },
  };
}

/** Adapter: controlled execution context -> SDK atomic context (assertCurrent/wait/deadline). */
export function atomicExecutionContextAdapter(context: ControlledExecutionContext): AtomicExecutionContext {
  return {
    deadlineAt: context.deadlineAt,
    assertCurrent: (reason: string) => context.assertCurrent(reason),
    wait: (ms: number) => context.wait(ms),
  };
}
