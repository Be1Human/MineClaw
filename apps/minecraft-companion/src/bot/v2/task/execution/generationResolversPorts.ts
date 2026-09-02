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
import type { PluginAtomicExecutor, PluginAtomicContract, AtomicExecutionContext } from '../../plugin-sdk/contracts/execution.js';
import type { ControlledExecutionContext } from './ports/controlledExecution.js';

export type ResolverOutcome<T> = { readonly status: 'resolved'; readonly value: T } | { readonly status: 'in_doubt'; readonly reason: string };

export interface GenerationBehaviorResolverPort {
  resolve(snapshot: RegistrySnapshotRef, contributionRef: ContributionRef): ResolverOutcome<PluginBehaviorFactory>;
}

export interface GenerationAtomicResolverPort {
  resolve(snapshot: RegistrySnapshotRef, atomicId: string): ResolverOutcome<PluginAtomicExecutor>;
}

/** F12 · Contract/Executor returned together from the pinned generation. */
export interface GenerationAtomicEntryPort {
  resolve(snapshot: RegistrySnapshotRef, atomicId: string): ResolverOutcome<{ readonly executor: PluginAtomicExecutor; readonly contract: PluginAtomicContract | null }>;
}

export interface GenerationContractResolverPort {
  resolve(snapshot: RegistrySnapshotRef, atomicId: string): ResolverOutcome<PluginAtomicContract>;
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
      return resolveAtomicExecutor(resolvers, snapshot, atomicId);
    },
  };
}

/** F12 · Contract/Executor from the pinned generation (never a live registry). */
export function createAtomicEntryResolver(resolvers: GenerationResolvers): GenerationAtomicEntryPort {
  return {
    resolve(snapshot, atomicId) {
      return resolveAtomicEntry(resolvers, snapshot, atomicId);
    },
  };
}

/** F12 · Contract metadata only (schema/prepare/normalize) — LLM-facing presentation. */
export function createContractResolver(resolvers: GenerationResolvers): GenerationContractResolverPort {
  return {
    resolve(snapshot, atomicId) {
      return resolveAtomicContract(resolvers, snapshot, atomicId);
    },
  };
}

function resolveAtomicExecutor(
  resolvers: GenerationResolvers,
  snapshot: RegistrySnapshotRef,
  atomicId: string,
): ResolverOutcome<PluginAtomicExecutor> {
  const entry = resolveAtomicEntry(resolvers, snapshot, atomicId);
  return entry.status === 'resolved' ? { status: 'resolved', value: entry.value.executor } : entry;
}

function resolveAtomicContract(
  resolvers: GenerationResolvers,
  snapshot: RegistrySnapshotRef,
  atomicId: string,
): ResolverOutcome<PluginAtomicContract> {
  const entry = resolveAtomicEntry(resolvers, snapshot, atomicId);
  if (entry.status !== 'resolved') return entry;
  if (!entry.value.contract) return { status: 'in_doubt', reason: `atomic_has_no_contract:${atomicId}` };
  return { status: 'resolved', value: entry.value.contract };
}

function resolveAtomicEntry(
  resolvers: GenerationResolvers,
  snapshot: RegistrySnapshotRef,
  atomicId: string,
): ResolverOutcome<{ readonly executor: PluginAtomicExecutor; readonly contract: PluginAtomicContract | null }> {
  const result = resolvers.resolveById(snapshot, 'mineclaw.minecraft-system.execution.atomics');
  if (result.status !== 'resolved' || !result.entry) {
    return { status: 'in_doubt', reason: result.reason ?? 'system_plugin_unresolved' };
  }
  const catalog = (result.entry.contribution as { atomicCatalog?: AtomicCatalogEntry[] }).atomicCatalog ?? [];
  const entry = catalog.find(candidate => candidate.atomicId === atomicId);
  if (!entry) return { status: 'in_doubt', reason: `atomic_not_in_generation:${atomicId}` };
  return { status: 'resolved', value: { executor: entry.executor, contract: entry.contract ?? null } };
}

interface AtomicCatalogEntry {
  readonly atomicId: string;
  readonly version: string;
  readonly executor: PluginAtomicExecutor;
  readonly contract?: PluginAtomicContract;
}

/** Adapter: controlled execution context -> SDK atomic context (assertCurrent/wait/deadline). */
export function atomicExecutionContextAdapter(context: ControlledExecutionContext): AtomicExecutionContext {
  return {
    deadlineAt: context.deadlineAt,
    assertCurrent: (reason: string) => context.assertCurrent(reason),
    wait: (ms: number) => context.wait(ms),
  };
}
