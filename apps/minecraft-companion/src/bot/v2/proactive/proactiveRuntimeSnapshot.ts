import type { ProactiveCapabilityCatalogEntry } from './contracts.js';
import type { ProactiveCapabilityRuntimeSnapshot } from './proactiveCapabilityStateStore.js';
import type { ProactiveGoalLease } from './proactiveGoalLeaseRegistry.js';

export interface ProactiveRuntimeSnapshot {
  readonly catalog: readonly ProactiveCapabilityCatalogEntry[];
  readonly states: readonly ProactiveCapabilityRuntimeSnapshot[];
  readonly lease: Readonly<{ active: ProactiveGoalLease | null; releasing: ProactiveGoalLease | null }>;
}

/** A compact, shared projection injected into both MainBrain and GoalAgent. */
export function formatProactiveRuntimeContext(snapshot: ProactiveRuntimeSnapshot): string {
  return `[ProactiveCapabilities/v1]\n${JSON.stringify({
    capabilities: snapshot.catalog.map(entry => ({
      id: entry.id,
      enabled: entry.enabled,
      decisionMode: entry.decisionMode,
      goalTarget: entry.goalTarget,
      state: snapshot.states.find(state => state.id === entry.id)?.state ?? 'unknown',
      reason: snapshot.states.find(state => state.id === entry.id)?.reason,
    })),
    active: snapshot.lease.active,
    releasing: snapshot.lease.releasing,
  })}`;
}
