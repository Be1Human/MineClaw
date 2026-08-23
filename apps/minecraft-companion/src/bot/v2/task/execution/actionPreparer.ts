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
import { contractFailure, type FailureEnvelope } from './failureEnvelope.js';

export interface ActionPreparationContext {
  execId: string;
  taskId?: string;
}

export type ActionPrepareResult =
  | { kind: 'ready'; action: PreparedAction; request: ActionRequest }
  | { kind: 'invalid'; failure: FailureEnvelope };

export class ActionPreparer {
  constructor(private readonly registry: AtomicContractRegistry) {}

  prepare(proposal: ActionProposal, context: ActionPreparationContext): ActionPrepareResult {
    const definition = this.registry.get(proposal.action);
    if (!definition) {
      return {
        kind: 'invalid',
        failure: contractFailure('contract.unknown_action', `unknown action: ${proposal.action}`),
      };
    }
    const prepared = definition.prepare(proposal, { now: Date.now() });
    if (prepared.kind !== 'ready') return prepared;
    return {
      kind: 'ready',
      action: prepared.action,
      request: {
        id: context.execId,
        source: `goalagent.${proposal.source}`,
        taskId: context.taskId,
        type: proposal.action as ActionRequest['type'],
        priority: 35,
        interrupt_level: 'soft',
        resource: [],
        target: preparedTarget(prepared.action),
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
}

export const defaultActionPreparer = new ActionPreparer(createDefaultAtomicContractRegistry());
