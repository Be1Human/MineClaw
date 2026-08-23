import type { ExecutionResult } from '../../types.js';
import type { FailureEnvelope } from '../../task/execution/failureEnvelope.js';

export interface JsonSchema {
  type: 'object';
  properties: Record<string, Record<string, unknown>>;
  required?: string[];
  anyOf?: Array<{ required: string[] }>;
  additionalProperties: boolean;
}

export interface ActionProposal {
  source: 'slow_llm' | 'fast_strategy' | 'registered_behavior' | 'registered_task' | 'legacy';
  action: string;
  args: Record<string, unknown>;
  rationale?: string;
}

export interface PreparedAction {
  proposal: ActionProposal;
  target: Record<string, unknown>;
  derivedFields: string[];
  contractVersion: 1;
}

export type ContractPrepareResult =
  | { kind: 'ready'; action: PreparedAction }
  | { kind: 'invalid'; failure: FailureEnvelope };

export interface ContractPreparationContext {
  now: number;
}

export interface ActionContractDefinition {
  action: string;
  schema: JsonSchema;
  prepare(
    proposal: ActionProposal,
    context: ContractPreparationContext,
  ): ContractPrepareResult;
  normalize(result: ExecutionResult): FailureEnvelope | null;
}

export class AtomicContractRegistry {
  private readonly definitions = new Map<string, ActionContractDefinition>();

  register(definition: ActionContractDefinition): void {
    if (!definition.action.trim()) throw new Error('action contract requires a non-empty action');
    if (this.definitions.has(definition.action)) {
      throw new Error(`action contract already registered: ${definition.action}`);
    }
    this.definitions.set(definition.action, definition);
  }

  get(action: string): ActionContractDefinition | undefined {
    return this.definitions.get(action);
  }

  list(): ActionContractDefinition[] {
    return [...this.definitions.values()].sort((a, b) => a.action.localeCompare(b.action));
  }

  schemas(): Record<string, JsonSchema> {
    return Object.fromEntries(this.list().map(definition => [definition.action, definition.schema]));
  }
}
