import type {
  ProactiveCapabilityCatalogEntry,
  ProactiveTickEvaluation,
} from './contracts.js';

export type ProactiveCapabilityRuntimeState =
  | 'disabled'
  | 'idle'
  | 'candidate'
  | 'suppressed'
  | 'leased'
  | 'running'
  | 'backoff'
  | 'error';

export interface ProactiveCapabilityLeaseProjection {
  readonly activationId: string;
  readonly requestId?: string;
  readonly acquiredAt: number;
}

export interface ProactiveCapabilityRuntimeSnapshot {
  readonly id: string;
  readonly enabled: boolean;
  readonly state: ProactiveCapabilityRuntimeState;
  readonly reason?: string;
  readonly lastEvaluationAt?: number;
  readonly backoffUntil?: number;
  readonly lease?: ProactiveCapabilityLeaseProjection;
  readonly lastResult?: Readonly<Record<string, unknown>>;
}

interface MutableRuntimeState {
  enabled: boolean;
  state: ProactiveCapabilityRuntimeState;
  reason?: string;
  lastEvaluationAt?: number;
  backoffUntil?: number;
  lease?: ProactiveCapabilityLeaseProjection;
  lastResult?: Readonly<Record<string, unknown>>;
}

export class ProactiveCapabilityStateStore {
  private readonly states = new Map<string, MutableRuntimeState>();

  reconcileCatalog(catalog: readonly ProactiveCapabilityCatalogEntry[]): void {
    const present = new Set(catalog.map(entry => entry.id));
    for (const entry of catalog) {
      const current = this.states.get(entry.id);
      if (!current) {
        this.states.set(entry.id, {
          enabled: entry.enabled,
          state: entry.enabled ? 'idle' : 'disabled',
          reason: entry.enabled ? 'not_evaluated' : 'disabled',
        });
        continue;
      }
      current.enabled = entry.enabled;
      if (!entry.enabled) {
        current.state = 'disabled';
        current.reason = 'disabled';
        current.backoffUntil = undefined;
      } else if (current.state === 'disabled') {
        current.state = 'idle';
        current.reason = 'enabled';
      }
    }
    for (const id of this.states.keys()) {
      if (!present.has(id)) this.states.delete(id);
    }
  }

  recordEvaluation(id: string, evaluation: ProactiveTickEvaluation, at: number): void {
    const state = this.required(id);
    state.lastEvaluationAt = at;
    state.backoffUntil = undefined;
    if (evaluation.kind === 'candidate') {
      state.state = 'candidate';
      state.reason = 'candidate';
    } else {
      state.state = 'idle';
      state.reason = evaluation.reason;
    }
  }

  recordSuppressed(id: string, reason: string): void {
    const state = this.required(id);
    state.state = 'suppressed';
    state.reason = reason;
  }

  recordBackoff(id: string, reason: string, until: number, at: number): void {
    const state = this.required(id);
    state.state = 'backoff';
    state.reason = reason;
    state.lastEvaluationAt = at;
    state.backoffUntil = until;
  }

  recordLease(id: string, lease: ProactiveCapabilityLeaseProjection): void {
    const state = this.required(id);
    state.state = 'leased';
    state.reason = 'lease_acquired';
    state.lease = Object.freeze({ ...lease });
  }

  recordRunning(id: string, requestId: string): void {
    const state = this.required(id);
    if (state.lease) state.lease = Object.freeze({ ...state.lease, requestId });
    state.state = 'running';
    state.reason = 'goalagent_running';
  }

  recordReleased(id: string, reason: string): void {
    const state = this.required(id);
    state.lease = undefined;
    state.state = state.enabled ? 'idle' : 'disabled';
    state.reason = reason;
  }

  recordResult(id: string, result: Readonly<Record<string, unknown>>): void {
    const state = this.required(id);
    state.lastResult = Object.freeze({ ...result });
  }

  snapshot(): readonly ProactiveCapabilityRuntimeSnapshot[] {
    return Object.freeze([...this.states.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([id, state]) => Object.freeze({
        id,
        enabled: state.enabled,
        state: state.state,
        ...(state.reason ? { reason: state.reason } : {}),
        ...(state.lastEvaluationAt === undefined ? {} : { lastEvaluationAt: state.lastEvaluationAt }),
        ...(state.backoffUntil === undefined ? {} : { backoffUntil: state.backoffUntil }),
        ...(state.lease ? { lease: Object.freeze({ ...state.lease }) } : {}),
        ...(state.lastResult ? { lastResult: Object.freeze({ ...state.lastResult }) } : {}),
      })));
  }

  get(id: string): ProactiveCapabilityRuntimeSnapshot | null {
    return this.snapshot().find(entry => entry.id === id) ?? null;
  }

  private required(id: string): MutableRuntimeState {
    const state = this.states.get(id);
    if (!state) throw new Error(`unknown proactive capability: ${id}`);
    return state;
  }
}
