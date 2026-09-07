/**
 * Execution contract (kernel design §5.2 table).
 * Execution contributions register factories, never shared stateful instances.
 * `BehaviorFactory.create(goalLease)` returns an instance bound to the fixed
 * generation/goal epoch; the Host owns halt/close and lease revocation.
 */
import type { ContributionRef, PluginGoalLease } from '../identity.js';
import type { PluginObservationFact } from './observation.js';

export interface PluginBehaviorContext {
  readonly goal: PluginGoalLease;
  readonly signal: AbortSignal;
  /** Immutable arguments authorized for this exact operation. */
  readonly params: Readonly<Record<string, unknown>>;
  readonly facts: readonly PluginObservationFact[];
  /** Only authorized body submission goes through this port; no device access. */
  submitBody(request: Readonly<Record<string, unknown>>): Promise<Readonly<Record<string, unknown>>>;
  publish(type: string, level: 'info' | 'warn' | 'error', payload: Readonly<Record<string, unknown>>): void;
}

/** Pure input available while compiling a finite sequence. It has no effect port. */
export type PluginBehaviorCompileContext = Omit<PluginBehaviorContext, 'signal' | 'submitBody' | 'publish'>;

export interface PluginBehaviorStep {
  readonly atomicId: string;
  readonly args: Readonly<Record<string, unknown>>;
}

export type PluginBehaviorCompilation =
  | { readonly ok: true; readonly steps: readonly PluginBehaviorStep[] }
  | { readonly ok: false; readonly error: string };

export interface PluginBehaviorResult {
  readonly ok: boolean;
  readonly error?: string;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly cancelled: boolean;
}

interface PluginBehaviorInstanceBase {
  readonly instanceId: string;
  readonly contribution: ContributionRef;
  /** Stop as soon as contracted: no new child actions; wait for StopAck on in-flight ones. */
  halt(): Promise<void>;
  /** Release Host-tracked resources; late callbacks are rejected by lease. */
  close(): Promise<void>;
  readonly settled: boolean;
}

/** A finite, side-effect-free program. Only the body driver executes its compiled steps. */
export interface PluginSequenceBehaviorInstance extends PluginBehaviorInstanceBase {
  readonly kind: 'sequence';
  compile(ctx: PluginBehaviorCompileContext): PluginBehaviorCompilation;
}

/** A runtime program that may inspect receipts between child operations. */
export interface PluginAdaptiveBehaviorInstance extends PluginBehaviorInstanceBase {
  readonly kind: 'adaptive';
  run(ctx: PluginBehaviorContext): Promise<PluginBehaviorResult>;
}

export type PluginBehaviorInstance = PluginSequenceBehaviorInstance | PluginAdaptiveBehaviorInstance;

export interface PluginBehaviorFactory {
  readonly id: string;
  readonly version: string;
  create(lease: PluginGoalLease, scoped: import('./scopedContext.js').ScopedHostContext): PluginBehaviorInstance;
}

/** Long-running activity factory (periodic / persistent); create per goal lease. */
export interface PluginActivityFactory {
  readonly id: string;
  readonly version: string;
  /**
   * Optional declaration of hazards this activity owns while it is running.
   * The declaration is fixed with the resolved factory at activity start; it
   * does not grant an activity any additional body authority.
   */
  readonly hazardPolicy?: Readonly<{
    categories: readonly string[];
  }>;
  prepareStart(input: Readonly<{
    requestText: string;
    world: PluginActivityWorld;
    hostConfig: Readonly<Record<string, unknown>>;
  }>): Readonly<Record<string, unknown>>;
  create(lease: PluginGoalLease, scoped: import('./scopedContext.js').ScopedHostContext): PluginActivityInstance;
}

export interface PluginActivityWorld {
  readonly tick: number;
  readonly observedAt: number;
  readonly self: Readonly<{
    position: Readonly<{ x: number; y: number; z: number }>;
    health: number;
    maxHealth: number;
    food: number;
  }>;
  /**
   * Bounded owner observation for activities whose declared domain requires it.
   * The host owns owner discovery; plugins only receive an immutable snapshot.
   */
  readonly owner: Readonly<{
    username: string;
    position: Readonly<{ x: number; y: number; z: number }> | null;
    distance: number;
    entityId: number | null;
    isVisible: boolean;
  }> | null;
  /**
   * A bounded, immutable inventory projection.  Activities may reason about
   * supplies but must submit any use through the body port.
   */
  readonly inventory: Readonly<{
    items: readonly Readonly<{
      name: string;
      count: number;
      slot: number;
      durability?: number;
      maxDurability?: number;
    }>[];
    held: Readonly<{
      name: string;
      count: number;
      slot: number;
      durability?: number;
      maxDurability?: number;
    }> | null;
    readonly armor: Readonly<{
      head: Readonly<{ name: string; count: number; slot: number }> | null;
      torso: Readonly<{ name: string; count: number; slot: number }> | null;
      legs: Readonly<{ name: string; count: number; slot: number }> | null;
      feet: Readonly<{ name: string; count: number; slot: number }> | null;
    }>;
    freeSlots: number;
  }>;
  readonly entities: readonly Readonly<{
    id: string | number;
    name: string;
    category: string;
    distance: number;
    position: Readonly<{ x: number; y: number; z: number }>;
    droppedItem?: Readonly<{ name: string; count: number }>;
  }>[];
}

/** A finite, host-authorized body step emitted by a persistent activity. */
export interface PluginActivityBodyRequest {
  readonly atomicId: string;
  readonly args: Readonly<Record<string, unknown>>;
  /** Optional finite step budget; the host validates and clamps it to its safety ceiling. */
  readonly timeoutMs?: number;
}

/** Persistent activities get read-only snapshots and submit finite child atomics. */
export interface PluginActivityContext {
  readonly goal: PluginGoalLease;
  readonly signal: AbortSignal;
  readonly params: Readonly<Record<string, unknown>>;
  observe(): PluginActivityWorld;
  /**
   * Returns a fresh immutable snapshot of the host-owned activity settings.
   * It is a read-only observation port, never a mutable reference to host
   * configuration, so hot tuning can be observed without plugin write access.
   */
  getHostConfig(): Readonly<Record<string, unknown>>;
  submitBody(request: PluginActivityBodyRequest): Promise<Readonly<Record<string, unknown>>>;
  wait(ms: number): Promise<void>;
  publish(type: string, level: 'info' | 'warn' | 'error', payload: Readonly<Record<string, unknown>>): void;
}

export interface PluginActivityInstance {
  readonly instanceId: string;
  readonly contribution: ContributionRef;
  run(ctx: PluginActivityContext): Promise<PluginBehaviorResult>;
  halt(): Promise<void>;
  close(): Promise<void>;
  readonly settled: boolean;
}

/**
 * Primitive atomic executor — owned by the trusted `mineclaw.minecraft-system`
 * plugin (or another release system plugin). The executor holds adapter ports
 * injected at startup through the system ports; the body driver adapts its
 * controlled execution context so duration, stop and budget semantics are
 * exactly those of any other body work.
 */
export interface AtomicExecutionContext {
  readonly operationId: string;
  readonly operationEpoch: number;
  readonly leaseRef: string;
  readonly stepId: string;
  readonly deadlineAt: number;
  readonly signal: AbortSignal;
  assertCurrent(reason: string): void;
  effect<T>(run: () => T | PromiseLike<T>): Promise<T>;
  wait(ms: number): Promise<void>;
  /** Register operation-local device cleanup; the body owner awaits it before StopAck. */
  registerCleanup(cleanup: (reason: string) => Promise<void>): void;
}

export interface PluginAtomicExecutor {
  readonly id: string;
  readonly version: string;
  execute(response: AtomicExecutionCommand, context: AtomicExecutionContext, signal: AbortSignal): Promise<Readonly<Record<string, unknown>>>;
}

/**
 * Self-describing atomic contract metadata (kernel design §5.10 F12: the
 * Generation resolver returns Contract/Executor together). The system plugin
 * owns the shape; prepare/normalize stay pure — no device access, no side
 * effects. Absent contract means the atomic is catalog-only (not presented as a
 * parameter-ready tool); missing prepare → callers use raw args, missing
 * normalize → callers keep the raw failure.
 */
export interface PluginAtomicContract {
  readonly atomicId: string;
  readonly version: string;
  /** Closed argument schema for LLM-facing tool presentation. */
  readonly schema?: Readonly<Record<string, unknown>>;
  /** Normalize/validate raw args into canonical target fields. */
  readonly prepare?: (request: Readonly<Record<string, unknown>>) =>
    | { readonly prepared: Readonly<Record<string, unknown>>; readonly derivedFields?: readonly string[] }
    | { readonly invalid: { readonly code: string; readonly message: string } };
  /** Map an execution result to a structured failure envelope (null = ok). */
  readonly normalize?: (result: Readonly<Record<string, unknown>>) => { readonly code: string; readonly message: string } | null;
}

export interface AtomicExecutionCommand {
  readonly request: Readonly<Record<string, unknown>>;
  readonly source: string;
}
