import type { ActionContractDefinition } from '../atomic/contracts/atomicContractRegistry.js';
import type { IBehavior } from '../behavior/types.js';
import type { TaskDefinition } from '../knowledge/types.js';
import type { GoalCapabilityDefinition, GoalCapabilityKnowledgePort } from '../decision/goalAgentPort/goalCapabilityRouter.js';
import { CapabilityCatalog, type CapabilityResourceDescription, type CapabilityExecutionSupport } from './capabilityCatalog.js';
import type { CapabilityPackageSnapshot } from './types.js';

export interface CapabilityRuntimeProjectionInput {
  readonly snapshot: CapabilityPackageSnapshot;
  readonly routes: readonly GoalCapabilityDefinition[];
  readonly atomics: readonly ActionContractDefinition[];
  readonly behaviors: readonly IBehavior[];
  readonly tasks: readonly TaskDefinition[];
  readonly strategies: readonly { id: string; name: string; kind: string }[];
  readonly services: readonly { id: string; name: string; summary: string }[];
  readonly adapters?: readonly { id: string; summary: string }[];
  readonly dataStrategies?: readonly { id: string; description: string }[];
  readonly executionSupport?: readonly CapabilityExecutionSupport[];
}

/** Rebuild from live registries, never cache an independently mutable capability inventory. */
export function createRuntimeCapabilityKnowledge(read: () => CapabilityRuntimeProjectionInput): GoalCapabilityKnowledgePort {
  const catalog = (): CapabilityCatalog => {
    const input = read();
    const resources: CapabilityResourceDescription[] = [
      ...input.atomics.map(value => ({
        id: value.action, kind: 'atomic' as const, layer: 'L3' as const,
        title: value.action, summary: 'Registered atomic contract. May be used inside Behaviors or by an applicable action_list candidate; not a top-level tool.',
        aliases: [], registered: true, discovery: [], invocation: ['executeAtomic'],
        inputSchema: value.schema as unknown as Record<string, unknown>,
      })),
      ...input.behaviors.map(value => ({
        id: value.id, kind: 'behavior' as const, layer: 'L4' as const,
        title: value.id, summary: `Registered composite operation (${value.kind}). Requires an applicable action_list candidate or an internal strategy caller.`,
        aliases: [], registered: true, discovery: [], invocation: ['invoke_behavior', value.kind === 'adaptive' ? 'run' : 'compile'],
      })),
      ...input.tasks.map(value => ({
        id: value.kind, kind: 'task' as const, layer: 'L6' as const,
        title: value.kind, summary: `${value.summary}; strategy declaration: ${value.strategy}. YAML does not create a strategy instance or grant a task candidate.`,
        aliases: value.aliases, registered: true, discovery: [], invocation: ['TaskRuntime.createTask'],
        inputSchema: { requiredSlots: value.slots.required, optionalSlots: value.slots.optional, preconditions: value.preconditions },
      })),
      ...input.strategies.map(value => ({
        id: value.id, kind: 'strategy' as const, layer: 'L5' as const,
        title: value.name, summary: `Registered heartbeat strategy (${value.kind}); activated by task or safety conditions, not by class-name tool calls.`,
        aliases: [value.name], registered: true, discovery: [], invocation: ['Heartbeat', 'isActive', 'tick'],
      })),
      ...input.services.map(value => ({
        id: value.id, kind: 'service' as const, layer: 'L2' as const,
        title: value.name, summary: value.summary, aliases: [value.name],
        registered: true, discovery: [], invocation: ['TickRegistry.onTick'],
      })),
      ...(input.adapters ?? []).map(value => ({
        id: value.id, kind: 'adapter' as const, layer: 'L1' as const,
        title: value.id, summary: value.summary, aliases: [], registered: true,
        discovery: [], invocation: ['dependency_injection'],
      })),
      ...(input.dataStrategies ?? []).map(value => ({
        id: `data:${value.id}`, kind: 'strategy' as const, layer: 'L5' as const,
        title: value.id, summary: value.description, aliases: [value.id], registered: true,
        discovery: ['action_list'], invocation: ['action_execute', 'invoke_strategy'],
      })),
    ];
    // Missing task implementations are derived from the loaded YAML references, not another class inventory.
    for (const task of input.tasks) {
      if (!task.strategy || input.strategies.some(value => value.name === task.strategy)) continue;
      if (resources.some(value => value.kind === 'strategy' && value.id === task.strategy)) continue;
      resources.push({
        id: task.strategy, kind: 'strategy', layer: 'L5', title: task.strategy,
        summary: `Task ${task.kind} declares this strategy, but no matching heartbeat implementation is installed.`,
        aliases: [...task.aliases], registered: false, discovery: [], invocation: [],
      });
    }
    return new CapabilityCatalog({ snapshot: input.snapshot, routes: input.routes, resources, executionSupport: input.executionSupport });
  };
  return { list: () => catalog().list(), search: input => catalog().search(input), get: id => catalog().get(id) };
}
