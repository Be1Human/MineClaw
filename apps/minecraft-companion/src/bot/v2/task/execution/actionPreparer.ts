import type { ActionRequest, ExecutionResult } from '../../types.js';
import {
  createDefaultAtomicContractRegistry,
  preparedTarget,
} from '../../atomic/contracts/defaultContracts.js';
import type {
  ActionProposal,
  AtomicContractRegistry,
  PreparedAction,
} from '../../atomic/contracts/atomicContractRegistry.js';
import type { RegistrySnapshotRef } from '../../plugin-sdk/identity.js';
import type { PluginAtomicContract } from '../../plugin-sdk/contracts/execution.js';
import type { GenerationContractResolverPort } from './generationResolversPorts.js';
import { contractFailure } from './failureEnvelope.js';
import type { FailureEnvelope } from '../contracts/failureEnvelope.js';

export interface ActionPreparationContext {
  execId: string;
  taskId?: string;
  /** P3-4 · 固定代（generation-backed 模式必填；缺失 fail-closed）。 */
  snapshot?: RegistrySnapshotRef;
}

export type ActionPrepareResult =
  | { kind: 'ready'; action: PreparedAction; request: ActionRequest }
  | { kind: 'invalid'; failure: FailureEnvelope };

/**
 * Contract-backed parameter validation. With a Generation contract resolver the
 * schemas/prepare come from the pinned generation (F12, owned by the system
 * plugin). Without it (migration-phase fixtures) the legacy registry is used —
 * the removal of that path lands with the switch commit.
 */
export class ActionPreparer {
  constructor(
    private readonly registry: AtomicContractRegistry,
    private readonly generation?: GenerationContractResolverPort,
  ) {}

  prepare(proposal: ActionProposal, context: ActionPreparationContext): ActionPrepareResult {
    if (this.generation) return this.prepareFromGeneration(proposal, context);
    const definition = this.registry.get(proposal.action);
    if (!definition) {
      return {
        kind: 'invalid',
        failure: contractFailure('contract.unknown_action', `unknown action: ${proposal.action}`),
      };
    }
    const prepared = definition.prepare(proposal, { now: Date.now() });
    if (prepared.kind !== 'ready') return prepared;
    return this.toReady(proposal, context, prepared.action);
  }

  private prepareFromGeneration(proposal: ActionProposal, context: ActionPreparationContext): ActionPrepareResult {
    if (!context.snapshot) {
      return { kind: 'invalid', failure: contractFailure('contract.unknown_action', 'snapshot_required_for_generation_contract') };
    }
    const resolved = this.generation!.resolve(context.snapshot, proposal.action);
    if (resolved.status !== 'resolved') {
      return { kind: 'invalid', failure: contractFailure('contract.unknown_action', resolved.reason) };
    }
    const contract = resolved.value;
    const prepared = contract.prepare?.(proposal.args as Readonly<Record<string, unknown>>);
    if (prepared && 'invalid' in prepared) {
      return { kind: 'invalid', failure: contractFailure(prepared.invalid.code, prepared.invalid.message) };
    }
    const target = (prepared && 'prepared' in prepared ? prepared.prepared : proposal.args) as Record<string, unknown>;
    return this.toRawReady(proposal, context, target, derivedFieldsOf(prepared));
  }

  private toReady(proposal: ActionProposal, context: ActionPreparationContext, prepared: PreparedAction): ActionPrepareResult {
    return this.toRawReady(proposal, context, prepared.target as Record<string, unknown>, prepared.derivedFields);
  }

  private toRawReady(proposal: ActionProposal, context: ActionPreparationContext, target: Record<string, unknown>, derivedFields: readonly string[]): ActionPrepareResult {
    return {
      kind: 'ready',
      action: { proposal, target, derivedFields: [...derivedFields], contractVersion: 1 },
      request: {
        id: context.execId,
        source: `goalagent.${proposal.source}`,
        taskId: context.taskId,
        type: proposal.action as ActionRequest['type'],
        priority: 35,
        interrupt_level: 'soft',
        resource: [],
        target: target as ActionRequest['target'],
        preconditions: [],
        timeout_ms: 30_000,
      },
    };
  }

  normalize(action: string, result: ExecutionResult): FailureEnvelope | null {
    const definition = this.registry.get(action);
    return definition
      ? definition.normalize(result)
      : contractFailure('contract.unknown_action', `unknown action: ${action}`);
  }

  schemas(): ReturnType<AtomicContractRegistry['schemas']> {
    return this.registry.schemas();
  }

  /** P3-4 · Generation 模式契约解析（供 goalAgentProductionPorts 展示 schema）。 */
  resolveContract(snapshot: RegistrySnapshotRef, action: string): PluginAtomicContract | null {
    if (!this.generation) return null;
    const resolved = this.generation.resolve(snapshot, action);
    return resolved.status === 'resolved' ? resolved.value : null;
  }

  /** P3-4 · Generation 模式契约列表（供候选枚举）。 */
  listContracts(snapshot: RegistrySnapshotRef): readonly PluginAtomicContract[] {
    if (!this.generation) return [];
    const resolved = this.generation.list(snapshot);
    return resolved.status === 'resolved' ? resolved.value : [];
  }
}

function derivedFieldsOf(prepared: unknown): readonly string[] {
  if (prepared && typeof prepared === 'object' && 'derivedFields' in prepared) {
    const fields = (prepared as { derivedFields?: readonly string[] }).derivedFields;
    return fields ?? [];
  }
  return [];
}

export const defaultActionPreparer = new ActionPreparer(createDefaultAtomicContractRegistry());
