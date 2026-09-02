/**
 * System Integration contract (kernel design §5.2 table + §5.3).
 * Only release-built-in `system` plugins implement this contract. Start/stop are
 * idempotent and must release devices/connections/subscriptions on stop;
 * unsupported capabilities are declared explicitly, never faked.
 */
import type { ScopedHostContext } from './scopedContext.js';

export type PluginSystemIntegrationStatus = 'running' | 'stopped' | 'unsupported' | 'failed';

export interface PluginSystemIntegration {
  readonly id: string;
  readonly version: string;
  start(scoped: ScopedHostContext, signal: AbortSignal): Promise<void> | void;
  stop(signal: AbortSignal): Promise<void> | void;
  status(): PluginSystemIntegrationStatus;
  /** Optional service table the host publishes to dependent plugin contexts after activation. */
  readonly services?: Readonly<Record<string, unknown>>;
}

/**
 * Minimal read-only world ports exposed to first-party domain plugins through
 * the system integration that owns the adapter (kernel design §5.3).
 */
export interface BoundedBlockObservationPort {
  observe(input: {
    readonly dimension: string;
    readonly bounds: Readonly<Record<string, unknown>>;
    readonly blockFilter?: readonly string[];
    readonly maxBlocks: number;
    readonly deadlineAt: number;
    readonly signal: AbortSignal;
  }): Promise<{
    readonly snapshotVersion: string;
    readonly observedAt: string;
    readonly dimension: string;
    readonly requestedBounds: Readonly<Record<string, unknown>>;
    readonly observedBounds: Readonly<Record<string, unknown>>;
    readonly blocks: readonly Readonly<Record<string, unknown>>[];
    readonly unloadedRegions: readonly string[];
    readonly complete: boolean;
    readonly truncated: boolean;
    readonly evidenceRefs: readonly string[];
  }>;
}

export interface BoundedInventoryObservationPort {
  observe(input: {
    readonly subjectRef: string;
    readonly itemFilter?: readonly string[];
    readonly maxSlots: number;
    readonly deadlineAt: number;
    readonly signal: AbortSignal;
  }): Promise<{
    readonly snapshotVersion: string;
    readonly observedAt: string;
    readonly subjectRef: string;
    readonly slots: readonly { readonly slot: number; readonly itemId: string; readonly count: number; readonly metadataHash?: string }[];
    readonly complete: boolean;
    readonly truncated: boolean;
    readonly evidenceRefs: readonly string[];
  }>;
}

/**
 * Owner/bot presence read (kernel design §5.3). Pointing is a closed union;
 * when the server cannot provide pitch/raycast it must return the structured
 * `unavailable` branch rather than fabricating a direction.
 */
export interface OwnerContextObservationPort {
  observe(input: {
    readonly subjectRef: string;
    readonly signal: AbortSignal;
  }): Promise<{
    readonly snapshotVersion: string;
    readonly observedAt: string;
    readonly dimension: string;
    readonly botPosition: { readonly x: number; readonly y: number; readonly z: number };
    readonly ownerPosition: { readonly x: number; readonly y: number; readonly z: number } | null;
    readonly pointing:
      | { readonly kind: 'observed'; readonly yaw: number; readonly pitch: number; readonly ray?: { readonly target: string } }
      | { readonly kind: 'unavailable'; readonly reason: string }
      | { readonly kind: 'not_visible' };
    readonly complete: boolean;
    readonly evidenceRefs: readonly string[];
  }>;
}
