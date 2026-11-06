import type { DecisionContext, OutcomeVerifier } from './adapter.js';
import { assertGoalContractV2 } from '../../../task/contracts/goalContractV2.js';
import type { GoalAgentStateV1 } from '../../../task/goalAgent/goalAgentState.js';
import type { GoalAgentVerificationPort } from '../../../task/goalAgent/ports/verificationPort.js';
import type { WorldStateView } from '../../../types.js';

/** Host-owned readers only: no policy evidence, task writes or parallel ledger. */
export interface FastBrainOutcomeSource {
  read(sessionId: string): Readonly<GoalAgentStateV1> | null;
  verifyRoot: GoalAgentVerificationPort['verifyRoot'];
  getWorld(): WorldStateView | null;
  getActor(): string | undefined;
}

/**
 * Reuse the production goal verifier, rather than translating a declaration
 * into a task result. Terminal contexts carry the ORIGINAL task request ID
 * and exact GoalAgent session ID, not an arbitrary body-action request ID.
 *
 * A failed action, an unsatisfied goal, or the policy's reason/evidence is not
 * proof that a task is correctly blocked. Until a production blockage
 * adjudicator exists, report_blocked can be contradicted but not confirmed.
 */
export function createFastBrainOutcomeVerifier(
  source: FastBrainOutcomeSource,
  now: () => number = Date.now,
): OutcomeVerifier {
  const verifier: OutcomeVerifier = {
    verify: async (claim, context) => {
      if (!current(context, now())) return unknown();
      const snapshot = source.read(context.sessionId);
      if (!snapshot) return unknown();
      const state = structuredClone(snapshot);
      const root = state.rootGoal;
      if (state.sessionId !== context.sessionId || state.requestId !== context.requestId
        || state.request.meta.messageId !== context.requestId || source.getActor() !== context.actor) {
        return rejected();
      }
      if (!root || root.schema !== 'mineclaw.goal/v2' || state.phase === 'needs_rebind') return unknown();
      assertGoalContractV2(root);
      if (root.requestRef !== context.requestId || root.scope.dimension !== context.dimension) return rejected();
      if (!state.snapshotRef || !sameSnapshot(state.snapshotRef, root.source.snapshot)) return unknown();
      if (state.phase === 'cancelled' || state.phase === 'timed_out') return rejected();
      if (state.phase === 'failed' && claim.type === 'finish') return rejected();

      // Never verify an old checkpoint's world as though it were current.
      const world = source.getWorld();
      if (!world || world.environment.dimension !== context.dimension
        || !Number.isFinite(world.timestamp) || world.timestamp < context.notBefore || world.timestamp > now()) {
        return unknown();
      }
      state.world.latest = structuredClone(world);
      state.world.observedAt = new Date(world.timestamp).toISOString();
      const result = await source.verifyRoot({ state });
      if (!current(context, now())) return unknown();
      // A task rebound or revised while the verifier was awaiting facts must
      // not settle its replacement. Re-read the SAME source, never "latest".
      const latest = source.read(context.sessionId);
      if (!latest || latest.sessionId !== state.sessionId || latest.requestId !== state.requestId
        || latest.revision !== state.revision || latest.epoch !== state.epoch
        || latest.rootGoal?.schema !== 'mineclaw.goal/v2' || latest.rootGoal.contentHash !== root.contentHash
        || latest.phase === 'cancelled' || latest.phase === 'timed_out' || latest.phase === 'needs_rebind'
        || source.getActor() !== context.actor) return unknown();

      if (result.status === 'satisfied' && result.ok === true && validRefs(result.evidenceRefs)) {
        return { verdict: claim.type === 'finish' ? 'completed' : 'rejected',
          evidenceRefs: [...new Set(result.evidenceRefs)] };
      }
      if (claim.type === 'finish' && result.status === 'unsatisfied' && result.ok === false) return rejected();
      return unknown();
    },
  };
  return Object.freeze(verifier);
}

function current(context: DecisionContext, now: number): boolean {
  return !context.signal.aborted && context.isCurrent() && now >= context.notBefore && now < context.deadlineAt;
}

function sameSnapshot(a: NonNullable<GoalAgentStateV1['snapshotRef']>, b: NonNullable<GoalAgentStateV1['snapshotRef']>): boolean {
  return a.generationId === b.generationId && a.buildId === b.buildId && a.graphHash === b.graphHash;
}

function validRefs(refs: readonly string[]): boolean {
  return Array.isArray(refs) && refs.length > 0 && refs.every(ref => typeof ref === 'string' && ref.trim().length > 0);
}

function unknown() { return { verdict: 'unknown' as const, evidenceRefs: [] }; }
function rejected() { return { verdict: 'rejected' as const, evidenceRefs: [] }; }
