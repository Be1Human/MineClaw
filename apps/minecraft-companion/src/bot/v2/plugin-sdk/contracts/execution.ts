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
  readonly facts: readonly PluginObservationFact[];
  /** Only authorized body submission goes through this port; no device access. */
  submitBody(request: Readonly<Record<string, unknown>>): Promise<Readonly<Record<string, unknown>>>;
  publish(type: string, level: 'info' | 'warn' | 'error', payload: Readonly<Record<string, unknown>>): void;
}

export interface PluginBehaviorResult {
  readonly ok: boolean;
  readonly error?: string;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly cancelled: boolean;
}

export interface PluginBehaviorInstance {
  readonly instanceId: string;
  readonly contribution: ContributionRef;
  run(ctx: PluginBehaviorContext): Promise<PluginBehaviorResult>;
  /** Stop as soon as contracted: no new child actions; wait for StopAck on in-flight ones. */
  halt(): Promise<void>;
  /** Release Host-tracked resources; late callbacks are rejected by lease. */
  close(): Promise<void>;
  readonly settled: boolean;
}

export interface PluginBehaviorFactory {
  readonly id: string;
  readonly version: string;
  create(lease: PluginGoalLease, scoped: import('./scopedContext.js').ScopedHostContext): PluginBehaviorInstance;
}

/** Long-running activity factory (periodic / persistent); create per goal lease. */
export interface PluginActivityFactory {
  readonly id: string;
  readonly version: string;
  create(lease: PluginGoalLease, scoped: import('./scopedContext.js').ScopedHostContext): PluginActivityInstance;
}

export interface PluginActivityInstance {
  readonly instanceId: string;
  readonly contribution: ContributionRef;
  run(ctx: PluginBehaviorContext): Promise<PluginBehaviorResult>;
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
  readonly deadlineAt: number;
  assertCurrent(reason: string): void;
  wait(ms: number): Promise<void>;
}

export interface PluginAtomicExecutor {
  readonly id: string;
  readonly version: string;
  execute(response: AtomicExecutionCommand, context: AtomicExecutionContext, signal: AbortSignal): Promise<Readonly<Record<string, unknown>>>;
}

export interface AtomicExecutionCommand {
  readonly request: Readonly<Record<string, unknown>>;
  readonly source: string;
}
