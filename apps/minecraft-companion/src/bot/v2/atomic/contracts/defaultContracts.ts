import type { ActionRequest, ActionType, ExecutionResult } from '../../types.js';
import { contractFailure, failureFromLegacy } from '../../task/execution/failureEnvelope.js';
import type { FailureEnvelope } from '../../task/contracts/failureEnvelope.js';
import {
  AtomicContractRegistry,
  type ActionContractDefinition,
  type ActionProposal,
  type ContractPrepareResult,
  type JsonSchema,
} from './atomicContractRegistry.js';

const ACTION_TYPES: readonly ActionType[] = [
  'move_to', 'goto_position', 'follow_entity', 'stop_follow', 'attack', 'say', 'stop',
  'equip', 'use_tool', 'place_block', 'dig', 'craft', 'smelt', 'walk', 'mine_to',
  'escape_pit', 'look_at', 'invoke_behavior', 'eat', 'sleep', 'wake', 'deposit',
  'withdraw', 'equip_best_armor', 'fish', 'climb_up', 'pillar_up', 'dig_down',
  'place_scaffold', 'mount', 'dismount', 'vehicle_goto', 'kite', 'block_with_shield',
  'bow_shoot', 'crit_jump_attack', 'toss_item',
];

const TARGET_FIELDS = [
  'entityId', 'position', 'text', 'itemName', 'behavior', 'behaviorParams', 'faceVector',
  'referencePosition', 'count', 'inventoryTargetCount', 'needTable', 'tablePos', 'fuelName',
  'durationMs', 'backDurationMs', 'drawMs', 'forceRepath', 'range',
] as const;

type TargetField = typeof TARGET_FIELDS[number];

interface ContractSpec {
  required?: TargetField[];
  anyOf?: TargetField[][];
  positive?: TargetField[];
}

const SPECS: Partial<Record<ActionType, ContractSpec>> = {
  move_to: { anyOf: [['position'], ['entityId']] },
  goto_position: { anyOf: [['position'], ['entityId']] },
  follow_entity: { required: ['entityId'] },
  attack: { required: ['entityId'] },
  say: { required: ['text'] },
  equip: { required: ['itemName'] },
  use_tool: { required: ['itemName'] },
  place_block: { required: ['itemName'] },
  dig: { required: ['position'] },
  craft: { required: ['itemName'], positive: ['count', 'inventoryTargetCount'] },
  smelt: { required: ['itemName'], positive: ['count'] },
  walk: { required: ['position'], positive: ['durationMs'] },
  mine_to: { required: ['position'] },
  look_at: { anyOf: [['position'], ['entityId']] },
  invoke_behavior: { required: ['behavior'] },
  deposit: { required: ['position', 'itemName'], positive: ['count'] },
  withdraw: { required: ['position', 'itemName'], positive: ['count'] },
  climb_up: { required: ['position'] },
  pillar_up: { required: ['count'], positive: ['count'] },
  dig_down: { required: ['count'], positive: ['count'] },
  place_scaffold: { required: ['itemName'] },
  mount: { required: ['entityId'] },
  vehicle_goto: { anyOf: [['position'], ['entityId']] },
  kite: { required: ['entityId'] },
  bow_shoot: { required: ['entityId'] },
  crit_jump_attack: { required: ['entityId'] },
  toss_item: { required: ['itemName'], positive: ['count'] },
};

export function createDefaultAtomicContractRegistry(): AtomicContractRegistry {
  const registry = new AtomicContractRegistry();
  for (const action of ACTION_TYPES) registry.register(buildDefinition(action, SPECS[action] ?? {}));
  return registry;
}

function buildDefinition(action: ActionType, spec: ContractSpec): ActionContractDefinition {
  return {
    action,
    schema: schemaFor(spec),
    prepare: (proposal) => prepareProposal(action, proposal, spec),
    normalize: (result) => result.ok
      ? null
      : failureFromLegacy(result.error, {
          origin: action === 'invoke_behavior' ? 'behavior' : 'atomic',
          stage: 'executing',
        }),
  };
}

function prepareProposal(action: ActionType, proposal: ActionProposal, spec: ContractSpec): ContractPrepareResult {
  const normalized = normalizeTarget(action, proposal.args);
  if ('failure' in normalized) return { kind: 'invalid', failure: normalized.failure };
  const { target, derivedFields } = normalized;

  if (target.range != null && (typeof target.range!=='number' || !Number.isFinite(target.range) || target.range<0)) {
    return {kind:'invalid',failure:contractFailure('contract.invalid_parameter',`${action}.range must be a finite non-negative number`)};
  }

  for (const field of spec.required ?? []) {
    if (!hasValue(target[field])) {
      return invalidMissing(action, [field]);
    }
  }
  if (spec.anyOf?.length && !spec.anyOf.some(group => group.every(field => hasValue(target[field])))) {
    return invalidMissing(action, spec.anyOf.flat());
  }
  for (const field of spec.positive ?? []) {
    if (target[field] != null && (!(typeof target[field] === 'number') || Number(target[field]) <= 0)) {
      return {
        kind: 'invalid',
        failure: contractFailure('contract.invalid_parameter', `${action}.${field} must be a positive number`),
      };
    }
  }
  if (action === 'climb_up') {
    const position = target.position as { y?: unknown };
    if (typeof position.y !== 'number') return invalidMissing(action, ['position.y']);
  }

  return {
    kind: 'ready',
    action: {
      proposal,
      target,
      derivedFields,
      contractVersion: 1,
    },
  };
}

function normalizeTarget(action: ActionType, args: Record<string, unknown>):
  | { target: Record<string, unknown>; derivedFields: string[] }
  | { failure: FailureEnvelope } {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return { failure: contractFailure('contract.invalid_arguments', 'action args must be an object') };
  }
  const target: Record<string, unknown> = {};
  const derivedFields: string[] = [];
  for (const field of TARGET_FIELDS) {
    if (args[field] !== undefined) target[field] = args[field];
  }

  if (!hasValue(target.itemName)) {
    const alias = typeof args.item === 'string' ? args.item : typeof args.material === 'string' ? args.material : undefined;
    if (alias) {
      target.itemName = alias;
      derivedFields.push('itemName');
    }
  }
  if (!target.position && ['x', 'y', 'z'].every(field => typeof args[field] === 'number')) {
    target.position = { x: args.x, y: args.y, z: args.z };
    derivedFields.push('position');
  }
  if (typeof target.entityId === 'string' && /^\d+$/.test(target.entityId)) {
    target.entityId = Number(target.entityId);
    derivedFields.push('entityId');
  }

  for (const field of ['position', 'faceVector', 'referencePosition', 'tablePos'] as const) {
    const requireAll = field !== 'position' || action !== 'climb_up';
    if (target[field] !== undefined && !isPosition(target[field], requireAll)) {
      return { failure: contractFailure('contract.invalid_parameter', `${field} must contain finite x/y/z numbers`) };
    }
  }
  if (target.entityId !== undefined && (!Number.isFinite(target.entityId) || typeof target.entityId !== 'number')) {
    return { failure: contractFailure('contract.invalid_parameter', 'entityId must be a finite number') };
  }
  for (const field of ['text', 'itemName', 'behavior', 'fuelName'] as const) {
    if (target[field] !== undefined && (typeof target[field] !== 'string' || !target[field].trim())) {
      return { failure: contractFailure('contract.invalid_parameter', `${field} must be a non-empty string`) };
    }
  }
  if (target.behaviorParams !== undefined && !isRecord(target.behaviorParams)) {
    return { failure: contractFailure('contract.invalid_parameter', 'behaviorParams must be an object') };
  }
  const unresolved = findUnresolvedPlaceholder(target);
  if (unresolved) {
    return {
      failure: contractFailure(
        'contract.unresolved_placeholder',
        `${action}.${unresolved.path} contains unresolved placeholder ${unresolved.value}`,
      ),
    };
  }
  return { target, derivedFields };
}

function findUnresolvedPlaceholder(
  value: unknown,
  path = 'args',
): { path: string; value: string } | null {
  if (typeof value === 'string') {
    return isTemplateExpression(value) ? { path, value } : null;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findUnresolvedPlaceholder(value[index], `${path}[${index}]`);
      if (found) return found;
    }
    return null;
  }
  if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) {
      const found = findUnresolvedPlaceholder(child, `${path}.${key}`);
      if (found) return found;
    }
  }
  return null;
}

function isTemplateExpression(value: string): boolean {
  const normalized = value.trim();
  return /^(?:\{[A-Za-z_][A-Za-z0-9_]*\}|\$\{[^{}]+\}|\$[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]+\])?)$/.test(normalized)
    || /^[A-Za-z_][A-Za-z0-9_]*\([^)]*\)$/.test(normalized);
}

function invalidMissing(action: string, fields: string[]): ContractPrepareResult {
  return {
    kind: 'invalid',
    failure: contractFailure(
      'contract.missing_parameter',
      `${action} requires ${[...new Set(fields)].join(' or ')}`,
    ),
  };
}

function schemaFor(spec: ContractSpec): JsonSchema {
  return {
    type: 'object',
    properties: Object.fromEntries(TARGET_FIELDS.map(field => [field, propertySchema(field)])),
    ...(spec.required?.length ? { required: [...spec.required] } : {}),
    ...(spec.anyOf?.length ? { anyOf: spec.anyOf.map(required => ({ required: [...required] })) } : {}),
    additionalProperties: false,
  };
}

function propertySchema(field: TargetField): Record<string, unknown> {
  if (field==='range') return {type:'number',minimum:0};
  if (['position', 'faceVector', 'referencePosition', 'tablePos'].includes(field)) {
    return { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } } };
  }
  if (['entityId', 'count', 'inventoryTargetCount', 'durationMs', 'backDurationMs', 'drawMs'].includes(field)) {
    return { type: 'number' };
  }
  if (['needTable', 'forceRepath'].includes(field)) return { type: 'boolean' };
  if (field === 'behaviorParams') return { type: 'object' };
  return { type: 'string' };
}

function hasValue(value: unknown): boolean {
  return value !== undefined && value !== null && value !== '';
}

function isPosition(value: unknown, requireAll: boolean): boolean {
  if (!isRecord(value)) return false;
  const fields = ['x', 'y', 'z'] as const;
  const present = fields.filter(field => value[field] !== undefined);
  if (requireAll && present.length !== fields.length) return false;
  if (!requireAll && present.length === 0) return false;
  return present.every(field => typeof value[field] === 'number' && Number.isFinite(value[field]));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function preparedTarget(action: { target: Record<string, unknown> }): ActionRequest['target'] {
  return action.target as ActionRequest['target'];
}

export function normalizeAtomicFailure(action: string, result: ExecutionResult): FailureEnvelope | null {
  const definition = createDefaultAtomicContractRegistry().get(action);
  return definition?.normalize(result) ?? failureFromLegacy(result.error);
}
