import { isDeepStrictEqual } from 'node:util';
import type { GameAdapter } from '../../../../adapter/GameAdapter.js';
import type { AtomicExecutionContext, PluginAtomicContract, PluginAtomicExecutor } from '../../../plugin-sdk/contracts/execution.js';
import { effectUnknown, type ExecutionSettlement } from '../../../plugin-sdk/contracts/executionResult.js';
import { validateClosedArguments } from '../../../infra/closedJsonSchema.js';
import type { DecisionContext, DecisionHandler, DecisionHandlerResult } from './adapter.js';
import type { FastBrainBodyPort } from './body.js';
import type { FastBrainVisibleTargets, VisibleTarget } from './visibleTargets.js';

export const FASTBRAIN_MINE_ATOMIC = 'fastbrain_mine';
const VERSION = '1.0.0';
type Identity = Pick<AtomicExecutionContext, 'operationId' | 'operationEpoch' | 'leaseRef' | 'stepId'>;

/**
 * Host-only authority captured from the ORIGINAL operation/grant. The closure
 * rechecks that same live goal, generation, mutation region and action budget.
 * A target's coordinates or a policy-supplied scope are never authority.
 */
export interface MineMutationAuthority {
  capture(identity: Identity, target: VisibleTarget): (() => boolean) | null;
}

export function createFastBrainMineHandler(body: FastBrainBodyPort, visible: FastBrainVisibleTargets): DecisionHandler {
  if (body.available === false) {
    const reason = body.reason ?? 'fastbrain_local_authority_unavailable';
    return { available: false, reason, lifetime: 'body', run: async () => blocked(reason) };
  }
  return { available: true, lifetime: 'body', run: async (decision, context) => {
    if (decision.type !== 'call' || decision.skill !== 'mine') return blocked('wrong_mine_decision');
    const targetId = String(decision.args.target_id);
    const resolved = visible.resolve(targetId, context);
    if (resolved.status !== 'resolved') return blocked(resolved.reason);
    // This sealed data travels through the original body command and ledger.
    // It is checked again inside the device effect, never just reduced to xyz.
    const target = resolved.target;
    const args = { targetId, observationVersion: target.observationVersion, name: target.name,
      stateId: target.stateId, position: target.position, observedAt: target.observedAt,
      sessionId: context.sessionId, actor: context.actor, dimension: context.dimension };
    const result = await body.execute(FASTBRAIN_MINE_ATOMIC, args, context);
    if (result.kind === 'rejected') return { ...blocked(result.reason), effectKnowledge: 'unknown', details: { stop: null } };
    const receipt = result.receipt;
    if (receipt.operationId !== context.requestId || receipt.owner.kind !== 'goal' || receipt.owner.sessionId !== context.sessionId
      || receipt.source.commandId !== `atomic:${FASTBRAIN_MINE_ATOMIC}`) {
      return { status: 'error', reason: 'mine_receipt_identity_mismatch', effectKnowledge: 'unknown', evidenceRefs: [], details: { stop: null } };
    }
    const known = receipt.status !== 'in_doubt' && receipt.details?.effectKnowledge === 'confirmed';
    const refs = receipt.details?.evidenceRefs;
    const evidenceRefs = [...receipt.evidenceRefs, ...(Array.isArray(refs) ? refs.filter((ref): ref is string => typeof ref === 'string') : [])];
    return { status: receipt.status === 'succeeded' ? (known && receipt.stop ? 'success' : 'partial')
      : receipt.status === 'cancelled' ? (Date.now() >= context.deadlineAt ? 'timeout' : 'cancelled')
        : receipt.status === 'in_doubt' ? 'partial' : 'blocked',
      ...(receipt.failure ? { reason: receipt.failure.code } : !known ? { reason: 'mine_effect_unverified' } : {}),
      effectKnowledge: known ? 'confirmed' : 'unknown', evidenceRefs,
      details: { ...receipt.details, operationId: receipt.operationId, stop: receipt.stop,
        effects: receipt.effects, source: receipt.source, evidenceRefs } };
  } };
}

/** One dig, through the existing bound GameActions and original body lifetime. */
export function createFastBrainMineAtomic(game: GameAdapter | undefined, visible: FastBrainVisibleTargets,
  authority?: MineMutationAuthority): { atomicId: string; version: string; executor: PluginAtomicExecutor; contract: PluginAtomicContract } {
  const token = { type: 'string', minLength: 1 };
  const schema = { type: 'object', additionalProperties: false,
    required: ['targetId', 'observationVersion', 'name', 'stateId', 'position', 'observedAt', 'sessionId', 'actor', 'dimension'],
    properties: { targetId: token, observationVersion: token, name: token, stateId: { type: 'integer', minimum: 0 },
      position: { type: 'object', additionalProperties: false, required: ['x', 'y', 'z'],
        properties: { x: { type: 'integer' }, y: { type: 'integer' }, z: { type: 'integer' } } },
      observedAt: { type: 'number' }, sessionId: token, actor: token, dimension: token } };
  const contract: PluginAtomicContract = { atomicId: FASTBRAIN_MINE_ATOMIC, version: VERSION, schema,
    prepare: args => {
      try { validateClosedArguments(args, schema); return { prepared: structuredClone(args) }; }
      catch { return { invalid: { code: 'fastbrain_mine_args_invalid', message: 'invalid sealed mine target' } }; }
    },
    normalize: result => result.status === 'succeeded' ? null : { code: 'fastbrain_mine_unverified', message: 'mine effect not confirmed' },
  };
  const executor: PluginAtomicExecutor = { id: `mineclaw.minecraft-system.atomic.${FASTBRAIN_MINE_ATOMIC}`, version: VERSION,
    execute: async (command, context): Promise<ExecutionSettlement> => {
      const args = command.request.target as Readonly<Record<string, unknown>>;
      if ('invalid' in contract.prepare!(args)) return failed('invalid_arguments');
      if (!game) return failed('device_unavailable');
      if (!authority) return failed('mutation_authority_unavailable');
      context.assertCurrent('mine_before_proof');
      const decisionContext: DecisionContext = { requestId: context.operationId, sessionId: String(args.sessionId),
        actor: String(args.actor), dimension: String(args.dimension), notBefore: Number(args.observedAt), deadlineAt: context.deadlineAt,
        signal: context.signal, isCurrent: () => { try { context.assertCurrent('mine_proof'); return true; } catch { return false; } } };
      const readOriginal = (): VisibleTarget | null => {
        const result = visible.resolve(String(args.targetId), decisionContext);
        if (result.status !== 'resolved') return null;
        const target = result.target;
        return target.observationVersion === args.observationVersion && target.name === args.name && target.stateId === args.stateId
          && target.observedAt === args.observedAt && target.sessionId === args.sessionId && target.actor === args.actor
          && target.dimension.replace(/^minecraft:/, '') === String(args.dimension).replace(/^minecraft:/, '')
          && isDeepStrictEqual(target.position, args.position) ? target : null;
      };
      const original = readOriginal();
      if (!original) return failed('target_ref_stale_or_changed');
      if (original.canDig !== true) return failed(original.canDig === false ? 'target_not_interactable' : 'interaction_range_unverified');
      const permitted = authority.capture(context, original);
      if (!permitted || !permitted()) return failed('mutation_scope_not_authorized');
      let dispatched = false;
      const bound = game.bind({ ...context, effect: run => context.effect(() => {
        context.assertCurrent('mine_native_dispatch');
        const latest = readOriginal();
        if (!permitted() || !latest || latest.canDig !== true) throw new Error('mine_dispatch_proof_revoked');
        dispatched = true;
        return run();
      }) });
      context.registerCleanup(reason => bound.stop(reason));
      const p = original.position;
      const before = bound.view.getBlockAt(p);
      if (bound.view.username !== original.actor || bound.view.getDimension().replace(/^minecraft:/, '') !== original.dimension
        || before?.name !== original.name) return failed('fixed_device_target_mismatch');
      const evidenceRefs = [...original.evidenceRefs, `operation:${context.operationId}:${context.stepId}:block-before`,
        `operation:${context.operationId}:${context.stepId}:block-after`];
      const details: Record<string, unknown> = { targetId: original.targetId, observationVersion: original.observationVersion,
        actor: original.actor, dimension: original.dimension, position: { ...p }, before: { name: original.name, stateId: original.stateId },
        actual: null, inventoryDelta: null, effectKnowledge: 'unknown', evidenceRefs };
      let completed = false;
      try { await bound.actions.dig(p); completed = true; }
      catch { /* Inspect the fixed device; an interrupted native call is not zero effect. */ }
      const after = bound.view.getBlockAt(p);
      details.after = after ? { name: after.name, boundingBox: after.boundingBox } : null;
      details.nativeCompleted = completed;
      details.dispatched = dispatched;
      if (!dispatched) return failed('dispatch_proof_revoked', { ...details, actual: 0, effectKnowledge: 'confirmed' });
      // Unloaded != air. A generic type change != one mined block. No inventory
      // gain or pickup is inferred, and cancellation never certifies a removal.
      const localRemovalObserved = !!after && ['air', 'cave_air', 'void_air'].includes(after.name);
      details.localRemovalObserved = localRemovalObserved;
      // Mineflayer's dig timer calls _updateBlockState(..., 0) itself. Neither
      // this local air nor the resolved dig promise proves a server-origin
      // block transition. Keep the actual amount unknown until that separate
      // evidence capability is delivered; do not manufacture mined=1.
      return { status: 'in_doubt', failure: effectUnknown(completed && localRemovalObserved
        ? 'mine_server_origin_unverified' : 'mine_same_cell_effect_unverified'), details };
    },
  };
  return { atomicId: FASTBRAIN_MINE_ATOMIC, version: VERSION, executor, contract };
}

function blocked(reason: string): DecisionHandlerResult { return { status: 'blocked', reason, effectKnowledge: 'confirmed', evidenceRefs: [] }; }
function failed(reason: string, details?: Readonly<Record<string, unknown>>): ExecutionSettlement {
  return { status: 'failed', failure: { code: `fastbrain.mine.${reason}`, origin: 'atomic', stage: 'preparing', category: 'precondition',
    retryable: false, ownerActionable: true, evidenceRefs: [] },
    details: { actual: 0, effectKnowledge: 'confirmed', evidenceRefs: [], ...details } };
}
