import type { DecisionContext, DecisionHandler, DecisionHandlerResult } from './adapter.js';

interface Pending { context: DecisionContext; abort: AbortController; result: Promise<DecisionHandlerResult>; dispatched: boolean; settled?: DecisionHandlerResult }
const blocked = (reason: string): DecisionHandlerResult => ({ status: 'blocked', reason, effectKnowledge: 'confirmed', evidenceRefs: [] });
/** Transient handles only; durable identity, replay and effects remain with the Body ledger. */
export class FastBrainPendingRequests {
  private readonly live = new Map<string, Pending>();

  /** Look up once; a later reuse of the id cannot satisfy this observation. */
  watch(id: string, caller: DecisionContext): (() => DecisionHandlerResult | undefined) | null {
    const entry = this.live.get(id);
    if (!entry || id === caller.requestId || entry.context.sessionId !== caller.sessionId || entry.context.actor !== caller.actor
      || entry.context.dimension !== caller.dimension || caller.signal.aborted
      || !caller.isCurrent() || !entry.context.isCurrent()) return null;
    return () => !caller.signal.aborted && entry.context.isCurrent() && caller.isCurrent()
      ? entry.settled && structuredClone(entry.settled) : undefined;
  }

  wrap(handler: DecisionHandler): DecisionHandler {
    if (handler.lifetime !== 'body') throw new Error('body_handler_required');
    return { ...handler, run: (decision, context) => {
      if (this.live.has(context.requestId)) return Promise.resolve(blocked('request_already_in_flight'));
      const abort = new AbortController();
      const signal = AbortSignal.any([context.signal, abort.signal]);
      const result: Promise<DecisionHandlerResult> = Promise.resolve().then(() => {
        if (signal.aborted || !context.isCurrent()) return { status:'cancelled', reason:'before_dispatch', effectKnowledge:'confirmed', evidenceRefs: [] };
        if (Date.now() >= context.deadlineAt) return { status:'timeout', reason:'before_dispatch_deadline', effectKnowledge:'confirmed', evidenceRefs: [] };
        entry.dispatched = true;
        return handler.run(decision, { ...context, signal });
      });
      const entry: Pending = { context, abort, result, dispatched:false };
      this.live.set(context.requestId, entry);
      return result.then(value => { entry.settled=structuredClone(value); return value; }, error => {
        entry.settled={status:'error',reason:'original_handler_rejected',effectKnowledge:'unknown',evidenceRefs:[]}; throw error;
      }).finally(() => { if (this.live.get(context.requestId) === entry) this.live.delete(context.requestId); });
    } };
  }

  cancelHandler(): DecisionHandler {
    return { available:true, lifetime:'body', run: async (decision, caller) => {
      if (decision.type !== 'call' || decision.skill !== 'cancel') return blocked('wrong_cancel_decision');
      const targetId = decision.args.request_id;
      const original = typeof targetId === 'string' && targetId !== caller.requestId ? this.live.get(targetId) : null;
      if (!original || original.context.sessionId !== caller.sessionId || original.context.actor !== caller.actor
        || original.context.dimension !== caller.dimension || !caller.isCurrent() || !original.context.isCurrent()
        || caller.signal.aborted || original.context.signal.aborted) return blocked('no_matching_live_request');
      original.abort.abort();
      const result = await original.result;
      if (caller.signal.aborted || !caller.isCurrent() || !original.context.isCurrent() || Date.now() >= caller.deadlineAt) {
        return { status:'partial', reason:'cancellation_context_revoked', effectKnowledge:result.effectKnowledge,
          evidenceRefs:result.evidenceRefs, details:{ targetRequestId:targetId, originalStatus:result.status,
            stop:result.details?.stop ?? null, effects:result.details?.effects ?? null } };
      }
      if (!original.dispatched) return { status:'success', reason:'cancelled_before_dispatch', effectKnowledge:'confirmed',
        evidenceRefs:[], details:{ targetRequestId:targetId, dispatched:false } };
      const stop = result.details?.stop as { state?:unknown; operationId?:unknown; leaseRef?:unknown; at?:unknown } | null | undefined;
      if (!stop || stop.state !== 'quiesced' || stop.operationId !== targetId || typeof stop.leaseRef !== 'string'
        || !stop.leaseRef || typeof stop.at !== 'number' || !Number.isFinite(stop.at)) {
        return { status:'partial', reason:'original_stop_unconfirmed', effectKnowledge:'unknown',
          evidenceRefs:result.evidenceRefs, details:{ targetRequestId:targetId, originalStatus:result.status } };
      }
      return { status: result.status === 'cancelled' ? 'success' : 'partial',
        reason: result.status === 'cancelled' ? 'original_request_quiesced' : 'original_settled_during_cancel',
        effectKnowledge:result.effectKnowledge, evidenceRefs:result.evidenceRefs,
        details:{ targetRequestId:targetId, stop, originalStatus:result.status, effects:result.details?.effects ?? null } };
    } };
  }
}
