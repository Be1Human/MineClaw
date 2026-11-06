import type { GameAdapter, GameView } from '../../../../adapter/GameAdapter.js';
import type { EquipDestination } from '../../../../adapter/types.js';
import type { ConsumptionObservationSource } from '../../../../adapter/ConsumptionObservation.js';
import type { AtomicExecutionContext, PluginAtomicContract, PluginAtomicExecutor } from '../../../plugin-sdk/contracts/execution.js';
import type { ExecutionSettlement } from '../../../plugin-sdk/contracts/executionResult.js';
import { effectUnknown } from '../../../plugin-sdk/contracts/executionResult.js';
import type { OperationReceipt } from '../../../task/contracts/operationReceipt.js';
import { validateClosedArguments } from '../../../infra/closedJsonSchema.js';
import { tuning } from '../../../infra/tuning.js';
import type { DecisionContext, DecisionHandler, DecisionHandlerResult } from './adapter.js';

export const FASTBRAIN_BODY_CONTRIBUTION = 'mineclaw.minecraft-system.execution.fastbrain';
export const FASTBRAIN_BODY_VERSION = '1.0.0';
/** The host resolves the name only inside the registered FastBrain body contribution. */
export type FastBrainAtomicId = string;
export interface FastBrainBodyPort {
  readonly available?: boolean;
  readonly reason?: string;
  execute(atomicId: FastBrainAtomicId, target: Readonly<Record<string, unknown>>, context: DecisionContext): Promise<
    | { kind: 'receipt'; receipt: OperationReceipt }
    | { kind: 'rejected'; reason: string }
  >;
}

/** Policy-to-command translation only. The host still owns authorization and the original ledger. */
export function createFastBrainBodyHandlers(body: FastBrainBodyPort | undefined): ReadonlyMap<string, DecisionHandler> {
  const handlers = new Map<string, DecisionHandler>();
  if (!body) return handlers;
  for (const skill of ['equip', 'consume'] as const) handlers.set(skill, {
    available: body.available !== false, ...(body.reason ? { reason: body.reason } : {}), lifetime: 'body',
    run: async (decision, context) => {
      if (body.available === false) return blocked(body.reason ?? 'fastbrain_local_authority_unavailable');
      if (decision.type !== 'call' || decision.skill !== skill) return blocked('wrong_body_decision');
      const target = skill === 'equip'
        ? { itemName: decision.args.item, slot: decision.args.slot }
        : { itemName: decision.args.item, maxCount: decision.args.count ?? 1 };
      const result = await body.execute(`fastbrain_${skill}`, target, context);
      if (result.kind === 'rejected') return { ...blocked(result.reason), effectKnowledge: 'unknown', details: { stop: null } };
      const receipt = result.receipt;
      if (receipt.operationId !== context.requestId || receipt.owner.kind !== 'goal' || receipt.owner.sessionId !== context.sessionId
        || receipt.source.commandId !== `atomic:fastbrain_${skill}`
        || receipt.source.contribution.contributionId !== FASTBRAIN_BODY_CONTRIBUTION
        || receipt.source.contribution.contributionVersion !== FASTBRAIN_BODY_VERSION) {
        return { status: 'error', reason: 'body_receipt_identity_mismatch', effectKnowledge: 'unknown', evidenceRefs: [], details: { stop: null } };
      }
      const proof = receipt.details;
      const evidenceRefs = Array.isArray(proof?.evidenceRefs) ? proof.evidenceRefs.filter((v): v is string => typeof v === 'string') : [];
      const known = receipt.status !== 'in_doubt' && proof?.effectKnowledge === 'confirmed';
      if (known && (proof?.actor !== context.actor || typeof proof.dimension !== 'string'
        || proof.dimension.replace(/^minecraft:/, '') !== context.dimension.replace(/^minecraft:/, ''))) {
        return { status: 'error', reason: 'body_evidence_identity_mismatch', effectKnowledge: 'unknown', evidenceRefs: [],
          details: { stop: receipt.stop, operationId: receipt.operationId } };
      }
      return {
        status: receipt.status === 'succeeded' ? (known && receipt.stop ? 'success' : 'partial')
          : receipt.status === 'cancelled' ? (Date.now() >= context.deadlineAt ? 'timeout' : 'cancelled')
            : receipt.status === 'in_doubt' ? 'partial' : 'blocked',
        ...(receipt.failure ? { reason: receipt.failure.code } : !known ? { reason: 'body_effect_unverified' } : {}),
        effectKnowledge: known ? 'confirmed' : 'unknown', evidenceRefs: [...receipt.evidenceRefs, ...evidenceRefs],
        details: { ...proof, operationId: receipt.operationId, stop: receipt.stop,
          effects: [...receipt.effects, ...(Array.isArray(proof?.observedEffects) ? proof.observedEffects : [])],
          observedEffects: proof?.observedEffects ?? [], evidenceRefs: [...receipt.evidenceRefs, ...evidenceRefs], source: receipt.source },
      };
    },
  });
  return handlers;
}

/** New strict semantics registered beside (not aliases over) the legacy atomics. */
export function createFastBrainBodyAtomics(game: GameAdapter | undefined): readonly {
  atomicId: string; version: string; executor: PluginAtomicExecutor; contract: PluginAtomicContract;
}[] {
  return (['fastbrain_equip', 'fastbrain_consume'] as const).map(atomicId => {
    const schema = atomicId === 'fastbrain_equip' ? {
      type: 'object', additionalProperties: false, required: ['itemName', 'slot'],
      properties: { itemName: { type: 'string', minLength: 1 }, slot: { enum: ['hand', 'off-hand', 'head', 'torso', 'legs', 'feet'] } },
    } : {
      type: 'object', additionalProperties: false, required: ['itemName', 'maxCount'],
      properties: { itemName: { type: 'string', minLength: 1 }, maxCount: { type: 'integer', minimum: 1 } },
    };
    const contract: PluginAtomicContract = { atomicId, version: FASTBRAIN_BODY_VERSION, schema,
      prepare: args => {
        try { validateClosedArguments(args, schema); return { prepared: structuredClone(args) }; }
        catch { return { invalid: { code: 'fastbrain_body_args_invalid', message: 'invalid FastBrain body arguments' } }; }
      },
      normalize: result => result.status === 'succeeded' ? null : { code: 'fastbrain_body_failed', message: 'body effect not confirmed' },
    };
    const executor: PluginAtomicExecutor = {
      id: `mineclaw.minecraft-system.atomic.${atomicId}`, version: FASTBRAIN_BODY_VERSION,
      execute: async (command, context): Promise<ExecutionSettlement> => {
        const args = command.request.target as Readonly<Record<string, unknown>>;
        const prepared = contract.prepare!(args);
        if ('invalid' in prepared) return failed('invalid_arguments');
        if (!game) return failed('device_unavailable');
        context.assertCurrent('fastbrain_before_device_bind');
        const item = String(args.itemName);
        // Capture the original concrete Bot before any await or body write.
        const source = concreteProofSource(game);
        const isGenerationCurrent = source?.captureBodyReadGeneration?.();
        if (!isGenerationCurrent || !isGenerationCurrent()) return failed('device_read_generation_unavailable');
        const capture = atomicId === 'fastbrain_consume' ? source?.captureConsumption?.(item, context.signal) : undefined;
        if (atomicId === 'fastbrain_consume' && !capture) return failed('consumption_evidence_unavailable');
        if (capture) context.registerCleanup(async () => capture.close());
        const assertDevice = (reason: string) => {
          context.assertCurrent(reason);
          if (!isGenerationCurrent()) throw new Error('fastbrain_device_generation_revoked');
        };
        const bound = game.bind({ ...context, assertCurrent: assertDevice,
          effect: run => context.effect(() => { assertDevice('fastbrain_native_dispatch'); return run(); }) });
        context.registerCleanup(reason => bound.stop(reason));
        const refs = [`operation:${context.operationId}:${context.stepId}:before`, `operation:${context.operationId}:${context.stepId}:after`];
        const details: Record<string, unknown> = { operationId: context.operationId, stepId: context.stepId,
          actor: bound.view.username, dimension: bound.view.getDimension(), item, evidenceRefs: refs, effectKnowledge: 'unknown' };
        try {
          if (atomicId === 'fastbrain_equip') {
            const slot = args.slot as EquipDestination;
            const before = equipped(bound.view, slot);
            details.before = { slot, item: before };
            if (before === item) return { status: 'succeeded', details: { ...details, after: details.before, actual: 0, noOp: true, observedEffects: [], effectKnowledge: 'confirmed' } };
            if (!bound.view.getInventoryItems().some(value => value.name === item && value.count > 0)) return failed('missing_item', details);
            await bound.actions.equip(item, slot);
            const confirmed = await waitForEquipment(bound.view, slot, item, context);
            if (!isGenerationCurrent()) throw new Error('fastbrain_device_generation_revoked');
            details.after = { slot, item: equipped(bound.view, slot) };
            details.native = 'equip_resolved';
            return confirmed ? { status: 'succeeded', details: { ...details, actual: 1,
              observedEffects: [{ kind: 'equipment_changed', item, slot, before, after: item, evidenceRefs: refs }], effectKnowledge: 'confirmed' } }
              : { status: 'in_doubt', failure: effectUnknown('equip_slot_not_confirmed'), details };
          }
          // Count is an upper bound: this finite step consumes at most ONE item.
          const selectedBefore = equipped(bound.view, 'hand');
          await bound.actions.equip(item, 'hand');
          if (!await waitForEquipment(bound.view, 'hand', item, context) || !capture!.arm()) return {
            status: 'in_doubt', failure: effectUnknown('consume_selection_not_confirmed'), details,
          };
          details.selection = { before: selectedBefore, after: item };
          details.observedEffects = selectedBefore !== item
            ? [{ kind: 'equipment_changed', item, slot: 'hand', before: selectedBefore, after: item, evidenceRefs: refs }] : [];
          details.before = capture!.read();
          const nativeCompleted = await bound.actions.consume();
          const after = capture!.read();
          details.after = after;
          details.native = nativeCompleted ? 'consume_resolved' : 'consume_rejected';
          const actual = after.beforeCount !== null && after.afterCount !== null ? after.beforeCount - after.afterCount : null;
          details.actual = actual;
          const proven = nativeCompleted && after.status === 'observed' && after.consumptionEvents > 0 && after.inventoryEvents > 0
            && actual === 1 && actual <= Number(args.maxCount);
          return proven ? { status: 'succeeded', details: { ...details,
            observedEffects: [...details.observedEffects as unknown[], { kind: 'item_consumed', item, actual, evidenceRefs: refs }], effectKnowledge: 'confirmed' } }
            : { status: 'in_doubt', failure: effectUnknown('consumption_event_and_inventory_unproven'), details };
        } catch {
          return { status: 'in_doubt', failure: effectUnknown('fastbrain_body_interrupted_or_unobserved'), details };
        } finally { capture?.close(); }
      },
    };
    return { atomicId, version: FASTBRAIN_BODY_VERSION, executor, contract };
  });
}

async function waitForEquipment(view: GameView, slot: EquipDestination, item: string, context: AtomicExecutionContext): Promise<boolean> {
  const deadline = Math.min(context.deadlineAt, Date.now() + tuning().deviceActions.equipObserveTimeoutMs);
  while (true) {
    context.assertCurrent('fastbrain_equipment_readback');
    if (equipped(view, slot) === item) return true;
    if (Date.now() >= deadline) return false;
    await context.wait(Math.min(tuning().deviceActions.equipObservePollMs, deadline - Date.now()));
  }
}
function equipped(view: GameView, slot: EquipDestination): string | null {
  return (slot === 'hand' ? view.getHeldItem() : slot === 'off-hand' ? view.getOffhandItem() : view.getArmorItems()[slot])?.name ?? null;
}
function concreteProofSource(game: GameAdapter): (Partial<ConsumptionObservationSource> & { captureBodyReadGeneration?(): () => boolean }) | null {
  const seen = new Set<unknown>();
  let current: unknown = game;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const value = current as { getTarget?: () => unknown; captureConsumption?: ConsumptionObservationSource['captureConsumption']; captureBodyReadGeneration?(): () => boolean };
    if (typeof value.getTarget === 'function') { current = value.getTarget(); continue; }
    return value;
  }
  return null;
}
function blocked(reason: string): DecisionHandlerResult { return { status: 'blocked', reason, effectKnowledge: 'confirmed', evidenceRefs: [] }; }
function failed(reason: string, details?: Readonly<Record<string, unknown>>): ExecutionSettlement {
  return { status: 'failed', failure: { code: `fastbrain.${reason}`, origin: 'atomic', stage: 'preparing', category: 'precondition',
    retryable: false, ownerActionable: true, evidenceRefs: [] }, ...(details ? { details } : {}) };
}
