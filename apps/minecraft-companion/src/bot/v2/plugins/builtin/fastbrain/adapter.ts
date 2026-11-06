import { fastBrainDecisionCatalog, parseFastBrainDecision, type FastBrainDecision } from './decisionContract.js';

export const FASTBRAIN_DECISION_SERVICE = 'fastbrain.decisions';
export type DecisionStatus = 'success' | 'partial' | 'blocked' | 'timeout' | 'cancelled' | 'error';

/** Host-only envelope. None of these fields is accepted in the policy wire input. */
export interface DecisionContext {
  readonly requestId: string;
  readonly sessionId: string;
  readonly actor: string;
  readonly dimension: string;
  readonly notBefore: number;
  readonly deadlineAt: number;
  readonly signal: AbortSignal;
  readonly isCurrent: () => boolean;
}

export interface SelfObservation {
  readonly version: string;
  readonly observedAt: number;
  readonly actor: string;
  readonly dimension: string;
  readonly scope: 'self_only';
  readonly self: Readonly<Record<string, unknown>>;
  readonly inventory: readonly Readonly<{ name: string; count: number; slot: number }>[];
  /** Missing visibility is not represented as an empty, fully searched world. */
  readonly targets: { readonly status: 'unavailable'; readonly reason: string };
  readonly evidenceRefs: readonly string[];
}

export interface DecisionReceipt {
  readonly schema: 'mineclaw.fastbrain-decision-receipt/v1';
  readonly requestId: string;
  readonly sessionId: string;
  readonly decision: string;
  readonly status: DecisionStatus;
  readonly reason?: string;
  readonly effectKnowledge: 'confirmed' | 'unknown';
  readonly evidenceRefs: readonly string[];
  readonly observation?: SelfObservation;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly outcome?: Readonly<{ verdict: 'completed' | 'blocked' | 'rejected' | 'unknown' }>;
}

export interface DecisionPort {
  catalog(): ReadonlyArray<{ name: string; schema: Record<string, unknown>; available: boolean; reason?: string }>;
  submit(decision: unknown, context: DecisionContext): Promise<DecisionReceipt>;
}

/** A declaration is never its own proof and never acquires the body. */
export interface OutcomeVerifier {
  verify(claim: Exclude<FastBrainDecision, { type: 'call' }>, context: DecisionContext): Promise<{
    readonly verdict: 'completed' | 'blocked' | 'rejected' | 'unknown';
    readonly evidenceRefs: readonly string[];
  }>;
}

export interface DecisionHandlerResult {
  readonly status: DecisionStatus;
  readonly reason?: string;
  readonly effectKnowledge: 'confirmed' | 'unknown';
  readonly evidenceRefs: readonly string[];
  readonly observation?: SelfObservation;
  readonly outcome?: DecisionReceipt['outcome'];
  readonly details?: Readonly<Record<string, unknown>>;
}
export interface DecisionHandler {
  readonly available: boolean;
  readonly reason?: string;
  /** Body handlers join their original operation result; never race away from StopAck. */
  readonly lifetime?: 'body';
  run(decision: FastBrainDecision, context: DecisionContext): Promise<DecisionHandlerResult>;
}

/**
 * Protocol dispatcher, not a second executor. Only delivered implementations
 * are registered; missing body/job/visibility contracts fail closed. In
 * particular there is no mapping from smelt to the legacy all-in-one smelter.
 */
export class FastBrainAdapter implements DecisionPort {
  private readonly handlers: ReadonlyMap<string, DecisionHandler>;
  private readonly closed = new AbortController();
  private stopped = false;

  constructor(private readonly options: {
    readonly observeSelf?: () => SelfObservation | Promise<SelfObservation>;
    readonly verifier?: OutcomeVerifier;
    readonly isActive: () => boolean;
    readonly now?: () => number;
    readonly handlers?: ReadonlyMap<string, DecisionHandler>;
  }) {
    const handlers = new Map<string, DecisionHandler>();
    for (const { name } of fastBrainDecisionCatalog()) {
      const reason = `capability_unavailable:${name}`;
      handlers.set(name, { available: false, reason, run: async () => ({
        status: 'blocked', reason, effectKnowledge: 'confirmed', evidenceRefs: [],
      }) });
    }
    if (options.observeSelf) handlers.set('observe', {
      available: true,
      run: async (_decision, context) => {
        const observation = structuredClone(await options.observeSelf!());
        validateObservation(observation);
        if (observation.actor !== context.actor || observation.dimension !== context.dimension) {
          return blocked('observation_identity_mismatch');
        }
        if (observation.observedAt < context.notBefore || observation.observedAt > this.now()) {
          return blocked('observation_stale');
        }
        return { status: 'partial', reason: observation.targets.reason, effectKnowledge: 'confirmed',
          evidenceRefs: observation.evidenceRefs, observation };
      },
    });
    if (options.verifier) for (const name of ['finish', 'report_blocked']) handlers.set(name, {
      available: true,
      run: async (decision, context) => {
        if (decision.type === 'call') throw new Error('terminal_declaration_required');
        const result = await options.verifier!.verify(decision, context);
        const expected = decision.type === 'finish' ? 'completed' : 'blocked';
        const proven = result.verdict === expected && result.evidenceRefs.length > 0;
        return { status: proven ? 'success' : 'blocked',
          ...(!proven ? { reason: 'outcome_unverified' } : {}),
          effectKnowledge: result.verdict === 'unknown' ? 'unknown' : 'confirmed',
          evidenceRefs: result.evidenceRefs, outcome: { verdict: result.verdict } };
      },
    });
    for (const [name, handler] of options.handlers ?? []) {
      if (!handlers.has(name) || name === 'finish' || name === 'report_blocked') throw new Error(`fastbrain_handler_name_invalid:${name}`);
      handlers.set(name, handler);
    }
    this.handlers = handlers;
  }

  /** The published service omits lifecycle controls and implementation dependencies. */
  port(): DecisionPort {
    return Object.freeze({ catalog: () => this.catalog(), submit: (wire: unknown, context: DecisionContext) => this.submit(wire, context) });
  }

  close(): void { this.stopped = true; this.closed.abort(); }

  catalog(): ReturnType<DecisionPort['catalog']> {
    return fastBrainDecisionCatalog().map(entry => {
      const handler = this.handlers.get(entry.name)!;
      return { ...entry, available: handler.available, ...(handler.reason ? { reason: handler.reason } : {}) };
    });
  }

  async submit(wire: unknown, host: DecisionContext): Promise<DecisionReceipt> {
    validateContext(host);
    const context = Object.freeze({ ...host });
    let name = 'invalid';
    const receipt = (result: DecisionHandlerResult): DecisionReceipt => structuredClone({
      schema: 'mineclaw.fastbrain-decision-receipt/v1', requestId: context.requestId,
      sessionId: context.sessionId, decision: name, ...result,
    });
    const unavailable = this.check(context);
    if (unavailable) return receipt(unavailable);
    let decision: FastBrainDecision;
    try { decision = parseFastBrainDecision(wire); }
    catch { return receipt({ status: 'error', reason: 'invalid_decision', effectKnowledge: 'confirmed', evidenceRefs: [] }); }
    name = decision.type === 'call' ? decision.skill : decision.type;
    const linked = new AbortController();
    const abort = () => linked.abort();
    context.signal.addEventListener('abort', abort, { once: true });
    this.closed.signal.addEventListener('abort', abort, { once: true });
    if (context.signal.aborted || this.closed.signal.aborted) linked.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = () => {
      const remaining = context.deadlineAt - this.now();
      if (remaining <= 0) linked.abort();
      else timer = setTimeout(deadline, Math.min(remaining, 2_147_483_647));
    };
    deadline();
    const handlerContext = Object.freeze({ ...context, signal: linked.signal });
    const handler = this.handlers.get(name)!;
    try {
      const work = handler.run(decision, handlerContext);
      const result = handler.lifetime === 'body' ? await work : await this.awaitHandler(work, handlerContext);
      const interrupted = this.check(context);
      // Preserve the original body's known/unknown effects and release proof.
      // Read/terminal results may instead be discarded when their context expires.
      return receipt(handler.lifetime === 'body' ? result : interrupted ?? result);
    } catch {
      if (handler.lifetime === 'body') return receipt({ status: 'error', reason: 'body_handler_result_unknown', effectKnowledge: 'unknown', evidenceRefs: [] });
      return receipt(this.check(context) ?? { status: 'error', reason: 'decision_handler_failed',
        effectKnowledge: 'unknown', evidenceRefs: [] });
    } finally {
      clearTimeout(timer);
      context.signal.removeEventListener('abort', abort);
      this.closed.signal.removeEventListener('abort', abort);
    }
  }

  private now(): number { return (this.options.now ?? Date.now)(); }
  private async awaitHandler(work: Promise<DecisionHandlerResult>, context: DecisionContext): Promise<DecisionHandlerResult> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let wake: () => void = () => undefined;
    const interrupted = new Promise<DecisionHandlerResult>(resolve => {
      const check = () => {
        const result = this.check(context);
        if (result) resolve(result);
        else timer = setTimeout(check, Math.min(context.deadlineAt - this.now(), 2_147_483_647));
      };
      wake = check;
      context.signal.addEventListener('abort', wake, { once: true });
      this.closed.signal.addEventListener('abort', wake, { once: true });
      check();
    });
    try { return await Promise.race([work, interrupted]); }
    finally {
      clearTimeout(timer);
      context.signal.removeEventListener('abort', wake);
      this.closed.signal.removeEventListener('abort', wake);
    }
  }
  private check(context: DecisionContext): DecisionHandlerResult | null {
    if (this.stopped || !this.options.isActive()) return blocked('adapter_not_active');
    if (this.now() >= context.deadlineAt) return { status: 'timeout', reason: 'decision_deadline_exceeded', effectKnowledge: 'confirmed', evidenceRefs: [] };
    if (context.signal.aborted || !context.isCurrent()) return { status: 'cancelled', reason: 'decision_context_revoked', effectKnowledge: 'confirmed', evidenceRefs: [] };
    return null;
  }
}

function blocked(reason: string): DecisionHandlerResult {
  return { status: 'blocked', reason, effectKnowledge: 'confirmed', evidenceRefs: [] };
}

function validateContext(context: DecisionContext): void {
  if (!context || ![context.requestId, context.sessionId, context.actor, context.dimension].every(value => typeof value === 'string' && value.trim())
    || !Number.isFinite(context.notBefore) || !Number.isFinite(context.deadlineAt) || context.deadlineAt <= context.notBefore
    || !context.signal || typeof context.signal.aborted !== 'boolean' || typeof context.isCurrent !== 'function') {
    throw new Error('fastbrain_host_context_invalid');
  }
}

function validateObservation(value: SelfObservation): void {
  if (!value || value.scope !== 'self_only' || !value.version || !value.actor || !value.dimension || !Number.isFinite(value.observedAt)
    || !value.self || !Array.isArray(value.inventory) || !value.inventory.every(item => Number.isInteger(item.slot) && Number.isInteger(item.count) && item.count >= 0 && typeof item.name === 'string')
    || value.targets?.status !== 'unavailable' || !value.targets.reason
    || !Array.isArray(value.evidenceRefs) || value.evidenceRefs.length === 0 || value.evidenceRefs.some(ref => typeof ref !== 'string' || !ref.trim())) {
    throw new Error('fastbrain_observation_invalid');
  }
}
