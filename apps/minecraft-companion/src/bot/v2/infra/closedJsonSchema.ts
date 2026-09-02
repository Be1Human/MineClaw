import { isDeepStrictEqual } from 'node:util';
/** Strict closed JSON schema subset shared by action and predicate contracts. */
const SCHEMA_KEYWORDS = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const',
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minLength', 'maxLength', 'minItems', 'maxItems',
  'anyOf', 'allOf', 'oneOf', 'description', 'title', 'default', 'examples']);

export function assertSchemaSupported(schema: Record<string, unknown>): void {
  for (const key of Object.keys(schema)) if (!SCHEMA_KEYWORDS.has(key)) throw new Error(`unsupported_argument_schema:${key}`);
  if (schema.type !== undefined && !['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(String(schema.type))) {
    throw new Error('invalid_argument_schema:type');
  }
  if (schema.additionalProperties !== undefined && schema.additionalProperties !== false) throw new Error('invalid_argument_schema:open_object');
  for (const key of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minLength', 'maxLength', 'minItems', 'maxItems']) {
    if (schema[key] !== undefined && (typeof schema[key] !== 'number' || !Number.isFinite(schema[key]))) throw new Error(`invalid_argument_schema:${key}`);
  }
  if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some(key => typeof key !== 'string'
    || (isRecord(schema.properties) && !Object.hasOwn(schema.properties, key))))) throw new Error('invalid_argument_schema:required');
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || !schema.enum.length)) throw new Error('invalid_argument_schema:enum');
  if (schema.properties !== undefined) {
    if (!isRecord(schema.properties)) throw new Error('invalid_argument_schema:properties');
    for (const child of Object.values(schema.properties)) {
      if (!isRecord(child)) throw new Error('invalid_argument_schema:property');
      assertSchemaSupported(child);
    }
  }
  if (schema.items !== undefined) {
    if (!isRecord(schema.items)) throw new Error('invalid_argument_schema:items');
    assertSchemaSupported(schema.items);
  }
  for (const operator of ['allOf', 'anyOf', 'oneOf']) {
    const branches = schema[operator];
    if (branches === undefined) continue;
    if (!Array.isArray(branches) || !branches.length) throw new Error(`invalid_argument_schema:${operator}`);
    for (const branch of branches) {
      if (!isRecord(branch)) throw new Error(`invalid_argument_schema:${operator}`);
      assertSchemaSupported(branch);
    }
  }
}


/** Existing opaque, immutable behavior objects are closed over their code-bound shape. */
export function shapeSchema(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return {
    type: 'object', properties: Object.fromEntries(Object.entries(value).map(([key, child]) => [key, shapeSchema(child)])),
    required: Object.keys(value), additionalProperties: false,
  };
  if (Array.isArray(value)) return { type: 'array', items: value.length ? shapeSchema(value[0]) : {} };
  return { type: value === null ? 'null' : typeof value };
}

/** Supported JSON-schema subset is explicit: unknown constraints fail closed, never silently ignored. */
export function validateClosedArguments(
  value: unknown, schema: Record<string, unknown>, fixed: unknown = undefined, path = 'arguments',
): void {
  for (const key of Object.keys(schema)) if (!SCHEMA_KEYWORDS.has(key)) throw new Error(`unsupported_argument_schema:${path}:${key}`);
  const invalid = (reason: string): never => { throw new Error(`invalid_action_arguments:${path}:${reason}`); };
  if (schema.type !== undefined) {
    const matches = schema.type === 'object' ? isRecord(value)
      : schema.type === 'array' ? Array.isArray(value)
        : schema.type === 'integer' ? typeof value === 'number' && Number.isSafeInteger(value)
          : schema.type === 'number' ? typeof value === 'number' && Number.isFinite(value)
            : schema.type === 'null' ? value === null
              : ['string', 'boolean'].includes(String(schema.type)) && typeof value === schema.type;
    if (!matches) invalid(`expected_${String(schema.type)}`);
  }
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || !schema.enum.some(item => isDeepStrictEqual(value, item)))) invalid('enum');
  if (Object.hasOwn(schema, 'const') && !isDeepStrictEqual(value, schema.const)) invalid('const');
  for (const operator of ['allOf', 'anyOf', 'oneOf'] as const) {
    if (schema[operator] === undefined) continue;
    const branches = schema[operator];
    if (!Array.isArray(branches) || !branches.length || branches.some(branch => !isRecord(branch))) invalid(operator);
    let passed = 0;
    for (const branch of branches as Record<string, unknown>[]) {
      try { validateClosedArguments(value, branch, fixed, path); passed += 1; } catch { /* each alternative is checked */ }
    }
    if (operator === 'allOf' ? passed !== (branches as unknown[]).length : operator === 'oneOf' ? passed !== 1 : !passed) invalid(operator);
  }
  if (isRecord(value)) {
    const explicit = isRecord(schema.properties) ? schema.properties : null;
    const properties = explicit ?? (isRecord(fixed) ? (shapeSchema(fixed).properties as Record<string, unknown>) : {});
    // anyOf fragments such as { required: ['position'] } constrain presence, not the parent whitelist.
    const checkFields = schema.type === 'object' || explicit !== null || schema.additionalProperties !== undefined;
    if (schema.additionalProperties === true) invalid('open_objects_not_supported');
    if (schema.required !== undefined) {
      if (!Array.isArray(schema.required) || schema.required.some(key => typeof key !== 'string' || !Object.hasOwn(value, key))) invalid('required');
    }
    if (checkFields) for (const [key, child] of Object.entries(value)) {
      if (!Object.hasOwn(properties, key) || !isRecord(properties[key])) invalid(`unknown_field:${key}`);
      validateClosedArguments(child, properties[key] as Record<string, unknown>, isRecord(fixed) ? fixed[key] : undefined, `${path}.${key}`);
    }
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalid('finite_number');
    for (const bound of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum'] as const) {
      if (schema[bound] === undefined) continue;
      const limit = schema[bound];
      if (typeof limit !== 'number' || !Number.isFinite(limit)) invalid(`invalid_${bound}`);
      if (bound === 'minimum' ? value < (limit as number) : bound === 'maximum' ? value > (limit as number)
        : bound === 'exclusiveMinimum' ? value <= (limit as number) : value >= (limit as number)) invalid(bound);
    }
  }
  if (typeof value === 'string' || Array.isArray(value)) {
    const min = typeof value === 'string' ? schema.minLength : schema.minItems;
    const max = typeof value === 'string' ? schema.maxLength : schema.maxItems;
    if (min !== undefined && (typeof min !== 'number' || value.length < min)) invalid('minimum_length');
    if (max !== undefined && (typeof max !== 'number' || value.length > max)) invalid('maximum_length');
  }
  if (Array.isArray(value)) {
    if (!isRecord(schema.items)) invalid('array_items_schema_required');
    value.forEach((child, index) => validateClosedArguments(child, schema.items as Record<string, unknown>, Array.isArray(fixed) ? fixed[index] : undefined, `${path}[${index}]`));
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
