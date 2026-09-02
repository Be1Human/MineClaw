/**
 * FEAT-CROSS-26-001-004-004 · generation→knowledge projection adapter (P3-4).
 * Maps the pinned generation's PluginAtomicContract[] to the legacy
 * ActionContractDefinition shape consumed by createRuntimeCapabilityKnowledge,
 * so capability knowledge reads atomics ONLY from the generation — never a
 * driver-built default registry. Missing generation yields an empty list
 * (callers surface kernel_not_ready at the resolver level).
 */
import type { ActionContractDefinition, ActionProposal, ContractPrepareResult, JsonSchema } from '../atomic/contracts/atomicContractRegistry.js';
import type { PluginAtomicContract } from '../plugin-sdk/contracts/execution.js';
import type { ExecutionResult } from '../types.js';
import { failureFromLegacy } from '../task/execution/failureEnvelope.js';
import type { FailureEnvelope } from '../task/contracts/failureEnvelope.js';

function toLegacyPrepare(contract: PluginAtomicContract) {
  return (proposal: ActionProposal, _context: { now: number }): ContractPrepareResult => {
    const prepared = contract.prepare?.(proposal.args as Readonly<Record<string, unknown>>);
    if (!prepared) {
      // No custom prepare: raw args pass through (contract without prepare is catalog-only).
      return { kind: 'ready', action: { proposal, target: proposal.args as Record<string, unknown>, derivedFields: [], contractVersion: 1 } };
    }
    if ('invalid' in prepared) {
      return { kind: 'invalid', failure: failureFromLegacy(prepared.invalid.message, { origin: 'atomic', stage: 'preparing' }) as FailureEnvelope };
    }
    return {
      kind: 'ready',
      action: {
        proposal,
        target: prepared.prepared as Record<string, unknown>,
        derivedFields: [...(prepared.derivedFields ?? [])],
        contractVersion: 1,
      },
    };
  };
}

function toLegacyNormalize(contract: PluginAtomicContract) {
  return (result: ExecutionResult): FailureEnvelope | null => {
    const normalized = contract.normalize?.(result as unknown as Readonly<Record<string, unknown>>);
    return normalized ? failureFromLegacy(normalized.message, { origin: 'atomic', stage: 'executing' }) as FailureEnvelope : null;
  };
}

/** Project generation contracts into the legacy knowledge shape. */
export function projectAtomicContractsToKnowledge(contracts: readonly PluginAtomicContract[]): readonly ActionContractDefinition[] {
  return contracts.map(contract => ({
    action: contract.atomicId,
    schema: (contract.schema ?? { type: 'object', properties: {}, additionalProperties: true }) as unknown as JsonSchema,
    prepare: toLegacyPrepare(contract),
    normalize: toLegacyNormalize(contract),
  }));
}
