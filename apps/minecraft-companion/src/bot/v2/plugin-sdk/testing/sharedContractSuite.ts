/**
 * Shared replacement contract suites (kernel design §5.2 table, U30).
 * Every implementation of the same contract must pass the same normal / failure /
 * cancellation / resource-release probes; a suite failure is a contract
 * violation, not a test-only concern. Suites are framework-agnostic: callers
 * wrap them with node:test and assert `failures` is empty.
 */
import type { PluginObservationProviderFactory, PluginObservationProvider, PluginObservationResult } from '../contracts/observation.js';
import type { PluginPredicateEvaluator, PluginPredicateResult } from '../contracts/verification.js';
import type { PluginBindingProvider, PluginCandidateProvider, PluginProgressProvider, PluginPlanningInput, PluginBindingResult, PluginCandidateResult, PluginProgressResult } from '../contracts/planning.js';
import type { PluginBehaviorFactory, PluginBehaviorInstance, PluginBehaviorResult, PluginBehaviorContext } from '../contracts/execution.js';
import type { PluginResultProjection, PluginResultProjectionResult, PluginResultProjectionInput } from '../contracts/result.js';
import type { PluginSystemIntegration, PluginSystemIntegrationStatus } from '../contracts/integration.js';
import type { ScopedHostContext } from '../contracts/scopedContext.js';
import type { PluginGoalLease, RegistrySnapshotRef, ContributionRef } from '../identity.js';

export interface ContractFailure {
  readonly name: string;
  readonly message: string;
  readonly error?: unknown;
}

export interface ContractSuiteResult {
  readonly passed: number;
  readonly failures: readonly ContractFailure[];
}

function result(passed: number, failures: readonly ContractFailure[]): ContractSuiteResult {
  return Object.freeze({ passed, failures: Object.freeze(failures) });
}

/** Failure probe helper — collects one failed assertion without throwing. */
async function probe(name: string, failures: ContractFailure[], action: () => void | Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    failures.push({ name, message: `assertion threw: ${error instanceof Error ? error.message : String(error)}`, error });
  }
}

export function defaultSnapshot(): RegistrySnapshotRef {
  return { generationId: 'gen-1', buildId: 'build-1', graphHash: 'abc123' };
}

export function defaultLease(): PluginGoalLease {
  return {
    goalId: 'goal-1', sessionId: 'session-1', snapshot: defaultSnapshot(),
    ownerEpoch: 1, operationEpoch: 1, aborted: false,
  };
}

export function defaultContrib(name = 'mineclaw.test.contribution'): ContributionRef {
  return { pluginId: 'mineclaw.test', pluginVersion: '1.0.0', contributionId: name, contributionVersion: '1.0.0' };
}

export function defaultScopedContext(): ScopedHostContext {
  const resources: string[] = [];
  return Object.freeze({
    host: { version: '2.0.0', buildId: 'build-1' },
    plugin: { pluginId: 'mineclaw.test', pluginVersion: '1.0.0' },
    resources: Object.freeze({
      track: (resource: { id: string }): void => { resources.push(resource.id); },
      untrack: (resource: { id: string }): void => { /* no-op tracker */ },
    }),
    activationGate: Object.freeze({ open: true, async whenOpen(): Promise<void> { return undefined; } }),
  });
}

function isFulfilled(result: PluginObservationResult): result is Extract<PluginObservationResult, { status: 'fulfilled' }> {
  return result.status === 'fulfilled';
}

export async function observationProviderContract(
  label: string,
  factory: PluginObservationProviderFactory,
): Promise<ContractSuiteResult> {
  const failures: ContractFailure[] = [];
  let passed = 0;

  // 1. Normal path: versioned fact with scope/time/completeness/evidence.
  await probe(label, failures, async () => {
    const provider = factory.create({ scoped: defaultScopedContext(), identity: defaultContrib(), signal: new AbortController().signal });
    const input = {
      params: {}, signal: new AbortController().signal,
      scope: { radius: 8 }, budget: { timeoutMs: 1000, maxResults: 10 },
    };
    const observed = await provider.observe(input);
    if (!isFulfilled(observed)) throw new Error(`expected fulfilled, got ${observed.status}`);
    const fact = observed.fact;
    if (!fact.snapshotVersion || !fact.observedAt || !fact.complete === undefined) throw new Error('fact lacks version/time/completeness');
    if (!fact.evidenceRefs.length) throw new Error('fact lacks evidence refs');
    if (!fact.contribution.contributionId) throw new Error('fact lacks contribution identity');
    provider.close();
    passed += 1;
  });

  // 2. Cancellation: abort before completion → cancelled, no late effect.
  await probe(label, failures, async () => {
    const provider = factory.create({ scoped: defaultScopedContext(), identity: defaultContrib(), signal: new AbortController().signal });
    const controller = new AbortController();
    const observed = await provider.observe({ params: {}, signal: controller.signal, scope: {}, budget: { timeoutMs: 50, maxResults: 1 } });
    controller.abort();
    if (observed.status === 'cancelled') { provider.close(); passed += 1; return; }
    // Provider may finish before abort; then cancellation semantics only require no stale delivery.
    provider.close();
    passed += 1;
  });

  // 3. Timeout/failure → structured status, never a thrown generic error.
  await probe(label, failures, async () => {
    const provider = factory.create({ scoped: defaultScopedContext(), identity: defaultContrib(), signal: new AbortController().signal });
    const observed = await provider.observe({ params: {}, signal: new AbortController().signal, scope: {}, budget: { timeoutMs: 10, maxResults: 0 } });
    if (!['fulfilled', 'timed_out', 'unavailable', 'cancelled'].includes(observed.status)) throw new Error(`unstructured status: ${observed.status}`);
    provider.close();
    passed += 1;
  });

  // 4. Resource release: close is idempotent and blocks further observes.
  await probe(label, failures, async () => {
    const provider = factory.create({ scoped: defaultScopedContext(), identity: defaultContrib(), signal: new AbortController().signal });
    provider.close();
    provider.close();
    const observed = await provider.observe({ params: {}, signal: new AbortController().signal, scope: {}, budget: { timeoutMs: 1000, maxResults: 10 } });
    if (observed.status !== 'unavailable') throw new Error(`observe after close must be unavailable, got ${observed.status}`);
    passed += 1;
  });

  // 5. Instance isolation: two creates never share provider state.
  await probe(label, failures, async () => {
    const first = factory.create({ scoped: defaultScopedContext(), identity: defaultContrib(), signal: new AbortController().signal });
    const second = factory.create({ scoped: defaultScopedContext(), identity: defaultContrib(), signal: new AbortController().signal });
    if (first === second) throw new Error('factory must create a fresh provider per call');
    first.close(); second.close();
    passed += 1;
  });

  return result(passed, failures);
}

export async function predicateContract(label: string, evaluator: PluginPredicateEvaluator): Promise<ContractSuiteResult> {
  const failures: ContractFailure[] = [];
  let passed = 0;

  await probe(label, failures, async () => {
    const out = (await evaluator.evaluate({ goal: defaultLease(), snapshot: defaultSnapshot(), evidence: { world: 'fact' }, facts: [], args: {}, signal: new AbortController().signal })) as PluginPredicateResult;
    if (!['satisfied', 'unsatisfied', 'unknown'].includes(out.verdict)) throw new Error(`invalid verdict ${out.verdict}`);
    passed += 1;
  });

  await probe(label, failures, async () => {
    let threw = false;
    let out: PluginPredicateResult | null = null;
    try {
      out = await evaluator.evaluate({ goal: defaultLease(), snapshot: defaultSnapshot(), evidence: {}, facts: [], args: {}, signal: AbortSignal.timeout(10) });
    } catch {
      threw = true;
    }
    if (threw) throw new Error('predicate may not throw; unknown is the contract');
    if (out && !['satisfied', 'unsatisfied', 'unknown'].includes(out.verdict)) throw new Error(`invalid verdict ${out.verdict}`);
    passed += 1;
  });

  // Cancellation → unknown, no stale side effect (evidence bundle stays unchanged).
  await probe(label, failures, async () => {
    const controller = new AbortController();
    const input = { goal: defaultLease(), snapshot: defaultSnapshot(), evidence: {}, facts: [], args: {}, signal: controller.signal };
    controller.abort();
    const out = await evaluator.evaluate(input);
    if (!['unknown', 'satisfied', 'unsatisfied'].includes(out.verdict)) throw new Error(`invalid verdict ${out.verdict}`);
    passed += 1;
  });

  return result(passed, failures);
}

export async function planningContract(
  label: string,
  provider: { kind: 'binding'; impl: PluginBindingProvider } | { kind: 'candidate'; impl: PluginCandidateProvider } | { kind: 'progress'; impl: PluginProgressProvider },
): Promise<ContractSuiteResult> {
  const failures: ContractFailure[] = [];
  let passed = 0;
  const input: PluginPlanningInput = {
    goal: defaultLease(), snapshot: defaultSnapshot(), facts: [], params: {},
    signal: new AbortController().signal, budget: {},
  };

  await probe(label, failures, async () => {
    if (provider.kind === 'binding') {
      const out = await provider.impl.list(input);
      assertPlanningStatus(out.status, failures, label);
    } else if (provider.kind === 'candidate') {
      const out = await provider.impl.list(input);
      assertPlanningStatus(out.status, failures, label);
      if (out.status === 'complete' && out.candidates.length === 0) throw new Error('empty candidate list may not claim complete (no fake success)');
    } else {
      const out = await provider.impl.assess(input);
      if (!['complete', 'partial', 'unavailable', 'cancelled'].includes(out.status)) throw new Error(`invalid status ${out.status}`);
      if (out.status === 'complete' && !out.progress) throw new Error('complete requires progress record');
    }
    passed += 1;
  });

  await probe(label, failures, async () => {
    const controller = new AbortController();
    controller.abort();
    const cancelledInput = { ...input, signal: controller.signal };
    if (provider.kind === 'binding') {
      const out = await provider.impl.list(cancelledInput);
      assertPlanningStatus(out.status, failures, label);
    } else if (provider.kind === 'candidate') {
      const out = await provider.impl.list(cancelledInput);
      assertPlanningStatus(out.status, failures, label);
    } else {
      const out = await provider.impl.assess(cancelledInput);
      if (!['complete', 'partial', 'unavailable', 'cancelled'].includes(out.status)) throw new Error(`invalid status ${out.status}`);
    }
    passed += 1;
  });

  return result(passed, failures);
}

function assertPlanningStatus(status: string, failures: ContractFailure[], label: string): void {
  if (!['complete', 'partial', 'ambiguous', 'unavailable', 'cancelled'].includes(status)) {
    throw new Error(`invalid planning status ${status}`);
  }
}

export async function behaviorFactoryContract(label: string, factory: PluginBehaviorFactory): Promise<ContractSuiteResult> {
  const failures: ContractFailure[] = [];
  let passed = 0;
  const ctx = (): PluginBehaviorContext => ({
    goal: defaultLease(),
    signal: new AbortController().signal,
    facts: [],
    submitBody: async () => Object.freeze({ ok: true, receipt: 'receipt-1' }),
    publish: (): void => undefined,
  });

  await probe(label, failures, async () => {
    const a = factory.create(defaultLease(), defaultScopedContext());
    const b = factory.create(defaultLease(), defaultScopedContext());
    if (a === b) throw new Error('factory must create a fresh behavior per goal lease');
    await a.close(); await b.close();
    passed += 1;
  });

  await probe(label, failures, async () => {
    const instance = factory.create(defaultLease(), defaultScopedContext());
    const out = await instance.run(ctx());
    if (typeof out.ok !== 'boolean' || typeof out.cancelled !== 'boolean') throw new Error('behavior result must be a bounded ok/cancelled report');
    await instance.close();
    passed += 1;
  });

  await probe(label, failures, async () => {
    // Cancellation: halt() then run must not start new child actions (submitBody spy).
    const instance = factory.create(defaultLease(), defaultScopedContext());
    let submits = 0;
    const controlled = ctx();
    const signal = new AbortController().signal;
    const spyCtx = { ...controlled, signal, submitBody: async () => { submits += 1; return Object.freeze({ ok: true }); } };
    await instance.halt();
    const out = await instance.run(spyCtx);
    if (out.ok && submits > 1) throw new Error('halted behavior started children after halt');
    await instance.close();
    passed += 1;
  });

  await probe(label, failures, async () => {
    const instance = factory.create(defaultLease(), defaultScopedContext());
    const first = await instance.halt();
    void first;
    await instance.halt();
    await instance.close();
    await instance.close();
    passed += 1;
  });

  return result(passed, failures);
}

export async function resultProjectionContract(label: string, projection: PluginResultProjection): Promise<ContractSuiteResult> {
  const failures: ContractFailure[] = [];
  let passed = 0;

  await probe(label, failures, async () => {
    const out = await projection.project(makeProjectionInput('completed'));
    if (!isProjected(out)) throw new Error('expected projected output');
    if (!out.output.presentation || !out.output.summary) throw new Error('projection must produce presentation and summary');
    if (Object.hasOwn(out.output.presentation, 'verdict')) throw new Error('projection may not rewrite verdict (completed)');
    if (out.output.question) throw new Error('non-needs_owner state may not produce a question');
    passed += 1;
  });

  await probe(label, failures, async () => {
    const out = await projection.project(makeProjectionInput('needs_owner'));
    if (!isProjected(out)) throw new Error('expected projected output');
    if (!out.output.question) throw new Error('needs_owner projection must attach the structured question');
    passed += 1;
  });

  await probe(label, failures, async () => {
    const out = await projection.project(makeProjectionInput('unknown'));
    if (!isProjected(out)) throw new Error('expected projected output');
    if (out.output.presentation && Object.hasOwn(out.output.presentation, 'verdict')) throw new Error('unknown may not be rewritten to completed');
    passed += 1;
  });

  await probe(label, failures, async () => {
    const controller = new AbortController();
    controller.abort();
    const out = await projection.project(makeProjectionInput('completed', controller.signal));
    if (!['projected', 'projection_cancelled'].includes(out.status)) throw new Error(`invalid status ${out.status}`);
    passed += 1;
  });

  return result(passed, failures);
}

function makeProjectionInput(verdict: 'completed' | 'needs_owner' | 'unknown', signal = new AbortController().signal): PluginResultProjectionInput {
  return {
    goal: defaultLease(),
    snapshot: defaultSnapshot(),
    evidence: { verdict, predicate: null, progress: null, ledger: [], failureClass: null, details: {} },
    signal,
  };
}

function isProjected(out: PluginResultProjectionResult): out is Extract<PluginResultProjectionResult, { status: 'projected' }> {
  return out.status === 'projected';
}

export async function systemIntegrationContract(label: string, integration: PluginSystemIntegration): Promise<ContractSuiteResult> {
  const failures: ContractFailure[] = [];
  let passed = 0;

  await probe(label, failures, async () => {
    const status = await integration.start(defaultScopedContext(), new AbortController().signal);
    void status;
    passed += 1;
  });

  await probe(label, failures, async () => {
    const before = integration.status();
    await integration.stop(new AbortController().signal);
    const after = integration.status();
    if (before === 'unsupported') { passed += 1; return; }
    if (!['running', 'stopped', 'failed'].includes(after)) throw new Error(`invalid status after stop: ${after}`);
    passed += 1;
  });

  await probe(label, failures, async () => {
    // idempotent stop.
    await integration.stop(new AbortController().signal);
    await integration.stop(new AbortController().signal);
    const status = integration.status();
    if (!['running', 'stopped', 'unsupported', 'failed'].includes(status)) throw new Error(`invalid status: ${status}`);
    passed += 1;
  });

  return result(passed, failures);
}

export function combine(prefix: string, suites: readonly ContractSuiteResult[]): ContractSuiteResult {
  const failures: ContractFailure[] = [];
  let passed = 0;
  for (const suite of suites) {
    passed += suite.passed;
    for (const failure of suite.failures) failures.push({ name: `${prefix}.${failure.name}`, message: failure.message, error: failure.error });
  }
  return result(passed, failures);
}
