import type { GameTickObservation } from '../../../../adapter/GameTickObservation.js';
import type { DecisionContext, DecisionReceipt, SelfObservation } from './adapter.js';
import type { FastBrainDecision } from './decisionContract.js';
import type { FastBrainPendingRequests } from './pendingRequests.js';

type Result = Pick<DecisionReceipt, 'status' | 'reason' | 'effectKnowledge' | 'evidenceRefs' | 'observation' | 'details'>;
function no(status: Result['status'], reason: string): Result {
  return { status, reason, effectKnowledge: 'confirmed', evidenceRefs: [] };
}
export function createFastBrainWaitHandler(game: unknown, pending?: Pick<FastBrainPendingRequests,'watch'>) {
  if (!game) return undefined;
  const readTarget = typeof (game as {getTarget?: unknown}).getTarget === 'function'
    ? () => (game as {getTarget(): unknown}).getTarget() : () => game;
  if (readTarget() === game && typeof (game as Partial<GameTickObservation>).waitForGameTicks !== 'function') return undefined;
  return { available: true, async run(decision: FastBrainDecision, context: DecisionContext): Promise<Result> {
    if (decision.type !== 'call' || decision.skill !== 'wait') return no('blocked', 'wrong_wait_decision');
    const { request_id, job_id, event, max_ticks } = decision.args;
    // Neither a generic tick nor a clock deadline proves a job/request terminal.
    if (job_id !== undefined) return no('blocked', 'scoped_wait_source_unavailable');
    const watch = typeof request_id === 'string' ? pending?.watch(request_id,context) : undefined;
    if (request_id !== undefined && !watch) return no('blocked', 'no_matching_live_request');
    if (event !== undefined && event !== 'health') return no('blocked', 'unsupported_wait_event');
    if (typeof max_ticks !== 'number' || !Number.isSafeInteger(max_ticks) || max_ticks < 1) return no('blocked', 'invalid_wait_ticks');
    const source = readTarget() as Partial<GameTickObservation> | null;
    if (!source?.waitForGameTicks) return no('blocked', 'game_ticks_unavailable');
    const tick = await source.waitForGameTicks({ actor: context.actor, dimension: context.dimension, maxTicks: max_ticks,
      event, arrived:watch ? () => !!watch() : undefined, deadlineAt: context.deadlineAt, signal: context.signal, isCurrent: () => context.isCurrent() && readTarget() === source });
    if (tick.kind === 'unavailable') return no('blocked', 'game_ticks_unavailable');
    if (tick.kind === 'revoked' || !tick.stillCurrent()) return no('cancelled', 'wait_identity_revoked');
    if (tick.kind === 'expired') return no('timeout', 'wait_deadline');
    if (!tick.self || !tick.inventory || tick.at < context.notBefore || tick.at > Date.now()) return no('blocked', 'wait_observation_unverified');
    const ref = JSON.stringify(['game_wait', context.sessionId, context.requestId, tick.kind, tick.ticks, tick.at]);
    const observation: SelfObservation = { version: ref, observedAt: tick.at, actor: context.actor, dimension: context.dimension,
      scope: 'self_only', self: tick.self, inventory: tick.inventory, targets: { status: 'unavailable', reason: 'wait_observes_self_only' }, evidenceRefs: [ref] };
    const timedOut = (event !== undefined || !!watch) && tick.kind !== 'event';
    const original = watch && !timedOut ? watch() : undefined;
    if (watch && !timedOut && !original) return no('blocked','wait_identity_revoked');
    return { status: timedOut ? 'timeout' : 'success', reason: timedOut ? 'wait_event_not_observed' : original ? 'original_receipt_observed'
      : tick.kind === 'event' ? 'health_event_observed' : 'wait_ticks_elapsed',
      effectKnowledge: original?.effectKnowledge ?? 'confirmed', evidenceRefs: [ref,...(original?.evidenceRefs ?? [])], observation,
      ...(original ? {details:{targetRequestId:request_id,originalStatus:original.status,originalReason:original.reason}} : {}) };
  } };
}
