import { jsonSnapshot } from '../infra/jsonSnapshot.js';

/** Declarative, JSON-only operation metadata. No executable code or permissions. */
export type CapabilityExecutorKind = 'atomic' | 'behavior' | 'task' | 'strategy';

export interface CapabilityPredicateTemplate {
  readonly id: string;
  readonly args: Readonly<Record<string, unknown>>;
}

export interface CapabilityOperationDefinition {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly aliases: readonly string[];
  readonly kind: CapabilityExecutorKind;
  readonly mode: 'one_shot' | 'persistent';
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly executorRef: { readonly kind: CapabilityExecutorKind; readonly id: string };
  readonly actionProviderId: string;
  readonly preconditions: readonly CapabilityPredicateTemplate[];
  readonly effects: readonly CapabilityPredicateTemplate[];
  readonly verificationRefs: readonly string[];
  readonly worldFactRefs: readonly string[];
  readonly lifecycle: {
    readonly cancellation: 'cooperative' | 'boundary_only' | 'unsupported' | 'unknown';
    readonly resumable: boolean;
  };
}

export function parseCapabilityOperation(raw: unknown): CapabilityOperationDefinition {
  const value = jsonSnapshot(raw) as Record<string, unknown>;
  object(value, 'operation');
  const allowed = new Set(['id', 'title', 'summary', 'aliases', 'kind', 'mode', 'inputSchema',
    'executorRef', 'actionProviderId', 'preconditions', 'effects', 'verificationRefs', 'worldFactRefs', 'lifecycle']);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`unknown operation field: ${key}`);
  const id = text(value.id, 'id');
  if (!/^[a-z][a-z0-9_-]*(?:[.:][a-z0-9_-]+)+$/.test(id)) throw new Error('operation id must be namespaced');
  const kind = text(value.kind, 'kind') as CapabilityExecutorKind;
  if (!['atomic', 'behavior', 'task', 'strategy'].includes(kind)) throw new Error('invalid operation kind');
  if (value.mode !== 'one_shot' && value.mode !== 'persistent') throw new Error('invalid operation mode');
  const executor = object(value.executorRef, 'executorRef');
  if (executor.kind !== kind || Object.keys(executor).some(key => !['id', 'kind'].includes(key))) {
    throw new Error('operation executorRef must match kind');
  }
  const schema = object(value.inputSchema, 'inputSchema');
  if (schema.type !== 'object' || schema.additionalProperties !== false) {
    throw new Error('operation inputSchema must be a closed object schema');
  }
  const properties = object(schema.properties, 'inputSchema.properties');
  if (schema.required !== undefined) {
    for (const key of strings(schema.required, 'inputSchema.required')) {
      if (!Object.hasOwn(properties, key)) throw new Error(`operation schema requires undeclared field: ${key}`);
    }
  }
  const lifecycle = object(value.lifecycle, 'lifecycle');
  if (!['cooperative', 'boundary_only', 'unsupported', 'unknown'].includes(String(lifecycle.cancellation))
    || typeof lifecycle.resumable !== 'boolean'
    || Object.keys(lifecycle).some(key => !['cancellation', 'resumable'].includes(key))) {
    throw new Error('invalid operation lifecycle');
  }
  const verificationRefs = strings(value.verificationRefs, 'verificationRefs');
  if (!verificationRefs.length) throw new Error('operation requires verificationRefs');
  return jsonSnapshot({
    id, title: text(value.title, 'title'), summary: text(value.summary, 'summary'),
    aliases: strings(value.aliases, 'aliases'), kind, mode: value.mode,
    inputSchema: schema, executorRef: { kind, id: text(executor.id, 'executorRef.id') },
    actionProviderId: text(value.actionProviderId, 'actionProviderId'),
    preconditions: predicates(value.preconditions, 'preconditions'),
    effects: predicates(value.effects, 'effects'), verificationRefs,
    worldFactRefs: strings(value.worldFactRefs, 'worldFactRefs'), lifecycle,
  }) as unknown as CapabilityOperationDefinition;
}

function predicates(value: unknown, field: string): CapabilityPredicateTemplate[] {
  if (!Array.isArray(value)) throw new Error(`operation ${field} must be an array`);
  return value.map(raw => {
    const entry = object(raw, field);
    if (Object.keys(entry).some(key => !['id', 'args'].includes(key))) throw new Error(`invalid operation ${field}`);
    return { id: text(entry.id, `${field}.id`), args: object(entry.args, `${field}.args`) };
  });
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim()) throw new Error(`invalid operation ${field}`);
  return value;
}

function strings(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new Error(`operation ${field} must be an array`);
  const entries = value.map(item => text(item, field));
  if (new Set(entries).size !== entries.length) throw new Error(`duplicate operation ${field}`);
  return entries;
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`operation ${field} must be an object`);
  return value as Record<string, unknown>;
}
