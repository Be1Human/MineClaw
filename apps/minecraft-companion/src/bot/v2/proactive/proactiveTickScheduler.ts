import { TickRate, type ITickable, type TickContext } from '../infra/tickRegistry.js';
import type {
  ProactiveCapabilityPreferences,
  ProactiveTickEvaluation,
  RegisteredProactiveTickCapability,
} from './contracts.js';
import { resolveProactiveCapabilityCatalog } from './contracts.js';
import { ProactiveCapabilityStateStore } from './proactiveCapabilityStateStore.js';
import {
  ProactiveIntentArbiter,
  type ProactiveArbitration,
  type ProactiveCandidateEnvelope,
} from './proactiveIntentArbiter.js';
import type { ProactiveGoalLeaseRegistry } from './proactiveGoalLeaseRegistry.js';

export interface ProactiveTickSchedulerOptions {
  readonly profileId: string;
  readonly capabilities: readonly RegisteredProactiveTickCapability[];
  readonly preferences?: ProactiveCapabilityPreferences;
  readonly stateStore: ProactiveCapabilityStateStore;
  readonly arbiter: ProactiveIntentArbiter;
  readonly leases: ProactiveGoalLeaseRegistry;
  readonly isForegroundBusy: () => boolean;
  readonly onArbitration: (decision: ProactiveArbitration, evaluations: ReadonlyMap<string, ProactiveTickEvaluation>) => void | Promise<void>;
  readonly now?: () => number;
  readonly evaluationTimeoutMs?: number;
  readonly errorBackoffMs?: number;
}

export class ProactiveTickScheduler implements ITickable {
  readonly id = 'proactive-capability-scheduler';
  readonly rate = TickRate.FAST;
  private preferences: ProactiveCapabilityPreferences;
  private running = false;
  private readonly backoffUntil = new Map<string, number>();
  private readonly now: () => number;
  private readonly evaluationTimeoutMs: number;
  private readonly errorBackoffMs: number;

  constructor(private readonly options: ProactiveTickSchedulerOptions) {
    this.preferences = options.preferences ?? {};
    this.now = options.now ?? Date.now;
    this.evaluationTimeoutMs = options.evaluationTimeoutMs ?? 1_000;
    this.errorBackoffMs = options.errorBackoffMs ?? 30_000;
    this.options.stateStore.reconcileCatalog(resolveProactiveCapabilityCatalog(options.capabilities, this.preferences));
  }

  setPreferences(preferences: ProactiveCapabilityPreferences): void {
    this.preferences = preferences;
    this.options.stateStore.reconcileCatalog(resolveProactiveCapabilityCatalog(this.options.capabilities, preferences));
  }

  onTick(ctx: TickContext): void {
    if (this.running) return;
    this.running = true;
    void this.run(ctx).finally(() => { this.running = false; });
  }

  async run(ctx: TickContext): Promise<void> {
    const now = this.now();
    const catalog = resolveProactiveCapabilityCatalog(this.options.capabilities, this.preferences);
    this.options.stateStore.reconcileCatalog(catalog);
    const catalogById = new Map(catalog.map(entry => [entry.id, entry]));
    const evaluations = new Map<string, ProactiveTickEvaluation>();
    const candidates: ProactiveCandidateEnvelope[] = [];
    for (const capability of this.options.capabilities) {
      const entry = catalogById.get(capability.manifest.id)!;
      if (!entry.enabled || !shouldRun(entry.rate, ctx.tick)) continue;
      const blockedUntil = this.backoffUntil.get(entry.id) ?? 0;
      if (blockedUntil > now) {
        this.options.stateStore.recordBackoff(entry.id, 'evaluation_error', blockedUntil, now);
        continue;
      }
      try {
        const evaluation = await withTimeout(
          signal => capability.implementation.evaluate({
            profileId: this.options.profileId,
            now,
            world: ctx.world,
            config: entry.config,
            foregroundBusy: this.options.isForegroundBusy(),
            signal,
          }),
          this.evaluationTimeoutMs,
        );
        evaluations.set(entry.id, evaluation);
        this.options.stateStore.recordEvaluation(entry.id, evaluation, now);
        if (evaluation.kind === 'candidate') {
          candidates.push({
            capabilityId: entry.id,
            idempotencyKey: evaluation.candidate.idempotencyKey,
            priority: entry.priority,
            capability,
            candidate: evaluation.candidate,
          });
        }
      } catch (error) {
        const until = now + this.errorBackoffMs;
        this.backoffUntil.set(entry.id, until);
        this.options.stateStore.recordBackoff(
          entry.id,
          error instanceof Error ? error.message : String(error),
          until,
          now,
        );
      }
    }
    const leaseSnapshot = this.options.leases.snapshot();
    const decision = this.options.arbiter.arbitrate({
      candidates,
      foregroundBusy: this.options.isForegroundBusy(),
      activeLease: leaseSnapshot.active,
      releaseInProgress: leaseSnapshot.releasing,
    });
    for (const suppression of decision.suppressions) {
      this.options.stateStore.recordSuppressed(suppression.capabilityId, suppression.reason);
    }
    await this.options.onArbitration(decision, evaluations);
  }
}

function shouldRun(rate: 'fast' | 'std' | 'slow' | 'idle', tick: number): boolean {
  const divisor = ({ fast: TickRate.FAST, std: TickRate.STD, slow: TickRate.SLOW, idle: TickRate.IDLE })[rate];
  return tick % divisor === 0;
}

async function withTimeout<T>(
  execute: (signal: AbortSignal) => T | Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(execute(controller.signal)),
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error(`proactive Tick evaluation timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
