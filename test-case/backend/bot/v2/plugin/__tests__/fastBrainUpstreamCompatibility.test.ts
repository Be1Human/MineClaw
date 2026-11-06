import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import {
  fastBrainDecisionCatalog,
  parseFastBrainDecision,
} from '../../../../../../apps/minecraft-companion/src/bot/v2/plugins/builtin/fastbrain/decisionContract.js';

// Independent protocol audit only. Every value here is synthetic; importing the
// parser does not launch a game, a runtime, a model, or training. External
// examples are read in place, never copied into the public source tree.
const upstreamRoot = process.env.FASTBRAIN_UPSTREAM_ROOT;
const upstreamOptions = { skip: upstreamRoot ? false : 'Set FASTBRAIN_UPSTREAM_ROOT to audit the upstream repository examples.' };
const python = process.env.FASTBRAIN_AUDIT_PYTHON || 'python3';
const upstreamFile = (...parts: string[]): string => join(resolve(upstreamRoot!), ...parts);

const calls: Record<string, Record<string, unknown>> = {
  observe: {},
  search: { kind: 'oak_log', radius: 5 },
  explore: { frontier_id: 'frontier_visible_1', radius: 5 },
  move_to: { target_id: 'nav_visible_1', range: 0 },
  mine: { target_id: 'block_visible_1' },
  pickup: { target_id: 'drop_visible_1' },
  place: { item: 'crafting_table', position: { x: 1, y: 64, z: 0 } },
  craft: { recipe: 'stone_pickaxe', count: 1, station_id: 'station_visible_1' },
  smelt: { station_id: 'furnace_visible_1', input: 'raw_iron', count: 1, fuel: 'coal' },
  collect_output: { station_id: 'furnace_visible_1', job_id: 'existing_job_1' },
  equip: { item: 'shield', slot: 'off-hand' },
  attack: { target_id: 'entity_visible_1' },
  retreat: { target_id: 'safe_nav_visible_1', range: 2 },
  consume: { item: 'bread', count: 1 },
  wait: { request_id: 'existing_request_1', max_ticks: 10 },
  cancel: { request_id: 'existing_request_1' },
};
const declarationInputs = [
  { type: 'finish', evidence_refs: ['observed_inventory_1'] },
  { type: 'report_blocked', reason: 'missing_material', evidence_refs: ['observed_inventory_1'] },
];
const hostFields = {
  session_id: 'spoofed_session', bot_id: 'spoofed_bot', version: 99,
  schema_version: 'spoofed/v99', budget: { remaining_calls: 999 },
  timeout_ticks: 999, deadline: 999, authority: 'spoofed', grant: 'spoofed',
  observation_id: 'spoofed', epoch: 999, canonical_goal: { skill: 'mine' },
  teacher_route: 'spoofed', execution_result: { status: 'success' },
  reward: 1, metadata: { training_eligible: true },
};
const call = (skill: string, args: unknown): Record<string, unknown> => ({ type: 'call', skill, args });
const reject = (value: unknown, label: string): void => {
  assert.throws(() => parseFastBrainDecision(value), Error, label);
};

test('UA01: exactly 18 names split into 16 calls and 2 declarations', () => {
  const catalog = fastBrainDecisionCatalog();
  const expected = [...Object.keys(calls), 'finish', 'report_blocked'].sort();
  assert.equal(Object.keys(calls).length, 16);
  assert.equal(catalog.length, 18);
  assert.equal(new Set(catalog.map(entry => entry.name)).size, 18);
  assert.deepEqual(catalog.map(entry => entry.name).sort(), expected);
  for (const name of Object.keys(calls)) assert.deepEqual(parseFastBrainDecision(call(name, calls[name])), call(name, calls[name]));
  for (const value of declarationInputs) assert.deepEqual(parseFastBrainDecision(value), value);
  reject(call('finish', {}), 'finish cannot be a call');
  reject(call('report_blocked', { reason: 'missing_material' }), 'report_blocked cannot be a call');
});

test('UA02: upstream interface table agrees with the real parser catalog', upstreamOptions, () => {
  const doc = readFileSync(upstreamFile('docs', 'training-plan.md'), 'utf8');
  const section = doc.split('## 快脑接口与执行约束')[1]?.split('\n## ')[0];
  assert.ok(section, 'upstream protocol section must exist');
  const names = [...section.matchAll(/^\| ([a-z_]+) \|/gm)].map(match => match[1]);
  assert.equal(names.length, 18);
  assert.deepEqual(names.sort(), fastBrainDecisionCatalog().map(entry => entry.name).sort());
});

test('UA03: official generator reproduces the committed synthetic sample artifact', upstreamOptions, () => {
  const committed = JSON.parse(readFileSync(upstreamFile('examples', 'synthesized_samples.example.json'), 'utf8'));
  const generated = JSON.parse(execFileSync(python, ['-B', upstreamFile('examples', 'synthesize_example.py')], {
    encoding: 'utf8', timeout: 15_000, maxBuffer: 1_000_000,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  }));
  assert.deepEqual(generated, committed);
  assert.equal(committed.artifact_kind, 'illustrative_synthesis');
  assert.deepEqual(committed.counts, {
    real_episodes: 0, synthetic_source_decisions: 1, instruction_variants: 3, derived_samples: 3,
  });
  assert.equal(new Set(committed.samples.map((sample: any) => sample.metadata.source_decision_id)).size, 1);
  assert.equal(new Set(committed.samples.map((sample: any) => sample.input.instruction)).size, 3);
  for (const sample of committed.samples) {
    assert.equal(sample.metadata.data_kind, 'synthetic_fixture');
    assert.equal(sample.metadata.training_eligible, false);
    assert.equal(sample.split, 'example_only');
    assert.equal(sample.metadata.sampling_weight, 1 / 3);
  }
});

test('UA04: official sample targets are parsed unchanged; envelopes and hidden fields are refused', upstreamOptions, async t => {
  const artifact = JSON.parse(readFileSync(upstreamFile('examples', 'synthesized_samples.example.json'), 'utf8'));
  assert.equal(artifact.samples.length, 3);
  for (const sample of artifact.samples) await t.test(sample.sample_id, () => {
    assert.deepEqual(parseFastBrainDecision(sample.target), sample.target);
    reject(sample, 'sample envelope is not a policy decision');
    reject(sample.input, 'observation and host budget are not a policy decision');
    reject({ ...sample.target, metadata: sample.metadata }, 'teacher metadata stays outside policy output');
    reject({ ...sample.target, canonical_goal: sample.metadata.canonical_goal }, 'hidden goal cannot be output authority');
    reject({ ...sample.target, args: { ...sample.target.args, budget: sample.input.budget } }, 'policy cannot supply a host budget');
  });
});

test('UA05: real upstream demonstration tree emits parser-compatible outputs on eight synthetic branches', upstreamOptions, async t => {
  const code = `
import sys, json
from copy import deepcopy
sys.path.insert(0, sys.argv[1])
from synthesize_example import CANONICAL_GOAL, OBSERVATION
from behavior_tree_expert import next_action
cases = []
def add(name, **patch):
    obs = deepcopy(OBSERVATION)
    obs.update(patch)
    cases.append({'name': name, 'target': next_action(deepcopy(CANONICAL_GOAL), obs)})
add('place')
add('wait', active_request='existing_request_1')
add('finish', item_events=[{'source': 'craft', 'item': 'stone_pickaxe', 'quantity': 1}])
add('missing_material', inventory={'cobblestone': 2, 'stick': 2, 'crafting_table': 1})
add('inventory_full', free_slots=0)
add('move_to', stations=[{'id': 'station_visible_1', 'type': 'crafting_table', 'in_reach': False}])
add('craft', stations=[{'id': 'station_visible_1', 'type': 'crafting_table', 'in_reach': True}])
add('missing_usable_station', inventory={'cobblestone': 3, 'stick': 2})
print(json.dumps(cases))
`;
  const actual = JSON.parse(execFileSync(python, ['-B', '-c', code, upstreamFile('examples')], {
    encoding: 'utf8', timeout: 15_000, maxBuffer: 1_000_000,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  }));
  const expected = {
    place: call('place', { item: 'crafting_table', position: { x: 1, y: 64, z: 0 } }),
    wait: call('wait', { request_id: 'existing_request_1', max_ticks: 10 }),
    finish: { type: 'finish' },
    missing_material: { type: 'report_blocked', reason: 'missing_material' },
    inventory_full: { type: 'report_blocked', reason: 'inventory_full' },
    move_to: call('move_to', { target_id: 'station_visible_1' }),
    craft: call('craft', { recipe: 'stone_pickaxe', count: 1, station_id: 'station_visible_1' }),
    missing_usable_station: { type: 'report_blocked', reason: 'missing_usable_station' },
  };
  assert.deepEqual(actual.map((entry: any) => entry.name).sort(), Object.keys(expected).sort());
  for (const entry of actual) await t.test(entry.name, () => {
    assert.deepEqual(entry.target, expected[entry.name as keyof typeof expected]);
    assert.deepEqual(parseFastBrainDecision(entry.target), entry.target);
  });
});

for (const [skill, args] of Object.entries(calls)) {
  test(`UA06/${skill}: reject host-owned envelope and argument fields`, () => {
    const input = call(skill, args);
    assert.deepEqual(parseFastBrainDecision(input), input);
    for (const [field, value] of Object.entries(hostFields)) {
      reject({ ...input, [field]: value }, `${skill} top-level ${field}`);
      reject(call(skill, { ...args, [field]: value }), `${skill} argument ${field}`);
    }
    reject({ ...input, request_id: 'spoofed_new_request' }, `${skill} cannot choose its envelope request ID`);
    // Existing request references are valid only in wait/cancel arguments;
    // this says nothing about their runtime ownership or authorization.
    if (skill !== 'wait' && skill !== 'cancel') reject(call(skill, { ...args, request_id: 'spoofed_new_request' }), `${skill} has no request selector`);
  });
}

for (const value of declarationInputs) {
  test(`UA07/${value.type}: declaration metadata cannot impersonate host authority`, () => {
    for (const [field, data] of Object.entries(hostFields)) reject({ ...value, [field]: data }, field);
    reject({ ...value, request_id: 'spoofed' }, 'host request ID');
    reject({ ...value, skill: 'mine', args: { target_id: 'block_visible_1' } }, 'declaration cannot carry a body call');
  });
}

test('UA08: malformed roots, discriminators and JSON decisions are refused', () => {
  for (const value of [null, undefined, true, false, 0, NaN, [], 'null', '{"type":"finish"}', {},
    { skill: 'mine', args: { target_id: 'x' } }, { type: null }, { type: 'CALL', skill: 'observe', args: {} },
    { type: 'call', skill: 'give', args: {} }, { type: 'call', skill: 'finish', args: {} },
    { type: 'call', skill: 'report_blocked', args: { reason: 'missing_material' } },
    { type: 'finish', skill: 'observe', args: {} }, { type: 'report_blocked' },
    { type: 'report_blocked', reason: '' }]) reject(value, 'malformed root or declaration');
  const inheritedType = Object.create({ type: 'finish' });
  reject(inheritedType, 'type must be an own property');
  reject(JSON.parse('{"type":"finish","__proto__":{"authority":"spoofed"}}'), 'prototype-looking JSON field is still extra');
});

test('UA09: all calls require closed object arguments and their mandatory fields', () => {
  const required: Record<string, string[]> = {
    observe: [], search: ['kind', 'radius'], explore: ['frontier_id', 'radius'], move_to: ['target_id'],
    mine: ['target_id'], pickup: ['target_id'], place: ['item', 'position'], craft: ['recipe', 'count'],
    smelt: ['station_id', 'input', 'count', 'fuel'], collect_output: ['station_id', 'job_id'],
    equip: ['item', 'slot'], attack: ['target_id'], retreat: ['target_id'], consume: ['item'],
    wait: ['max_ticks'], cancel: ['request_id'],
  };
  for (const [skill, args] of Object.entries(calls)) {
    reject({ type: 'call', skill }, `${skill}: missing args`);
    for (const invalid of [null, [], 1, true, 'args']) reject(call(skill, invalid), `${skill}: args must be an object`);
    for (const field of required[skill]) {
      const copy = structuredClone(args); delete copy[field];
      reject(call(skill, copy), `${skill}: missing ${field}`);
    }
  }
});

test('UA10: positive quantities and finite, nonnegative ranges cannot be bypassed by coercion', () => {
  for (const [skill, field] of [['search', 'radius'], ['explore', 'radius'], ['craft', 'count'], ['smelt', 'count'], ['consume', 'count'], ['wait', 'max_ticks']]) {
    for (const invalid of [0, -1, 0.5, '1', true, null, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      reject(call(skill, { ...calls[skill], [field]: invalid }), `${skill}.${field}=${String(invalid)}`);
    }
  }
  for (const skill of ['move_to', 'retreat']) {
    assert.deepEqual(parseFastBrainDecision(call(skill, { target_id: 'nav_1', range: 0 })), call(skill, { target_id: 'nav_1', range: 0 }));
    for (const invalid of [-1, '0', true, null, NaN, Infinity]) reject(call(skill, { ...calls[skill], range: invalid }), `${skill} range`);
  }
});

test('UA11: nested placement coordinates reject fractional, missing and additional data', () => {
  for (const axis of ['x', 'y', 'z']) {
    for (const invalid of [0.5, '1', null, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) reject(call('place', {
      item: 'crafting_table', position: { x: 0, y: 64, z: 0, [axis]: invalid },
    }), `position.${axis}`);
    const position: Record<string, unknown> = { x: 0, y: 64, z: 0 }; delete position[axis];
    reject(call('place', { item: 'crafting_table', position }), `missing ${axis}`);
  }
  reject(call('place', { item: 'crafting_table', position: { x: 1, y: 64, z: 0, authority: 'spoofed' } }), 'nested authority');
});

test('UA12: wait permits one or zero selectors but never conflicting selectors', () => {
  const selectors = { request_id: 'existing_request_1', job_id: 'existing_job_1', event: 'existing_event_1' };
  const names = Object.keys(selectors);
  for (let mask = 0; mask < 8; mask += 1) {
    const args: Record<string, unknown> = { max_ticks: 10 };
    const selected = names.filter((_, index) => mask & (1 << index));
    for (const name of selected) args[name] = selectors[name as keyof typeof selectors];
    if (selected.length <= 1) assert.deepEqual(parseFastBrainDecision(call('wait', args)), call('wait', args));
    else reject(call('wait', args), `conflicting wait selectors: ${selected.join(',')}`);
  }
});

test('UA13: tokens, evidence references and equipment slots enforce declared bounds', () => {
  assert.deepEqual(parseFastBrainDecision(call('mine', { target_id: 't'.repeat(128) })), call('mine', { target_id: 't'.repeat(128) }));
  for (const invalid of ['', 't'.repeat(129), 1, null, {}, []]) reject(call('mine', { target_id: invalid }), 'invalid target token');
  for (const slot of ['hand', 'off-hand', 'head', 'torso', 'legs', 'feet']) assert.deepEqual(parseFastBrainDecision(call('equip', { item: 'fixture_item', slot })), call('equip', { item: 'fixture_item', slot }));
  for (const slot of ['offhand', 'body', 1, null]) reject(call('equip', { item: 'fixture_item', slot }), 'invalid slot');
  for (const type of ['finish', 'report_blocked']) {
    const declaration = type === 'finish' ? { type } : { type, reason: 'missing_material' };
    assert.deepEqual(parseFastBrainDecision({ ...declaration, evidence_refs: Array.from({ length: 32 }, (_, i) => `ref_${i}`) }), { ...declaration, evidence_refs: Array.from({ length: 32 }, (_, i) => `ref_${i}`) });
    for (const refs of [Array.from({ length: 33 }, () => 'ref'), [''], [1], 'ref', null]) reject({ ...declaration, evidence_refs: refs }, 'invalid evidence list');
  }
});

test('UA14: parsed decisions and returned schema snapshots cannot mutate parser state', () => {
  const wire = call('place', { item: 'crafting_table', position: { x: 1, y: 64, z: 0 } });
  const parsed = parseFastBrainDecision(wire);
  assert.equal(parsed.type, 'call');
  const position = (parsed as any).args.position;
  position.x = 42;
  assert.equal(((wire.args as any).position).x, 1);
  assert.equal((parseFastBrainDecision(wire) as any).args.position.x, 1);
  const finish = { type: 'finish', evidence_refs: ['ref_1'] };
  const finishCopy = parseFastBrainDecision(finish) as any;
  finishCopy.evidence_refs.push('ref_2');
  assert.deepEqual(finish.evidence_refs, ['ref_1']);
  const catalog = fastBrainDecisionCatalog();
  const mine = catalog.find(entry => entry.name === 'mine')!;
  (mine.schema.properties as any).args.additionalProperties = true;
  (mine.schema.properties as any).args.properties.target_id.minLength = 0;
  reject(call('mine', { target_id: '' }), 'catalog mutation cannot relax token validation');
  reject(call('mine', { target_id: 'x', authority: 'spoofed' }), 'catalog mutation cannot open the parser');
});

test('UA15: parser acceptance alone does not assert visibility, effect, or completion', () => {
  // These are syntactically valid references only. Runtime registration,
  // authority, budgets and an independent finish verifier remain mandatory.
  for (const value of [call('mine', { target_id: 'unregistered_fixture_target' }),
    call('place', { item: 'crafting_table', position: { x: 1000, y: 64, z: 1000 } }),
    call('cancel', { request_id: 'unregistered_fixture_request' }), { type: 'finish' }]) {
    assert.deepEqual(parseFastBrainDecision(value), value);
    assert.equal(Object.hasOwn(parseFastBrainDecision(value), 'status'), false);
  }
});
