import { jsonSnapshot } from '../../infra/jsonSnapshot.js';
import { tuning } from '../../infra/tuning.js';
import type { OperationCommand, OperationIdentity, OperationSnapshot, StopAcknowledgement } from '../contracts/bodyOperation.js';
import type { OperationEffect, OperationReceipt } from '../contracts/operationReceipt.js';
import type { FailureEnvelope } from '../contracts/failureEnvelope.js';
import type { AuthorizedOperation, ExecutionClock, OperationHandle } from './ports/bodyExecution.js';
import type { BodyOperationDriver, BoundOperationExecutor, ControlledExecutionContext, OperationOutcome } from './ports/controlledExecution.js';

export class ExecutionStoppedError extends Error {
  constructor(readonly code: string, readonly stage: string) {
    super(`${code}:${stage}`);
    this.name = 'ExecutionStoppedError';
  }
}

interface Step {
  readonly id: string;
  readonly executor: BoundOperationExecutor;
  open: boolean;
  childPending: boolean;
  pendingEffects: number;
  stopWork: Promise<void> | null;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function failure(code: string, detail?: string): FailureEnvelope {
  const contract = ['authority_lost', 'child_resource_escalation', 'action_budget_exceeded', 'unjoined_work'].includes(code);
  const category = contract ? 'contract' : ['deadline_exceeded', 'stop_unconfirmed'].includes(code) ? 'timeout'
    : ['operation_failed', 'stop_failed'].includes(code) ? 'fatal' : 'cancelled';
  return { code, origin: contract ? 'contract' : 'infra', stage: 'executing', category,
    retryable: false, ownerActionable: false, evidenceRefs: [], ...(detail ? { detail } : {}) };
}

/** One operation's work/cleanup tree. Resource ownership belongs exclusively to BodyExecutionRuntime. */
export class OperationLifetime {
  readonly handle: OperationHandle;
  private readonly controller = new AbortController();
  private readonly result = deferred<OperationReceipt>();
  private readonly drained = deferred<StopAcknowledgement>();
  private readonly steps = new Set<Step>();
  private readonly effects: OperationEffect[] = [];
  private readonly stopErrors: string[] = [];
  private readonly startedAt: number;
  private state: OperationSnapshot['state'] = 'running';
  private pending = 0;
  private actionsStarted = 0;
  private effectsStarted = 0;
  private stepSeq = 0;
  private gateClosed = false;
  private rootFinished = false;
  private published = false;
  private cancelReason: string | null = null;
  private stop: StopAcknowledgement | null = null;
  private outcome: OperationOutcome = { ok: false };
  private deadlineTimer: unknown;
  private stopTimer: unknown;

  constructor(private readonly options: {
    identity: OperationIdentity;
    operation: AuthorizedOperation;
    resources: readonly string[];
    driver: BodyOperationDriver;
    clock: ExecutionClock;
    isCurrent(command: OperationCommand): boolean;
    onQuiesced(): void;
  }) {
    this.startedAt = options.clock.now();
    this.handle = Object.freeze({ operationId: options.identity.operationId, result: this.result.promise,
      cancel: (reason: string) => this.cancel(reason), quiesced: () => this.drained.promise });
  }

  start(): void {
    const { clock, identity, operation } = this.options;
    this.deadlineTimer = clock.setTimeout(() => this.cancel('deadline_exceeded'), identity.deadlineAt - clock.now());
    // Defer run, so the runtime installs ownership before any effect is possible.
    void Promise.resolve().then(() => this.executeStep(operation.intent.command, 'root')).then(
      outcome => { this.outcome = outcome; },
      error => { this.outcome = { ok: false, failure: failure(error instanceof ExecutionStoppedError ? error.code : 'operation_failed', String(error)) }; },
    ).then(() => {
      this.rootFinished = true;
      this.closeGate();
      this.stopAll();
      this.tryDrain();
    });
  }

  snapshot(): OperationSnapshot {
    return jsonSnapshot({ ...this.options.identity, state: this.state, resources: this.options.resources,
      actionsStarted: this.actionsStarted, pendingWork: this.pending, cancelReason: this.cancelReason,
      stopErrors: this.stopErrors, stop: this.stop });
  }

  cancel(reason: string): void {
    if (this.stop || this.cancelReason) return;
    this.cancelReason = reason || 'cancelled';
    if (this.state !== 'quarantined') this.state = 'cancelling';
    this.closeGate();
    this.stopAll();
    this.tryDrain();
  }

  private closeGate(): void {
    if (!this.gateClosed) {
      this.gateClosed = true;
      this.controller.abort(new ExecutionStoppedError(this.cancelReason ?? 'operation_closed', 'signal'));
      if (this.deadlineTimer !== undefined) this.options.clock.clearTimeout(this.deadlineTimer);
    }
    if (this.stopTimer === undefined && !this.stop) {
      const timeout = tuning().controlledExecution.stopConfirmTimeoutMs;
      if (!Number.isFinite(timeout) || timeout < 0) {
        this.stopErrors.push('invalid_stop_timeout');
        this.quarantine();
      } else this.stopTimer = this.options.clock.setTimeout(() => this.quarantine(), timeout);
    }
  }

  private assertCurrent(command: OperationCommand, stage: string, step?: Step): void {
    if (this.gateClosed || step && !step.open) throw new ExecutionStoppedError(this.cancelReason ?? 'operation_closed', stage);
    if (this.options.clock.now() >= this.options.identity.deadlineAt) {
      this.cancel('deadline_exceeded');
      throw new ExecutionStoppedError('deadline_exceeded', stage);
    }
    let current = false;
    try { current = this.options.isCurrent(command); } catch { /* Fail closed. */ }
    if (!current) {
      this.cancel('authority_lost');
      throw new ExecutionStoppedError('authority_lost', stage);
    }
  }

  private consumeBudget(): void {
    const configured = tuning().controlledExecution.maxSubActions;
    const maximum = Math.min(configured, this.options.operation.intent.budget.maxActions);
    if (!Number.isSafeInteger(maximum) || maximum < 1 || this.actionsStarted >= maximum) {
      this.cancel('action_budget_exceeded');
      throw new ExecutionStoppedError('action_budget_exceeded', 'before_step');
    }
    this.actionsStarted++;
  }

  private executeStep(input: OperationCommand, id: string): Promise<OperationOutcome> {
    let command: OperationCommand;
    let step: Step;
    try {
      command = jsonSnapshot(input);
      this.assertCurrent(command, 'before_step');
      const resources = this.options.driver.resources(command);
      if (!Array.isArray(resources) || resources.some(resource => !this.options.resources.includes(resource))) {
        this.cancel('child_resource_escalation');
        throw new ExecutionStoppedError('child_resource_escalation', 'before_step');
      }
      this.consumeBudget();
      const executor = this.options.driver.bind(this.options.identity, command);
      if (!executor || typeof executor.run !== 'function' || typeof executor.stop !== 'function') throw new Error('invalid_operation_executor');
      step = { id, executor, open: true, childPending: false, pendingEffects: 0, stopWork: null };
      this.steps.add(step);
    } catch (error) { return Promise.reject(error); }
    const context = this.context(step, command);
    // Track even forgotten child promises. Neither cancellation nor result publication drops them.
    return this.track(async () => {
      try {
        this.assertCurrent(command, 'before_run', step);
        const outcome = jsonSnapshot(await step.executor.run(context));
        if (!outcome || typeof outcome.ok !== 'boolean') throw new Error('invalid_operation_outcome');
        if (step.childPending || step.pendingEffects > 0) this.cancel('unjoined_work');
        this.assertCurrent(command, 'after_run', step);
        return outcome;
      } finally {
        step.open = false;
        if (id === 'root') this.closeGate();
        // A child's cleanup must finish before its parent may start the next child.
        await this.stopStep(step);
      }
    });
  }

  private context(step: Step, command: OperationCommand): ControlledExecutionContext {
    const assertCurrent = (stage = 'checkpoint') => this.assertCurrent(command, stage, step);
    return Object.freeze({ ...this.options.identity, stepId: `${this.options.identity.operationId}/${step.id}`,
      command, scope: this.options.operation.intent.scope, signal: this.controller.signal, assertCurrent,
      execute: (child: OperationCommand) => {
        assertCurrent('before_child');
        if (step.childPending) throw new Error('concurrent_children_not_supported');
        step.childPending = true;
        const work = this.executeStep(child, `${step.id}/${++this.stepSeq}`);
        // Attach both handlers, without introducing an unobserved rejected finally-promise.
        void work.then(() => { step.childPending = false; }, () => { step.childPending = false; });
        return work;
      },
      effect: <T>(run: () => T | PromiseLike<T>): Promise<T> => {
        assertCurrent('before_effect');
        if (step.childPending) throw new Error('parent_effect_during_child');
        this.effectsStarted++;
        return this.trackEffect(step, async () => {
          assertCurrent('effect_dispatch');
          const value = await run();
          assertCurrent('after_effect');
          return value;
        });
      },
      wait: (ms: number) => {
        assertCurrent('before_wait');
        if (!Number.isFinite(ms) || ms < 0) throw new Error('invalid_execution_wait');
        return this.trackEffect(step, () => new Promise<void>((resolve, reject) => {
          const signal = this.controller.signal;
          const abort = () => { this.options.clock.clearTimeout(timer); reject(signal.reason); };
          const timer = this.options.clock.setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
          signal.addEventListener('abort', abort, { once: true });
          if (signal.aborted) { signal.removeEventListener('abort', abort); abort(); }
        }));
      },
      recordEffect: (effect: OperationEffect) => {
        if (this.stop) throw new Error('effect_after_quiescence');
        const copy = jsonSnapshot(effect);
        if (!copy.predicate?.id || !copy.predicate.version || !Array.isArray(copy.evidenceRefs)) throw new Error('invalid_operation_effect');
        this.effects.push(copy);
      },
    });
  }

  private track<T>(run: () => T | PromiseLike<T>): Promise<T> {
    this.pending++;
    const work = Promise.resolve().then(run);
    void work.then(() => { this.pending--; this.tryDrain(); }, () => { this.pending--; this.tryDrain(); });
    return work;
  }

  private trackEffect<T>(step: Step, run: () => T | PromiseLike<T>): Promise<T> {
    step.pendingEffects++;
    const work = this.track(run);
    void work.then(() => { step.pendingEffects--; }, () => { step.pendingEffects--; });
    return work;
  }

  private stopAll(): void {
    for (const step of this.steps) this.stopStep(step);
  }

  private stopStep(step: Step): Promise<void> {
    if (step.stopWork) return step.stopWork;
    this.pending++;
    const work = Promise.resolve().then(() => step.executor.stop(this.cancelReason ?? 'completed'));
    step.stopWork = work;
    void work.then(
      () => { this.pending--; this.tryDrain(); },
      error => {
        this.pending--;
        this.stopErrors.push(`${step.id}:${String(error)}`);
        this.cancel('stop_failed');
        this.quarantine();
      },
    );
    return work;
  }

  private tryDrain(): void {
    if (this.stop || !this.rootFinished || this.pending !== 0 || this.stopErrors.length) return;
    this.closeGate();
    this.stop = jsonSnapshot({ ...this.options.identity, state: 'quiesced', at: this.options.clock.now() });
    if (this.stopTimer !== undefined) this.options.clock.clearTimeout(this.stopTimer);
    this.state = 'settled';
    this.options.onQuiesced();
    this.drained.resolve(this.stop);
    this.publish(this.cancelReason ? 'cancelled' : this.outcome.ok ? 'succeeded' : 'failed');
  }

  private quarantine(): void {
    if (this.stop) return;
    this.state = 'quarantined';
    this.publish('in_doubt');
  }

  private publish(status: OperationReceipt['status']): void {
    if (this.published) return;
    this.published = true;
    const observedFailure = this.cancelReason ? failure(this.cancelReason) : this.outcome.failure
      ?? (status === 'in_doubt' ? failure('stop_unconfirmed', this.stopErrors.join('; ')) : undefined);
    this.result.resolve(jsonSnapshot({ ...this.options.identity, schema: 'mineclaw.operation-receipt/v2', status,
      stop: this.stop, noOp: this.effectsStarted === 0 && this.effects.length === 0,
      effects: this.effects, evidenceRefs: [...new Set(this.effects.flatMap(effect => effect.evidenceRefs))],
      ...(observedFailure ? { failure: observedFailure } : {}), ...(this.outcome.details ? { details: this.outcome.details } : {}),
      startedAt: this.startedAt, completedAt: this.options.clock.now() }));
  }
}
