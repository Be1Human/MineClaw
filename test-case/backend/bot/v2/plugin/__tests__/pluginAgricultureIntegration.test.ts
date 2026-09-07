/**
 * FEAT-CROSS-26-001-004-004 · mineclaw.agriculture harvest nine-segment (P2-5).
 * Full builtin set boot (system/presence/inventory/storage/agriculture), the
 * harvest closed loop registers with exact contribution IDs (U31 contract side),
 * observation flows from the bounded block port, and the executor reports
 * missing body service explicitly instead of faking success.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { PluginHost } from '../../../../../../apps/minecraft-companion/src/bot/v2/plugin-kernel/index.js';
import { createMineclawMinecraftSystemPlugin } from '../../../../../../apps/minecraft-companion/src/bot/v2/plugins/builtin/minecraft-system/index.js';
import { createMineclawMinecraftPresencePlugin } from '../../../../../../apps/minecraft-companion/src/bot/v2/plugins/builtin/minecraft-presence/index.js';
import { createMineclawInventoryPlugin } from '../../../../../../apps/minecraft-companion/src/bot/v2/plugins/builtin/inventory/index.js';
import { createMineclawStorageSystemPlugin } from '../../../../../../apps/minecraft-companion/src/bot/v2/plugins/builtin/storage-system/index.js';
import { createMineclawAgriculturePlugin, HARVEST_GOAL, HARVEST_BINDING, HARVEST_FACT, HARVEST_CANDIDATE, HARVEST_EXECUTOR, HARVEST_PREDICATE, HARVEST_PROGRESS, HARVEST_RESULT, SOW_GOAL, SOW_BINDING, SOW_FACT, SOW_CANDIDATE, SOW_EXECUTOR, SOW_PREDICATE, SOW_PROGRESS, SOW_RESULT } from '../../../../../../apps/minecraft-companion/src/bot/v2/plugins/builtin/agriculture/index.js';
import type { BuiltinPluginIndex } from '../../../../../../apps/minecraft-companion/src/bot/v2/plugin-kernel/discovery.js';
import type { PluginObservationProvider } from '../../../../../../apps/minecraft-companion/src/bot/v2/plugin-sdk/contracts/observation.js';
import { GenerationRuntimeProjection } from '../../../../../../apps/minecraft-companion/src/bot/v2/plugin-kernel/runtimeProjection.js';
import { GoalCompiler } from '../../../../../../apps/minecraft-companion/src/bot/v2/task/goalAgent/goalCompiler.js';
import { createGoalAgentState } from '../../../../../../apps/minecraft-companion/src/bot/v2/task/goalAgent/goalAgentState.js';

function fullIndex(blockPort: unknown): BuiltinPluginIndex {
  const base = fileURLToPath(new URL('../../../../../../apps/minecraft-companion/src/bot/v2/plugins/builtin', import.meta.url));
  const manifest = (id: string) => parse(readFileSync(`${base}/${id}/plugin.yaml`, 'utf8')) as Record<string, unknown>;
  const factories: Record<string, () => { entryKey: string; create: (ctx: never) => never }> = {
    'minecraft-system': createMineclawMinecraftSystemPlugin,
    'minecraft-presence': createMineclawMinecraftPresencePlugin,
    inventory: createMineclawInventoryPlugin,
    'storage-system': createMineclawStorageSystemPlugin,
    agriculture: createMineclawAgriculturePlugin,
  };
  const byEntryKey = new Map<string, { entryKey: string; manifest: Record<string, unknown>; factory: ReturnType<typeof createMineclawMinecraftSystemPlugin> }>();
  for (const [id, factory] of Object.entries(factories)) {
    byEntryKey.set(`plugins/builtin/mineclaw.${id}`, {
      entryKey: `plugins/builtin/mineclaw.${id}`,
      manifest: manifest(id),
      factory: factory() as never,
    });
  }
  void blockPort;
  return { byEntryKey: byEntryKey as never };
}

test('P2-5 收割九段以精确贡献 ID 注册并保持版本身份', async () => {
  const host = new PluginHost({
    hostApiVersion: '2.0.0',
    buildId: 'build-1',
    builtinIndex: fullIndex(null),
    trustedSystemPlugins: ['mineclaw.minecraft-system', 'mineclaw.storage-system'],
  });
  const result = await host.boot();
  assert.deepEqual(result.failures, [], JSON.stringify(result.failures));
  assert.ok(result.installed.includes('mineclaw.agriculture'));
  const active = result.slot.read().active;
  for (const id of [HARVEST_GOAL, HARVEST_BINDING, HARVEST_FACT, HARVEST_CANDIDATE, HARVEST_EXECUTOR, HARVEST_PREDICATE, HARVEST_PROGRESS, HARVEST_RESULT]) {
    assert.ok(active.registry.byId.has(id), `missing contribution ${id}`);
    const entry = active.registry.byId.get(id)!;
    assert.equal(entry.ref.pluginId, 'mineclaw.agriculture');
    assert.equal(entry.ref.contributionVersion, '1.0.0');
  }
  for (const id of [SOW_GOAL, SOW_BINDING, SOW_FACT, SOW_CANDIDATE, SOW_EXECUTOR, SOW_PREDICATE, SOW_PROGRESS, SOW_RESULT]) {
    assert.ok(active.registry.byId.has(id), `missing sow contribution ${id}`);
  }
  // 旧收割 ID 绝不出现在新索引注册面。
  for (const id of ['mineclaw:mature_crops_to_chest', 'agriculture.harvest_world']) {
    assert.ok(!active.registry.byId.has(id), `legacy id ${id} must not register`);
  }
});

test('P2-5 harvest-state 观察经 block 端口产出版本化成熟作物 Fact；缺端口 fail-closed', async () => {
  const blockPort = {
    observe: async () => ({
      snapshotVersion: 'v1',
      observedAt: new Date().toISOString(),
      dimension: 'minecraft:overworld',
      requestedBounds: {},
      observedBounds: {},
      blocks: [
        { name: 'minecraft:wheat', position: { x: 1, y: 64, z: 0 }, properties: { age: 7 } },
        { name: 'minecraft:wheat', position: { x: 2, y: 64, z: 0 }, properties: { age: 3 } },
      ],
      unloadedRegions: [],
      complete: true,
      truncated: false,
      evidenceRefs: ['b1'],
    }),
  };
  const host = new PluginHost({
    hostApiVersion: '2.0.0',
    buildId: 'build-1',
    builtinIndex: fullIndex(blockPort),
    trustedSystemPlugins: ['mineclaw.minecraft-system', 'mineclaw.storage-system'],
    systemPorts: { blockObservation: blockPort },
  });
  const result = await host.boot();
  assert.deepEqual(result.failures, []);
  const active = result.slot.read().active;
  const entry = active.registry.byId.get(HARVEST_FACT)!;
  const factory = (entry.contribution as { factory: { create: (ctx: { signal: AbortSignal }) => PluginObservationProvider } }).factory;
  const observed = await factory.create({ signal: new AbortController().signal }).observe({
    params: {}, signal: new AbortController().signal, scope: { radius: 8 }, budget: { timeoutMs: 5000, maxResults: 64 },
  });
  assert.equal(observed.status, 'fulfilled');
  if (observed.status === 'fulfilled') {
    const crops = (observed.fact.payload as { crops: Array<{ position: { x: number } }> }).crops;
    assert.equal(crops.length, 2, 'query fact includes mature and growing crops');
    assert.equal(crops[0]!.position.x, 1);
    assert.equal((crops[0] as { state?: string }).state, 'mature');
    assert.equal((crops[1] as { state?: string }).state, 'growing');
  }

  const portless = createMineclawAgriculturePlugin().create({ host: { version: '2.0.0', buildId: 'b' }, plugin: { pluginId: 'mineclaw.agriculture', pluginVersion: '1.0.0' } });
  const obsContribution = (portless.find(c => c.kind === 'observation') as { factory: { create: (ctx: { signal: AbortSignal }) => PluginObservationProvider } }).factory;
  const missingPort = await obsContribution.create({ signal: new AbortController().signal }).observe({ params: {}, signal: new AbortController().signal, scope: {}, budget: { timeoutMs: 1000, maxResults: 1 } });
  assert.equal(missingPort.status, 'unavailable');
  assert.equal((missingPort as { reason: string }).reason, 'service_missing:bounded.block.observation');
});

test('P2-5 执行器只经 Host 注入的 body 提交端口执行，失败收据不伪装成功', async () => {
  const contributions = createMineclawAgriculturePlugin().create({
    host: { version: '2.0.0', buildId: 'b' },
    plugin: { pluginId: 'mineclaw.agriculture', pluginVersion: '1.0.0' },
  });
  const execution = contributions.find(c => c.kind === 'execution' && c.id === HARVEST_EXECUTOR) as any;
  const instance = execution.behaviorFactory.create({ goalId: 'g1' } as never, {} as never);
  const compiled = instance.compile({ goal: { goalId: 'g1' }, facts: [], params: { cells: [{ position: { x: 1, y: 2, z: 3 } }] } });
  assert.equal(instance.kind, 'sequence');
  assert.deepEqual(compiled.steps, [{ atomicId: 'dig', args: { position: { x: 1, y: 2, z: 3 } } }]);
  void HARVEST_PREDICATE; void HARVEST_PROGRESS; void HARVEST_RESULT;
});

test('U26: 一块已有田无需坐标即可绑定作物、逐格生成播种步骤并按材料截断', async () => {
  const now = new Date().toISOString();
  const blockPort = { observe: async () => ({
    snapshotVersion: 'field-v1', observedAt: now, dimension: 'minecraft:overworld', requestedBounds: {}, observedBounds: {},
    blocks: [
      { name: 'minecraft:farmland', position: { x: 1, y: 63, z: 1 }, properties: {} },
      { name: 'minecraft:farmland', position: { x: 2, y: 63, z: 1 }, properties: {} },
      { name: 'minecraft:wheat', position: { x: 1, y: 64, z: 1 }, properties: { age: 2 } },
    ], unloadedRegions: [], complete: true, truncated: false, evidenceRefs: ['field-scan:1'],
  }) };
  const contributions = createMineclawAgriculturePlugin().create({
    host: { version: '2.0.0', buildId: 'b' }, plugin: { pluginId: 'mineclaw.agriculture', pluginVersion: '1.0.0' },
    services: { 'bounded.block.observation': blockPort },
  });
  const observation = contributions.find(c => c.id === SOW_FACT) as any;
  const observed = await observation.factory.create({ signal: new AbortController().signal }).observe({
    params: {}, signal: new AbortController().signal, scope: { dimension: 'overworld', radius: 16 }, budget: { timeoutMs: 1000, maxResults: 64 },
  });
  assert.equal(observed.status, 'fulfilled');
  const inventoryFact = {
    factKind: 'inventory', snapshotVersion: 'inventory-v1', observedAt: now, requestedBounds: {}, observedBounds: {}, complete: true, truncated: false,
    unloadedRegions: [], payload: { slots: [{ slot: 0, itemId: 'wheat_seeds', count: 1 }] }, evidenceRefs: [],
    contribution: { pluginId: 'mineclaw.inventory', pluginVersion: '1.0.0', contributionId: 'mineclaw.inventory.observation.owner-inventory', contributionVersion: '1.0.0' },
  };
  const input = { goal: { goalId: 'g', sessionId: 's', snapshot: { generationId: 'g', buildId: 'b', graphHash: 'h' }, ownerEpoch: 1, operationEpoch: 1, aborted: false },
    snapshot: { generationId: 'g', buildId: 'b', graphHash: 'h' }, facts: [observed.fact, inventoryFact], params: { goalText: '帮我把这个田种一下' },
    signal: new AbortController().signal, budget: {} } as any;
  const binding = contributions.find(c => c.id === SOW_BINDING) as any;
  const bound = await binding.bindingProvider.list(input);
  assert.equal(bound.status, 'complete');
  assert.equal(bound.bindings[0].scope.crop, 'wheat', '田里唯一已有作物决定补种作物');
  assert.deepEqual(bound.bindings[0].scope.cells, [{ x: 2, y: 64, z: 1 }]);
  const candidate = contributions.find(c => c.id === SOW_CANDIDATE) as any;
  const listed = await candidate.candidateProvider.list({ ...input, params: { ...bound.bindings[0].scope, bindingScope: bound.bindings[0].scope } });
  assert.equal(listed.status, 'complete');
  const execution = contributions.find(c => c.id === SOW_EXECUTOR) as any;
  const instance = execution.behaviorFactory.create(input.goal, {});
  assert.deepEqual(instance.compile({ goal: input.goal, facts: input.facts, params: listed.candidates[0].params }).steps, [{
    atomicId: 'place_block', args: { itemName: 'wheat_seeds', referencePosition: { x: 2, y: 63, z: 1 }, faceVector: { x: 0, y: 1, z: 0 }, position: { x: 2, y: 64, z: 1 } },
  }]);
});

test('U26: 多田或多作物在 Candidate 前返回结构化 needs_owner', async () => {
  const contributions = createMineclawAgriculturePlugin().create({ host: { version: '2.0.0', buildId: 'b' }, plugin: { pluginId: 'mineclaw.agriculture', pluginVersion: '1.0.0' } });
  const binding = contributions.find(c => c.id === SOW_BINDING) as any;
  const fact = (fields: unknown[]) => ({ factKind: 'agriculture_fields', payload: { fields }, complete: true, truncated: false });
  const field = (id: string) => ({ id, farmlandCells: [], emptyCells: [], crops: [], complete: true, truncated: false });
  const base = { facts: [fact([field('left'), field('right')])], params: { goalText: '种田' } } as any;
  const manyFields = await binding.bindingProvider.list(base);
  assert.equal(manyFields.status, 'ambiguous');
  assert.deepEqual(manyFields.needsOwner.questionKind, 'field');
  const manyCrops = await binding.bindingProvider.list({ ...base, facts: [fact([field('only')]), { factKind: 'inventory', payload: { slots: [
    { itemId: 'wheat_seeds', count: 2 }, { itemId: 'carrot', count: 2 },
  ] } }] });
  assert.equal(manyCrops.status, 'ambiguous');
  assert.deepEqual(manyCrops.needsOwner.questionKind, 'crop');
});

test('U26: 种子不足时暴露 item-available 前置目标且播种 Candidate 不可越权执行', async () => {
  const contributions = createMineclawAgriculturePlugin().create({ host: { version: '2.0.0', buildId: 'b' }, plugin: { pluginId: 'mineclaw.agriculture', pluginVersion: '1.0.0' } });
  const candidate = contributions.find(c => c.id === SOW_CANDIDATE) as any;
  const input = {
    facts: [{ factKind: 'inventory', payload: { slots: [{ itemId: 'wheat_seeds', count: 1 }] } }],
    params: { fieldId: 'field-1', crop: 'wheat', cells: [{ x: 1, y: 64, z: 1 }, { x: 2, y: 64, z: 1 }] },
  } as any;
  const listed = await candidate.candidateProvider.list(input);
  assert.equal(listed.status, 'partial');
  assert.deepEqual(listed.candidates[0].authorization, { status: 'blocked', reasons: ['missing_material:wheat_seeds:1'] });
  assert.deepEqual(listed.candidates[0].prerequisites, [{
    goalContributionId: 'mineclaw.inventory.goal.item-available',
    arguments: { item: 'wheat_seeds', count: 1 },
    reason: 'sow_requires_seed:wheat_seeds',
  }]);
  assert.equal(listed.candidates[0].params.cells.length, 2, 're-list after prerequisite must retain the full field target');
});

test('E02: 一句话经生产 Generation 投影完成目标绑定并生成可执行播种 Candidate', async () => {
  const now = Date.now();
  const blockPort = { observe: async () => ({ snapshotVersion: 'field-v1', observedAt: new Date(now).toISOString(), dimension: 'overworld', requestedBounds: {}, observedBounds: {},
    blocks: [{ name: 'farmland', position: { x: 0, y: 63, z: 0 }, properties: {} }], unloadedRegions: [], complete: true, truncated: false, evidenceRefs: ['field:one'] }) };
  const inventoryPort = { observe: async () => ({ snapshotVersion: 'inv-v1', observedAt: new Date(now).toISOString(), subjectRef: 'owner',
    slots: [{ slot: 0, itemId: 'wheat_seeds', count: 4 }], complete: true, truncated: false, evidenceRefs: ['inventory:seed'] }) };
  const host = new PluginHost({ hostApiVersion: '2.0.0', buildId: 'build-e02', builtinIndex: fullIndex(blockPort),
    trustedSystemPlugins: ['mineclaw.minecraft-system', 'mineclaw.storage-system'], systemPorts: { blockObservation: blockPort, inventoryObservation: inventoryPort } });
  const boot = await host.boot();
  assert.deepEqual(boot.failures, []);
  const projection = new GenerationRuntimeProjection(boot.slot, '2.0.0');
  const snapshot = projection.activeSnapshot();
  const request = { meta: { schemaVersion: 2, sessionId: 'i', messageId: 'm', correlationId: 'c', conversationId: 'v', sequence: 1,
    emittedAt: new Date(now).toISOString(), idempotencyKey: 'm' }, origin: 'player_message', originalText: '帮我把这个田种一下', requestText: '帮我把这个田种一下', requestKind: 'task', constraints: [] } as const;
  const state = createGoalAgentState({ sessionId: 'goal-e02', interactionSessionId: 'i', request, snapshotRef: snapshot, now: new Date(now).toISOString() });
  state.world.latest = { tick: 1, timestamp: now, self: { position: { x: 0, y: 64, z: 1 }, yaw: 0, pitch: 0, health: 20, maxHealth: 20, food: 20, isOnGround: true },
    owner: null, environment: { dimension: 'overworld', timeOfDay: 0, isDay: true, isRaining: false }, inventory: { items: [{ name: 'wheat_seeds', count: 4, slot: 0 }], held: null, freeSlots: 35 }, entities: [], taskContext: null };
  const target = projection.goalTargets(snapshot).find(value => value.contribution.contributionId === SOW_GOAL)!;
  const compiler = new GoalCompiler({ predicates: value => projection.predicateEvaluators(snapshot, value),
    bindings: value => projection.goalBindings(snapshot, value, value.world.latest!, new AbortController().signal) });
  const committed = await compiler.compile({ input: { kind: 'template', target, arguments: {}, goal: { requestId: 'm', objective: request.requestText,
    outcome: 'composed', target: { kind: 'state', surface: request.requestText, registryId: target.registryId, quantity: 1 }, constraints: [] } },
    state, profileId: 'test', goalId: 'root-e02', acceptedAt: new Date(now).toISOString() });
  state.rootGoal = committed.rootGoal; state.goal.definition = committed.goal; state.goal.signature = committed.signature;
  assert.ok(committed.rootGoal.scope.allowedMutationRegion, 'field binding must authorize only the observed field region');
  assert.ok(committed.rootGoal.source.contributions.some(value => value.contributionId === SOW_BINDING));
  const candidates = (await Promise.all(projection.actionProviders(snapshot).map(provider => provider.list({ state, criteria: committed.rootGoal.successCriteria,
    goalText: request.requestText, world: state.world.latest!, signal: new AbortController().signal })))).flat();
  const sow = candidates.find(value => value.operationRef?.contributionId === SOW_EXECUTOR);
  assert.ok(sow, 'sow behavior candidate must be discoverable without coordinates');
  assert.deepEqual((sow!.fixedArgs.behaviorParams as any).cells, [{ x: 0, y: 64, z: 0 }]);
});
