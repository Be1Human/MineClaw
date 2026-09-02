import assert from 'node:assert/strict';
import test from 'node:test';

import { CapabilityPackageRegistry } from '../../../../../../apps/minecraft-companion/src/bot/v2/capabilities/capabilityPackageRegistry.js';
import type { CapabilityPackageDefinition } from '../../../../../../apps/minecraft-companion/src/bot/v2/capabilities/types.js';
import { resolveProactiveCapabilityCatalog } from '../../../../../../apps/minecraft-companion/src/bot/v2/proactive/contracts.js';

function environment() {
  return {
    atomicIds: ['move_to', 'dig', 'deposit'],
    behaviorIds: ['deposit_to_chest'],
    strategyIds: [],
    skillNames: ['成熟农田归仓'],
    knowledgeIds: ['agriculture:wheat-maturity'],
    goalTargetIds: ['minecraft:wheat'],
  };
}

function packageDefinition(id = 'agriculture.harvest') {
  return {
    manifest: {
      schema: 'mineclaw/capability-manifest@1',
      id,
      version: 1,
      description: 'test capability',
      goalTargets: [{
        kind: 'item',
        registryId: 'mineclaw:mature_crops_to_chest',
        aliases: ['收割农田'],
        taskFamilies: ['agriculture'],
        successCriteriaPolicy: 'authoritative',
        successCriteria: [{ type: 'predicate', predicate: 'agriculture.harvest_to_chest' }],
      }],
      skills: ['成熟农田归仓'],
      knowledge: ['agriculture:wheat-maturity'],
      requires: { atomics: ['move_to', 'dig', 'deposit'], behaviors: ['harvest_mature_crops'] },
    },
    behaviors: [{ id: 'harvest_mature_crops', kind: 'sequence', compile: () => [] }],
    actionProviders: [{ id: 'agriculture.harvest', list: () => [] }],
    worldFactProviders: [{
      id: 'agriculture.mature_crops',
      observe: ({ world }) => ({
        providerId: 'agriculture.mature_crops', observedAt: world.timestamp,
        complete: true, truncated: false, bounds: { radius: 32, limit: 128 },
        value: [], evidenceRefs: ['fact:agriculture.mature_crops:0'],
      }),
    }],
    predicateEvaluators: [{
      id: 'agriculture.harvest_to_chest',
      evaluate: () => ({ ok: true, detail: 'verified' }),
    }],
  } satisfies CapabilityPackageDefinition;
}

test('registers one complete package atomically', () => {
  const registry = new CapabilityPackageRegistry(environment());
  registry.register(packageDefinition());
  const snapshot = registry.snapshot();
  assert.deepEqual(snapshot.packages.map(value => value.manifest.id), ['agriculture.harvest']);
  assert.deepEqual(snapshot.goalTargets.map(value => value.registryId), ['mineclaw:mature_crops_to_chest']);
  assert.deepEqual(snapshot.behaviors.map(value => value.id), ['harvest_mature_crops']);
  assert.deepEqual(snapshot.actionProviders.map(value => value.id), ['agriculture.harvest']);
  assert.deepEqual(snapshot.worldFactProviders.map(value => value.id), ['agriculture.mature_crops']);
  assert.deepEqual(snapshot.predicateEvaluators.map(value => value.id), ['agriculture.harvest_to_chest']);
  assert.deepEqual(snapshot.proactiveTicks, []);
});

test('registers manifest-owned proactive Tick metadata with a code-owned evaluator', async () => {
  const registry = new CapabilityPackageRegistry(environment());
  const value = packageDefinition();
  Object.assign(value.manifest, { proactiveTicks: [{
    id: 'auto_harvest',
    label: '自动收田',
    description: '空闲时收割成熟作物',
    goalTarget: 'mineclaw:mature_crops_to_chest',
    defaultEnabled: false,
    rate: 'idle',
    priority: 20,
    decisionMode: 'deterministic',
    conflictGroups: ['movement'],
    configSchema: {
      radius: { type: 'number', label: '范围', default: 16, min: 4, max: 32 },
    },
  }] });
  Object.assign(value, { proactiveTicks: [{
    id: 'auto_harvest',
    evaluate: () => ({ kind: 'idle', reason: 'test' }),
  }] });
  registry.register(value);

  const snapshot = registry.snapshot();
  assert.deepEqual(snapshot.proactiveTicks.map(entry => entry.manifest.id), ['auto_harvest']);
  assert.deepEqual(await snapshot.proactiveTicks[0]!.implementation.evaluate({
    profileId: 'p1', now: 1, world: null, config: { radius: 16 }, foregroundBusy: false,
    signal: new AbortController().signal,
  }), { kind: 'idle', reason: 'test' });
  assert.deepEqual(resolveProactiveCapabilityCatalog(snapshot.proactiveTicks), [{
    packageId: 'agriculture.harvest',
    id: 'auto_harvest',
    label: '自动收田',
    description: '空闲时收割成熟作物',
    goalTarget: 'mineclaw:mature_crops_to_chest',
    defaultEnabled: false,
    enabled: false,
    rate: 'idle',
    priority: 20,
    decisionMode: 'deterministic',
    conflictGroups: ['movement'],
    configSchema: { radius: { type: 'number', label: '范围', default: 16, min: 4, max: 32 } },
    config: { radius: 16 },
  }]);
  assert.throws(() => resolveProactiveCapabilityCatalog(snapshot.proactiveTicks, {
    auto_harvest: { enabled: true, config: { radius: 99 } },
  }), /radius must be <= 32/);
  assert.deepEqual(resolveProactiveCapabilityCatalog(snapshot.proactiveTicks, {
    future_plugin: { enabled: true, config: { anything: 'retained' } },
  })[0]!.enabled, false);
});

test('proactive Tick declarations fail atomically when incomplete or unsafe', () => {
  const mutations: Array<(value: ReturnType<typeof packageDefinition>) => void> = [
    value => {
      Object.assign(value.manifest, { proactiveTicks: [proactiveManifest()] });
    },
    value => {
      Object.assign(value, { proactiveTicks: [{ id: 'auto_harvest', evaluate: () => ({ kind: 'idle', reason: 'test' }) }] });
    },
    value => {
      Object.assign(value.manifest, { proactiveTicks: [{ ...proactiveManifest(), goalTarget: 'mineclaw:missing' }] });
      Object.assign(value, { proactiveTicks: [{ id: 'auto_harvest', evaluate: () => ({ kind: 'idle', reason: 'test' }) }] });
    },
    value => {
      Object.assign(value.manifest, { proactiveTicks: [{
        ...proactiveManifest(),
        configSchema: { radius: { type: 'number', label: '范围', default: 99, min: 1, max: 32 } },
      }] });
      Object.assign(value, { proactiveTicks: [{ id: 'auto_harvest', evaluate: () => ({ kind: 'idle', reason: 'test' }) }] });
    },
  ];
  for (const mutate of mutations) {
    const registry = new CapabilityPackageRegistry(environment());
    const value = packageDefinition();
    mutate(value);
    assert.throws(() => registry.register(value));
    assert.equal(registry.snapshot().packages.length, 0);
    assert.equal(registry.snapshot().proactiveTicks.length, 0);
  }
});

test('rejects duplicate package, target, provider, evaluator and behavior ids', () => {
  const checks: Array<(value: ReturnType<typeof packageDefinition>) => void> = [
    value => { value.manifest.id = 'agriculture.harvest'; },
    value => { value.manifest.goalTargets[0]!.registryId = 'mineclaw:mature_crops_to_chest'; },
    value => { value.actionProviders[0]!.id = 'agriculture.harvest'; },
    value => { value.worldFactProviders[0]!.id = 'agriculture.mature_crops'; },
    value => { value.predicateEvaluators[0]!.id = 'agriculture.harvest_to_chest'; },
    value => { value.behaviors![0]!.id = 'harvest_mature_crops'; },
  ];
  for (const [index, mutate] of checks.entries()) {
    const registry = new CapabilityPackageRegistry(environment());
    registry.register(packageDefinition());
    const second = packageDefinition(`agriculture.second.${index}`);
    second.manifest.goalTargets[0]!.registryId = `mineclaw:second_${index}`;
    second.actionProviders[0]!.id = `agriculture.second.provider.${index}`;
    second.worldFactProviders[0]!.id = `agriculture.second.fact.${index}`;
    second.predicateEvaluators[0]!.id = `agriculture.second.predicate.${index}`;
    second.manifest.goalTargets[0]!.successCriteria = [{
      type: 'predicate', predicate: second.predicateEvaluators[0]!.id,
    }];
    second.behaviors[0]!.id = `agriculture.second.behavior.${index}`;
    second.manifest.requires.behaviors = [second.behaviors[0]!.id];
    mutate(second);
    assert.throws(() => registry.register(second), /duplicate/);
    assert.equal(registry.snapshot().packages.length, 1);
  }
});

test('fails closed for missing Knowledge, Skill, requires, execution or verification paths', () => {
  const mutations: Array<(value: ReturnType<typeof packageDefinition>) => void> = [
    value => { value.manifest.goalTargets = []; },
    value => { value.manifest.skills = []; },
    value => { value.manifest.knowledge = []; },
    value => { value.manifest.requires.atomics = []; },
    value => { value.actionProviders = []; },
    value => { value.predicateEvaluators = []; },
    value => { value.manifest.goalTargets[0]!.successCriteria = []; },
  ];
  for (const mutate of mutations) {
    const registry = new CapabilityPackageRegistry(environment());
    const value = packageDefinition();
    mutate(value);
    assert.throws(() => registry.register(value));
    assert.equal(registry.snapshot().packages.length, 0);
  }
});

test('knowledge and skill declarations cannot add Atomic permissions', () => {
  const registry = new CapabilityPackageRegistry(environment());
  const value = packageDefinition();
  value.manifest.requires.atomics = ['teleport_player'];
  assert.throws(() => registry.register(value), /unavailable Atomic: teleport_player/);
  assert.equal(registry.snapshot().packages.length, 0);
});

function proactiveManifest() {
  return {
    id: 'auto_harvest',
    label: '自动收田',
    description: '空闲时收割成熟作物',
    goalTarget: 'mineclaw:mature_crops_to_chest',
    defaultEnabled: false,
    rate: 'idle' as const,
    priority: 20,
    decisionMode: 'deterministic' as const,
  };
}
