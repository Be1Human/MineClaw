import { assertSchemaSupported, validateClosedArguments } from '../../../infra/closedJsonSchema.js';

// FastBrain policy wire contract. Host identity, request authority, budget,
// visible-site binding and outcome evidence never come from the policy.
type Schema = Record<string, unknown>;
const token: Schema = { type: 'string', minLength: 1, maxLength: 128 };
const count: Schema = { type: 'integer', minimum: 1 };
const distance: Schema = { type: 'number', minimum: 0 };
function object(properties: Record<string, Schema>, required = Object.keys(properties)): Schema {
  return { type: 'object', properties, required, additionalProperties: false };
}
const coordinate: Schema = { type: 'integer' };
const site = object({ x: coordinate, y: coordinate, z: coordinate });
const target = object({ target_id: token });
const destination = object({ target_id: token, range: distance }, ['target_id']);
const evidence: Schema = { type: 'array', items: token, maxItems: 32 };
const args = {
  observe: object({}),
  search: object({ kind: token, radius: count }),
  explore: object({ frontier_id: token, radius: count }),
  move_to: destination,
  mine: target,
  pickup: target,
  // FastBrain's place example uses a coordinate. A valid coordinate is
  // not authority: dispatch must match a site in the current observation.
  place: object({ item: token, position: site }),
  craft: object({ recipe: token, count, station_id: token }, ['recipe', 'count']),
  smelt: object({ station_id: token, input: token, count, fuel: token }),
  collect_output: object({ station_id: token, job_id: token }),
  equip: object({ item: token, slot: { enum: ['hand', 'off-hand', 'head', 'torso', 'legs', 'feet'] } }),
  attack: target,
  retreat: destination,
  consume: object({ item: token, count }, ['item']),
  wait: { oneOf: [object({ max_ticks: count }), ...['request_id', 'job_id', 'event'].map(
    field => object({ max_ticks: count, [field]: token }))] },
  cancel: object({ request_id: token }),
} satisfies Record<string, Schema>;
export type FastBrainSkill = keyof typeof args;
export type FastBrainDecision =
  | { readonly type: 'call'; readonly skill: FastBrainSkill; readonly args: Readonly<Record<string, unknown>> }
  | { readonly type: 'finish'; readonly evidence_refs?: readonly string[] }
  | { readonly type: 'report_blocked'; readonly reason: string; readonly evidence_refs?: readonly string[] };

const name = (value: string): Schema => ({ const: value });
const declarations = {
  finish: object({ type: name('finish'), evidence_refs: evidence }, ['type']),
  report_blocked: object({ type: name('report_blocked'), reason: token, evidence_refs: evidence }, ['type', 'reason']),
};
const definitions = Object.freeze([
  ...Object.entries(args).map(([skill, params]) => [skill, object({ type: name('call'), skill: name(skill), args: params })] as const),
  ...Object.entries(declarations),
]);
for (const [, schema] of definitions) assertSchemaSupported(schema as Schema);
const byName = new Map<string, Schema>(definitions as readonly (readonly [string, Schema])[]);

/** For both expert and model; callers cannot change the parser's schema. */
export function fastBrainDecisionCatalog(): ReadonlyArray<{ name: string; schema: Schema }> {
  return Array.from(byName, ([name, schema]) => ({ name, schema: structuredClone(schema) }));
}

/** Parse untrusted JSON without granting device authority or reporting execution. */
export function parseFastBrainDecision(wire: unknown): FastBrainDecision {
  if (wire === null || typeof wire !== 'object' || Array.isArray(wire) || !Object.hasOwn(wire, 'type')) {
    throw new Error('fastbrain_invalid_decision');
  }
  const value = wire as Record<string, unknown>;
  const key = value.type === 'call' ? value.skill : value.type;
  const schema = typeof key === 'string' ? byName.get(key) : undefined;
  if (!schema) throw new Error('fastbrain_unknown_decision');
  validateClosedArguments(value, schema);
  return structuredClone(value) as FastBrainDecision;
}
