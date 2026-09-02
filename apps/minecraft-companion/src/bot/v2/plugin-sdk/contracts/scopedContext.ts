/**
 * Scoped host context handed to a plugin factory at construction time (kernel
 * design §5.3). The context is the ONLY boundary a first-party plugin may use to
 * reach capabilities; it must never expose GameAdapter, Storage, arbitrary
 * Registry access or other plugins' private state.
 */
import type { PluginIdentity } from '../identity.js';

export interface PluginHostIdentity {
  readonly version: string;
  readonly buildId: string;
}

export interface ScopedResourceTracker {
  /** Register a subscribable/closeable resource so Host can dispose it on stop/abort. */
  track(resource: PluginTrackedResource): void;
  untrack(resource: PluginTrackedResource): void;
}

export interface PluginTrackedResource {
  readonly id: string;
  close(): void | Promise<void>;
}

/** Default-paused timer/signal gate used during prepareStart; callbacks are held until the Host activation gate opens. */
export interface PluginActivationGate {
  readonly open: boolean;
  whenOpen(signal: AbortSignal): Promise<void>;
}

export interface ScopedHostContext {
  readonly host: PluginHostIdentity;
  readonly plugin: PluginIdentity;
  readonly resources: ScopedResourceTracker;
  readonly activationGate: PluginActivationGate;
}

export interface PluginConstructionContext {
  readonly host: PluginHostIdentity;
  readonly plugin: PluginIdentity;
  /** Present only for release-builtin system plugins (adapter/storage/LLM ports, startup assembly). */
  readonly systemPorts?: Readonly<Record<string, unknown>>;
  readonly signal?: AbortSignal;
}

export function createScopedHostContext(
  host: PluginHostIdentity,
  plugin: PluginIdentity,
  resources?: ScopedResourceTracker,
): ScopedHostContext {
  const tracker = resources ?? createVoidResourceTracker();
  return Object.freeze({
    host: Object.freeze({ ...host }),
    plugin: Object.freeze({ ...plugin }),
    resources: tracker,
    activationGate: createImmediateGate(),
  });
}

export function createVoidResourceTracker(): ScopedResourceTracker {
  const tracked = new Set<PluginTrackedResource>();
  return Object.freeze({
    track(resource: PluginTrackedResource): void {
      tracked.add(resource);
    },
    untrack(resource: PluginTrackedResource): void {
      tracked.delete(resource);
    },
  });
}

function createImmediateGate(): PluginActivationGate {
  return Object.freeze({
    open: true,
    async whenOpen(): Promise<void> {
      return undefined;
    },
  });
}
