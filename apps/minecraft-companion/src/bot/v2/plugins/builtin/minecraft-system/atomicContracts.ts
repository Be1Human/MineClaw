/**
 * mineclaw.minecraft-system · atomic self-describing contract metadata (F12).
 * Pure schema/prepare/normalize carried by the system plugin's execution
 * contribution; no device access, no side effects. Migrated from the removed
 * atomic/contracts/defaultContracts.ts so the Generation resolver can return
 * Contract/Executor together (kernel design §5.10).
 */
import type { PluginAtomicContract, PluginAtomicExecutor } from '../../../plugin-sdk/contracts/execution.js';

export interface AtomicContractEntry {
  readonly atomicId: string;
  readonly version: string;
  readonly executor: PluginAtomicExecutor;
  readonly contract?: PluginAtomicContract;
}

const CONTRACT_SCHEMA = { type: 'object', additionalProperties: false } as const;

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

/** 顶层原子参数规范（与旧 defaultContracts 一致；首期系统原子）。 */
const SPECS: Partial<Record<string, ContractSpec>> = {
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
  toss_item: { required: ['itemName'], positive: ['count'] },
  deposit: { required: ['position', 'itemName'], positive: ['count'] },
  withdraw: { required: ['position', 'itemName'], positive: ['count'] },
  climb_up: { required: ['position'] },
  pillar_up: { required: ['count'], positive: ['count'] },
  dig_down: { required: ['count'], positive: ['count'] },
  place_scaffold: { required: ['itemName'] },
  mount: { required: ['entityId'] },
  vehicle_goto: { anyOf: [['position'], ['entityId']] },
  kite: { required: ['entityId'] },
  block_with_shield: { required: ['entityId'] },
  bow_shoot: { required: ['entityId'] },
  crit_jump_attack: { required: ['entityId'] },
};

function buildContract(atomicId: string, spec: ContractSpec): PluginAtomicContract {
  return {
    atomicId,
    version: '1.0.0',
    schema: schemaFor(spec),
    prepare: request => {
      const normalized = normalizeTarget(request);
      if ('failure' in normalized) return { invalid: normalized.failure };
      for (const field of spec.required ?? []) {
        if (!hasValue(normalized.target[field])) {
          return { invalid: { code: 'contract.missing_parameter', message: `${atomicId} requires ${field}` } };
        }
      }
      if (spec.anyOf?.length && !spec.anyOf.some(group => group.every(field => hasValue(normalized.target[field])))) {
        return { invalid: { code: 'contract.missing_parameter', message: `${atomicId} requires ${[...new Set(spec.anyOf.flat())].join(' or ')}` } };
      }
      for (const field of spec.positive ?? []) {
        if (normalized.target[field] != null && (!(typeof normalized.target[field] === 'number') || Number(normalized.target[field]) <= 0)) {
          return { invalid: { code: 'contract.invalid_parameter', message: `${atomicId}.${field} must be a positive number` } };
        }
      }
      return { prepared: normalized.target, ...(normalized.derivedFields.length ? { derivedFields: normalized.derivedFields } : {}) };
    },
    normalize: result => normalizeAtomicFailure(result),
  };
}

function schemaFor(spec: ContractSpec): Readonly<Record<string, unknown>> {
  return {
    ...CONTRACT_SCHEMA,
    properties: Object.fromEntries(TARGET_FIELDS.map(field => [field, propertySchema(field)])),
    ...(spec.required?.length ? { required: [...spec.required] } : {}),
    ...(spec.anyOf?.length ? { anyOf: spec.anyOf.map(required => ({ required: [...required] })) } : {}),
  };
}

function propertySchema(field: TargetField): Record<string, unknown> {
  if (field === 'range') return { type: 'number', minimum: 0 };
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

function normalizeTarget(args: Readonly<Record<string, unknown>>):
  | { target: Record<string, unknown>; derivedFields: string[] }
  | { failure: { code: string; message: string } } {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return { failure: { code: 'contract.invalid_arguments', message: 'action args must be an object' } };
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
    if (target[field] !== undefined && !isPosition(target[field], true)) {
      return { failure: { code: 'contract.invalid_parameter', message: `${field} must contain finite x/y/z numbers` } };
    }
  }
  if (target.entityId !== undefined && (!Number.isFinite(target.entityId) || typeof target.entityId !== 'number')) {
    return { failure: { code: 'contract.invalid_parameter', message: 'entityId must be a finite number' } };
  }
  for (const field of ['text', 'itemName', 'behavior', 'fuelName'] as const) {
    if (target[field] !== undefined && (typeof target[field] !== 'string' || !target[field].trim())) {
      return { failure: { code: 'contract.invalid_parameter', message: `${field} must be a non-empty string` } };
    }
  }
  if (target.behaviorParams !== undefined && !isRecord(target.behaviorParams)) {
    return { failure: { code: 'contract.invalid_parameter', message: 'behaviorParams must be an object' } };
  }
  const unresolved = findUnresolvedPlaceholder(target);
  if (unresolved) {
    return {
      failure: {
        code: 'contract.unresolved_placeholder',
        message: `${(target as { $action?: string }).$action ?? 'args'}.${unresolved.path} contains unresolved placeholder ${unresolved.value}`,
      },
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

function normalizeAtomicFailure(result: Readonly<Record<string, unknown>>): { code: string; message: string } | null {
  const ok = (result as { ok?: boolean }).ok !== false;
  const error = (result as { error?: string }).error;
  if (ok) return null;
  return { code: 'atomic_failed', message: error ?? 'atomic execution failed' };
}

function hasValue(value: unknown): boolean {
  return value !== undefined && value !== null && value !== '';
}

/** Build the full contract catalog for the system plugin's ATOMIC_IDS. */
export function buildSystemAtomicContracts(atomicIds: readonly string[]): readonly PluginAtomicContract[] {
  return atomicIds.map(id => buildContract(id, SPECS[id] ?? {}));
}
