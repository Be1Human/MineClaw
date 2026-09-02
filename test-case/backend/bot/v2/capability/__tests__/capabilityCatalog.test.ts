import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CapabilityCatalog } from '../../../../../../apps/minecraft-companion/src/bot/v2/capabilities/capabilityCatalog.js';
import { CapabilityPackageRegistry } from '../../../../../../apps/minecraft-companion/src/bot/v2/capabilities/capabilityPackageRegistry.js';
import { loadCapabilityResourcePackage } from '../../../../../../apps/minecraft-companion/src/bot/v2/capabilities/capabilityManifestLoader.js';
import { parseCapabilityOperation } from '../../../../../../apps/minecraft-companion/src/bot/v2/capabilities/capabilityOperation.js';
import type { CapabilityPackageDefinition } from '../../../../../../apps/minecraft-companion/src/bot/v2/capabilities/types.js';
import { defaultGoalCapabilities } from '../../../../../../apps/minecraft-companion/src/bot/v2/decision/goalAgentPort/goalCapabilityRouter.js';

function operation() {
  return {
    id: 'test.sow', title: '播种', summary: '在指定耕地种下作物', aliases: ['种田', '种一下', 'sow field'],
    kind: 'behavior' as const, mode: 'one_shot' as const,
    executorRef: { kind: 'behavior' as const, id: 'test_sow' }, actionProviderId: 'test.candidates',
    inputSchema: { type: 'object', properties: { seed: { type: 'string' } }, required: ['seed'], additionalProperties: false },
    preconditions: [], effects: [{ id: 'test.crop_present', args: { seed: '$seed' } }],
    verificationRefs: ['test.crop_present'], worldFactRefs: ['test.field'],
    lifecycle: { cancellation: 'cooperative' as const, resumable: false },
  };
}

function definition(): CapabilityPackageDefinition {
  return {
    manifest: {
      schema: 'mineclaw/capability-manifest@2', id: 'test.agriculture', version: 1, description: 'operation-only test',
      goalTargets: [], skills: [], knowledge: [], requires: { atomics: ['place_block'], behaviors: ['test_sow'] },
      operations: [operation()],
    },
    behaviors: [{ id: 'test_sow', kind: 'sequence', compile: () => { throw new Error('discovery must not execute'); } }],
    actionProviders: [{ id: 'test.candidates', list: () => { throw new Error('discovery must not list actions'); } }],
    worldFactProviders: [{ id: 'test.field', observe: () => { throw new Error('discovery must not scan world'); } }],
    predicateEvaluators: [{ id: 'test.crop_present', evaluate: () => { throw new Error('discovery must not evaluate'); } }],
  };
}

function registry() {
  return new CapabilityPackageRegistry({ atomicIds: ['place_block'], behaviorIds: [], skillNames: [], knowledgeIds: [] });
}

test('U01: operation-only @2 registers without inventing a goal template or Skill', () => {
  const reg = registry();
  reg.register(definition());
  const snapshot = reg.snapshot();
  assert.equal(snapshot.goalTargets.length, 0);
  assert.equal(snapshot.operations[0]?.packageId, 'test.agriculture');
  assert.equal(snapshot.operations[0]?.definition.id, 'test.sow');
});

test('U01: YAML @2 operation-only resources load without a knowledge directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'mineclaw-operation-manifest-'));
  try {
    writeFileSync(join(root, 'capability.yaml'), JSON.stringify(definition().manifest));
    const resources = loadCapabilityResourcePackage(root);
    assert.equal(resources.manifest.schema, 'mineclaw/capability-manifest@2');
    assert.equal(resources.knowledgeDocuments.length, 0);
    assert.equal(resources.manifest.operations?.[0]?.id, 'test.sow');
    registry().register({ ...definition(), manifest: resources.manifest });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('U03: missing executor/provider/verifier/facts fail atomically and do not reserve identities', () => {
  const mutations: Array<(pkg: any) => void> = [
    pkg => { pkg.behaviors = []; },
    pkg => { pkg.actionProviders = []; },
    pkg => { pkg.predicateEvaluators = []; },
    pkg => { pkg.worldFactProviders = []; },
    pkg => { pkg.actionProviders = [{ id: 'test.candidates' }]; },
    pkg => { pkg.predicateEvaluators = [{ id: 'test.crop_present' }]; },
    pkg => { pkg.manifest.operations[0].preconditions = [{ id: 'missing', args: {} }]; },
    pkg => { pkg.manifest.requires.behaviors = []; },
    pkg => { pkg.manifest.operations[0].executorRef = { kind: 'atomic', id: 'teleport' }; },
    pkg => { pkg.manifest.operations[0].inputSchema.additionalProperties = true; },
    pkg => { pkg.manifest.operations[0].inputSchema.required = ['undeclared']; },
    pkg => { pkg.manifest.operations.push(operation()); },
    pkg => { pkg.manifest.schema = 'mineclaw/capability-manifest@1'; },
  ];
  for (const mutate of mutations) {
    const reg = registry(), pkg = definition();
    mutate(pkg);
    assert.throws(() => reg.register(pkg));
    assert.equal(reg.snapshot().packages.length, 0);
    assert.equal(reg.snapshot().operations.length, 0);
    reg.register(definition());
    assert.equal(reg.snapshot().operations.length, 1);
  }
});

test('U03: operation identities conflict across otherwise distinct packages', () => {
  const reg = registry(); reg.register(definition());
  const second = definition();
  assert.throws(() => reg.register({ ...second, manifest: { ...second.manifest, id: 'test.other' } }), /duplicate operation/);
  assert.equal(reg.snapshot().packages.length, 1);
});

test('U01/U04: discovered operation is versioned, deterministic, namespaced and read-only', () => {
  const reg = registry(); reg.register(definition());
  const catalog = new CapabilityCatalog({ snapshot: reg.snapshot(), routes: defaultGoalCapabilities() });
  const entry = catalog.search({ query: '帮我把这个田种一下' })[0]!;
  assert.equal(entry.id, 'test.sow');
  assert.equal(entry.layer, 'L4');
  assert.equal(entry.entryKind, 'operation');
  assert.equal(entry, catalog.get(entry.id));
  assert.equal(entry.catalogVersion, catalog.version);
  assert.equal(entry.availability.state, 'unavailable');
  assert.deepEqual(entry.availability.reasons, ['controlled_execution_not_connected']);
  assert.equal(catalog.search({ query: 'sow field' })[0]?.id, entry.id);
  assert.equal(catalog.search({ query: 'seed' })[0]?.id, entry.id);
  assert.deepEqual(catalog.search({ query: '   ' }), []);
  assert.deepEqual(catalog.search({ query: '播种', limit: NaN }), []);
  assert.equal(catalog.search({ query: '播种', limit: 1 }).length, 1);
  assert.equal('execute' in entry, false);
  assert.equal('plan' in entry, false);
  assert.throws(() => { (entry.operation!.executorRef as any).id = 'other'; });
  assert.equal(catalog.version, new CapabilityCatalog({ snapshot: reg.snapshot(), routes: defaultGoalCapabilities().reverse() }).version);
});

test('U03: metadata cannot certify controlled execution or make observations count as ready', () => {
  const reg = registry(); reg.register(definition());
  const catalog = new CapabilityCatalog({ snapshot: reg.snapshot(), routes: [], executionSupport: [
    { kind: 'behavior', id: 'test_sow', controlledCancellation: true },
  ] });
  assert.equal(catalog.get('test.sow')?.availability.state, 'needs_observation');
  assert.ok(catalog.get('test.sow')?.availability.reasons.includes('goal_inputs_scope_and_world_must_be_validated'));
});

test('U01: caller mutations cannot change registered operations or published catalog hashes', () => {
  const original = definition(), reg = registry(); reg.register(original);
  const catalog = new CapabilityCatalog({ snapshot: reg.snapshot(), routes: [] });
  const version = catalog.version;
  (original.manifest.operations![0]!.inputSchema as any).properties.seed.type = 'number';
  assert.equal((catalog.get('test.sow')!.operation!.inputSchema as any).properties.seed.type, 'string');
  assert.equal(catalog.version, version);
  const changed = registry(); changed.register(original);
  assert.notEqual(new CapabilityCatalog({ snapshot: changed.snapshot(), routes: [] }).version, version);
});

test('U03: internal adapters and unregistered strategies remain diagnostic, not executable', () => {
  const catalog = new CapabilityCatalog({ snapshot: registry().snapshot(), routes: [], resources: [
    { id: 'GameAdapter', kind: 'adapter', layer: 'L1', title: '游戏接口', summary: '游戏接口', aliases: [], registered: true, discovery: ['action_list'], invocation: ['injected'] },
    { id: 'guard_strategy', kind: 'strategy', layer: 'L5', title: '守卫', summary: '守卫', aliases: ['GuardStrategy'], registered: false, discovery: [], invocation: [] },
  ] });
  assert.deepEqual(catalog.get('adapter:GameAdapter')?.availability.reasons, ['internal_only']);
  assert.deepEqual(catalog.search({ query: 'GuardStrategy' })[0]?.availability.reasons, ['not_registered']);
});

test('U03: executable, cyclic, unknown and malformed metadata is rejected', () => {
  const cyc: any = {}; cyc.next = cyc;
  for (const value of [
    { ...operation(), script: 'execute()' },
    { ...operation(), effects: [{ id: 'test.crop_present', args: { script: () => true } }] },
    { ...operation(), inputSchema: cyc },
    { ...operation(), id: 'unnamespaced' },
    { ...operation(), verificationRefs: [] },
    { ...operation(), lifecycle: { cancellation: 'cooperative', resumable: false, execute: 'any' } },
  ]) assert.throws(() => parseCapabilityOperation(value));
});

test('U01: @1 package remains discoverable without invented operation bindings', () => {
  const reg = new CapabilityPackageRegistry({ atomicIds: ['place_block'], behaviorIds: [], skillNames: ['test'], knowledgeIds: ['test:knowledge'] });
  const original = definition();
  const { operations: _operations, ...manifest } = original.manifest;
  reg.register({ ...original, manifest: {
    ...manifest, schema: 'mineclaw/capability-manifest@1', skills: ['test'], knowledge: ['test:knowledge'],
    goalTargets: [{ kind: 'state', registryId: 'test:crop', aliases: ['旧播种'], taskFamilies: ['test'],
      successCriteria: [{ type: 'predicate', predicate: 'test.crop_present' }] }],
  } });
  const catalog = new CapabilityCatalog({ snapshot: reg.snapshot(), routes: [] });
  assert.equal(catalog.search({ query: '旧播种' })[0]?.id, 'package:test.agriculture');
  assert.equal(catalog.search({ query: '旧播种' })[0]?.operation, undefined);
  assert.equal(catalog.search({ query: '旧播种' })[0]?.layer, 'cross_layer');
});

test('U06: versioned predicate and fact contracts are discoverable, detached and cannot grant body actions', () => {
  const reg = registry(), pkg = definition();
  const schema = { type: 'object', properties: { count: { type: 'integer', minimum: 1 } }, required: ['count'], additionalProperties: false };
  Object.assign(pkg.predicateEvaluators[0]!, { version: '1', argumentSchema: schema });
  Object.assign(pkg.worldFactProviders![0]!, { version: '1', inputSchema: schema });
  reg.register(pkg);
  schema.properties.count.minimum = 99;
  const catalog = new CapabilityCatalog({ snapshot: reg.snapshot(), routes: [] });
  const predicate = catalog.get('predicate:test.crop_present')!;
  assert.equal(predicate.layer, 'verification');
  assert.deepEqual(predicate.invocation, []);
  assert.deepEqual(predicate.availability.reasons, ['verification_only']);
  assert.equal((predicate.references!.predicate as any).argumentSchema.properties.count.minimum, 1);
  const fact = catalog.get('world_fact:test.field')!;
  assert.equal(fact.layer, 'observation');
  assert.deepEqual(fact.invocation, ['world_observe']);
  assert.equal((fact.references!.worldFact as any).version, '1');
});

test('U06: versioned contracts with missing or unsupported schemas reject the whole package before registration', () => {
  for (const mutation of [
    (pkg: any) => { pkg.predicateEvaluators[0].version = '1'; },
    (pkg: any) => { Object.assign(pkg.predicateEvaluators[0], { version: '1', argumentSchema: { type: 'object', additionalProperties: true } }); },
    (pkg: any) => { Object.assign(pkg.worldFactProviders[0], { version: '1', inputSchema: { type: 'object', additionalProperties: false, $ref: 'external' } }); },
    (pkg: any) => { pkg.worldFactProviders[0].inputSchema = { type: 'object', properties: {}, additionalProperties: false }; },
  ]) {
    const reg = registry(), pkg = definition(); mutation(pkg);
    assert.throws(() => reg.register(pkg)); assert.equal(reg.snapshot().packages.length, 0);
    reg.register(definition());
  }
});

test('U05: goal binding providers require registered code, reject conflicting identities and capture their implementation', () => {
  const reg = registry(), pkg = definition();
  let called = 0;
  const provider = { id: 'test.bindings', list: () => { called++; return []; } };
  pkg.goalBindingProviders = [provider];
  reg.register(pkg);
  provider.list = () => { throw new Error('mutated caller implementation'); };
  assert.deepEqual(reg.snapshot().goalBindingProviders[0]!.list({} as never), []);
  assert.equal(called, 1);
  for (const providers of [[{ id: 'test.bindings' }], [provider, provider]]) {
    const invalid = definition(); invalid.goalBindingProviders = providers as never;
    const empty = registry(); assert.throws(() => empty.register(invalid));
    assert.equal(empty.snapshot().packages.length, 0);
  }
});

test('U09: operation semantics must be code-owned, unique and owned by an operation in the same package', () => {
  for (const mutation of [
    (pkg: any) => { pkg.operationSemantics = [{ operationId: 'missing', version: '1', resolve: () => ({}) }]; },
    (pkg: any) => { pkg.operationSemantics = [{ operationId: 'test.sow', version: '1' }]; },
    (pkg: any) => { pkg.operationSemantics = [1, 2].map(() => ({ operationId: 'test.sow', version: '1', resolve: () => ({}) })); },
  ]) {
    const reg = registry(), pkg = definition(); mutation(pkg);
    assert.throws(() => reg.register(pkg)); assert.equal(reg.snapshot().packages.length, 0);
  }
  const reg = registry(), pkg = definition();
  const resolver = { operationId: 'test.sow', version: '1', resolve: () => ({ requires: [], satisfies: [], accesses: [], estimatedActions: 1 }) };
  (pkg as any).operationSemantics = [resolver]; reg.register(pkg);
  resolver.resolve = () => { throw new Error('caller replaced'); };
  assert.equal(reg.snapshot().operationSemantics[0]!.resolve({ args: {}, state: {} as never }).estimatedActions, 1);
});

test('U18: progress policy registration rejects missing code and duplicate identities without partial registration', () => {
  const provider = { id: 'test.progress', assess: () => null, project: () => ({ stage: 0 }) };
  for (const providers of [[{ id: 'test.progress' }], [provider, provider]]) {
    const reg = registry(), pkg = definition(); (pkg as any).progressProviders = providers;
    assert.throws(() => reg.register(pkg)); assert.equal(reg.snapshot().packages.length, 0);
  }
  const reg = registry(), pkg = definition(); (pkg as any).progressProviders = [provider]; reg.register(pkg);
  provider.assess = () => { throw new Error('caller mutation'); };
  assert.equal(reg.snapshot().progressProviders[0]!.assess({} as never), null);
});
