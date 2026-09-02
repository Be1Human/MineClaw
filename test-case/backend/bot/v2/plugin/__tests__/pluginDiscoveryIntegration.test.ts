/**
 * FEAT-CROSS-26-001-004-002 · Plugin discovery integration (U28, I07).
 * A first-party test plugin discovered from a generated builtin index must
 * register without touching V2Runtime; data/plugins hosts Knowledge/Skill only
 * and rejects code entries.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginHost, type PluginHostConfig } from '../../../../../../apps/minecraft-companion/src/bot/v2/plugin-kernel/index.js';
import type { BuiltinPluginIndex, PluginFactory } from '../../../../../../apps/minecraft-companion/src/bot/v2/plugin-kernel/discovery.js';

const CODE_KINDS = new Set(['observation', 'planning', 'verification', 'execution', 'result', 'proactive', 'integration']);

function factoryFor(entryKey: string, contributions: unknown[]): PluginFactory {
  return {
    entryKey,
    create: () => contributions as never,
  };
}

/** Declarations that need no code (goal/skill/knowledge) become implementations directly. */
function implFromDeclarations(manifest: Record<string, unknown>): unknown[] {
  const declarations = (manifest.contributions as Array<Record<string, unknown>>) ?? [];
  return declarations.filter((contribution) => !CODE_KINDS.has(String(contribution.kind))).map((contribution) => ({ ...contribution }));
}

function kitchenIndex(): BuiltinPluginIndex {
  const manifest = {
    schema: 'mineclaw.plugin/v1', id: 'mineclaw.kitchen', version: '1.0.0', apiVersion: '^2.0.0',
    kind: 'domain', entry: 'plugins/builtin/kitchen',
    dependencies: {}, permissions: ['world.read:bounded-block-snapshot'],
    contributions: [
      {
        kind: 'goal', id: 'mineclaw.kitchen.goal.cook', version: '1.0.0',
        target: { registryId: 'mineclaw.kitchen.goal.cook', goalKind: 'composite', aliases: ['做饭'], successCriteria: [{ type: 'predicate', predicate: 'mineclaw.kitchen.predicate.cooked' }] },
      },
      {
        kind: 'skill', id: 'mineclaw.kitchen.skill.cooking', version: '1.0.0', entryRef: 'skills/cooking.md',
      },
    ],
  };
  return {
    byEntryKey: new Map([
      ['plugins/builtin/kitchen', { entryKey: 'plugins/builtin/kitchen', manifest, factory: factoryFor('plugins/builtin/kitchen', implFromDeclarations(manifest)) }],
    ]),
  };
}

function hostConfig(overrides: Partial<PluginHostConfig> = {}): PluginHostConfig {
  return {
    hostApiVersion: '2.0.0',
    buildId: 'build-test-1',
    builtinIndex: kitchenIndex(),
    trustedSystemPlugins: ['mineclaw.minecraft-system'],
    ...overrides,
  };
}

test('I07/U28 内建索引插件零核心修改被发现并注册；数据插件只加载 Knowledge/Skill', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'mineclaw-plugins-'));
  try {
    const { createHash } = await import('node:crypto');
    const digest = createHash('sha256').update('crops.yaml:crops:\n  - wheat\n').digest('hex');
    mkdirSync(join(dataRoot, 'mineclaw.facts'), { recursive: true });
    writeFileSync(join(dataRoot, 'mineclaw.facts', 'crops.yaml'), 'crops:\n  - wheat\n');
    writeFileSync(join(dataRoot, 'mineclaw.facts', 'plugin.yaml'), `schema: mineclaw.plugin/v1
id: mineclaw.facts
version: 1.0.0
apiVersion: ^2.0.0
kind: data
dependencies: {}
permissions: []
contributions:
  - kind: knowledge
    id: mineclaw.facts.knowledge.crops
    version: 1.0.0
    contentRef: crops.yaml
integrity:
  contentSha256: ${digest}
`);

    const host = new PluginHost(hostConfig({ dataPluginRoot: dataRoot }));
    const result = await host.boot();
    assert.deepEqual(result.failures, [], JSON.stringify(result.failures));
    assert.ok(result.installed.includes('mineclaw.kitchen'));
    assert.ok(result.installed.includes('mineclaw.facts'));
    const active = result.slot.read().active;
    assert.ok(active.registry.byId.has('mineclaw.kitchen.skill.cooking'));
    assert.ok(active.registry.byId.has('mineclaw.facts.knowledge.crops'));
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('I07 数据目录包含代码入口/非数据插件被拒且不影响其他包', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'mineclaw-plugins-'));
  try {
    mkdirSync(join(dataRoot, 'mineclaw.badcode'), { recursive: true });
    writeFileSync(join(dataRoot, 'mineclaw.badcode', 'plugin.yaml'), `schema: mineclaw.plugin/v1
id: mineclaw.badcode
version: 1.0.0
apiVersion: ^2.0.0
kind: domain
entry: evil.js
dependencies: {}
permissions: []
contributions: []
`);
    const host = new PluginHost(hostConfig({ dataPluginRoot: dataRoot }));
    const result = await host.boot();
    const failure = result.failures.find((f) => f.pluginId === 'mineclaw.badcode');
    assert.ok(failure, 'badcode package must fail');
    assert.ok(!result.installed.includes('mineclaw.badcode'));
    assert.ok(result.installed.includes('mineclaw.kitchen'), 'existing package must not be polluted');
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('U28 完整执行贡献经内核注册并保留身份与权限', async () => {
  const manifestation = {
    schema: 'mineclaw.plugin/v1', id: 'mineclaw.oven', version: '2.1.0', apiVersion: '^2.0.0',
    kind: 'domain', entry: 'plugins/builtin/oven',
    dependencies: {},
    permissions: ['body.submit:mineclaw.minecraft-system.atomic.move-to'],
    contributions: [
      {
        kind: 'goal', id: 'mineclaw.oven.goal.bake', version: '1.0.0',
        target: { registryId: 'mineclaw.oven.goal.bake', goalKind: 'composite', aliases: ['烤'], successCriteria: [{ type: 'predicate', predicate: 'mineclaw.oven.predicate.baked' }] },
      },
      {
        kind: 'execution', id: 'mineclaw.oven.execution.bake', version: '1.0.0',
        operation: {
          operationId: 'mineclaw.oven.operation.bake',
          goalContributionId: 'mineclaw.oven.goal.bake',
          bindingContributionId: 'mineclaw.oven.goal.bake',
          factKinds: ['self_location'],
          candidateContributionId: 'mineclaw.oven.planning.candidates',
          predicateContributionId: 'mineclaw.oven.predicate.baked',
          progressContributionId: 'mineclaw.oven.planning.progress',
          resultContributionId: 'mineclaw.oven.result.bake',
          cancellable: true,
        },
      },
      {
        kind: 'planning', id: 'mineclaw.oven.planning.candidates', version: '1.0.0',
        operationIds: ['mineclaw.oven.operation.bake'],
      },
      { kind: 'planning', id: 'mineclaw.oven.planning.progress', version: '1.0.0', operationIds: ['mineclaw.oven.operation.bake'] },
      { kind: 'verification', id: 'mineclaw.oven.predicate.baked', version: '1.0.0' },
      { kind: 'result', id: 'mineclaw.oven.result.bake', version: '1.0.0' },
    ],
  };
  const implementations: Array<Record<string, unknown>> = [
    ...implFromDeclarations(manifestation),
    {
      kind: 'execution', id: 'mineclaw.oven.execution.bake', version: '1.0.0',
      operation: (manifestation.contributions.find((c) => c.kind === 'execution') as Record<string, unknown>).operation,
      behaviorFactory: { id: 'mineclaw.oven.execution.bake', version: '1.0.0', create: () => ({ instanceId: 'i1', contribution: { pluginId: 'x', pluginVersion: 'x', contributionId: 'x', contributionVersion: 'x' }, run: async () => ({ ok: true, cancelled: false }), halt: async () => undefined, close: async () => undefined, settled: true }) },
    },
    {
      kind: 'planning', id: 'mineclaw.oven.planning.candidates', version: '1.0.0',
      candidateProvider: { id: 'p', list: async () => ({ status: 'complete', candidates: [] }) },
      progressProvider: { id: 'pr', assess: async () => ({ status: 'unavailable', progress: null }) },
    },
    {
      kind: 'planning', id: 'mineclaw.oven.planning.progress', version: '1.0.0',
      candidateProvider: { id: 'q', list: async () => ({ status: 'complete', candidates: [] }) },
    },
    {
      kind: 'verification', id: 'mineclaw.oven.predicate.baked', version: '1.0.0',
      predicates: [{ id: 'mineclaw.oven.predicate.baked', version: '1.0.0', evaluate: async () => ({ verdict: 'unknown', evidenceRefs: [], contribution: { pluginId: 'x', pluginVersion: 'x', contributionId: 'x', contributionVersion: 'x' } }) }],
    },
    {
      kind: 'result', id: 'mineclaw.oven.result.bake', version: '1.0.0',
      projection: { id: 'r', version: '1.0.0', project: async () => ({ status: 'projected', output: { presentation: {}, audience: 'owner', summary: 'ok', evidenceRefs: [], contribution: { pluginId: 'x', pluginVersion: 'x', contributionId: 'x', contributionVersion: 'x' } } }) },
    },
  ];
  const index: BuiltinPluginIndex = {
    byEntryKey: new Map([['plugins/builtin/oven', { entryKey: 'plugins/builtin/oven', manifest: manifestation, factory: factoryFor('plugins/builtin/oven', implementations) }]]),
  };
  const host = new PluginHost(hostConfig({ builtinIndex: index }));
  const result = await host.boot();
  assert.deepEqual(result.failures, [], JSON.stringify(result.failures));
  const record = result.slot.read().active;
  assert.ok(record.registry.byId.has('mineclaw.oven.predicate.baked'));
  assert.equal(record.manifests.find((m) => m.id === 'mineclaw.oven')!.version, '2.1.0');
});

test('I08 事务失败包不污染其他包，且零部分状态', async () => {
  const brokenManifest = {
    schema: 'mineclaw.plugin/v1', id: 'mineclaw.broken', version: '1.0.0', apiVersion: '^2.0.0',
    kind: 'domain', entry: 'plugins/builtin/broken',
    dependencies: {}, permissions: ['world.read:bounded-block-snapshot'],
    contributions: [
      {
        kind: 'execution', id: 'mineclaw.broken.execution.x', version: '1.0.0',
        operation: {
          operationId: 'mineclaw.broken.operation.x',
          goalContributionId: 'mineclaw.broken.goal.x',
          bindingContributionId: 'mineclaw.broken.goal.x',
          factKinds: [],
          candidateContributionId: 'mineclaw.broken.planning.x',
          predicateContributionId: 'mineclaw.broken.predicate.x',
          progressContributionId: 'mineclaw.broken.progress.x',
          resultContributionId: 'mineclaw.broken.result.x',
          cancellable: true,
        },
      },
    ],
  };
  const implementations: Array<Record<string, unknown>> = [
    {
      kind: 'execution', id: 'mineclaw.broken.execution.x', version: '1.0.0',
      operation: (brokenManifest.contributions[0] as Record<string, unknown>).operation as Record<string, unknown>,
      behaviorFactory: { id: 'b', version: '1.0.0', create: () => ({}) },
    },
  ];
  const index: BuiltinPluginIndex = {
    byEntryKey: new Map([
      ['plugins/builtin/kitchen', { entryKey: 'plugins/builtin/kitchen', manifest: kitchenIndex().byEntryKey.get('plugins/builtin/kitchen')!.manifest, factory: factoryFor('plugins/builtin/kitchen', implFromDeclarations(kitchenIndex().byEntryKey.get('plugins/builtin/kitchen')!.manifest)) }],
      ['plugins/builtin/broken', { entryKey: 'plugins/builtin/broken', manifest: brokenManifest, factory: factoryFor('plugins/builtin/broken', implementations) }],
    ]),
  };
  const host = new PluginHost(hostConfig({ builtinIndex: index }));
  const result = await host.boot();
  const failure = result.failures.find((f) => f.pluginId === 'mineclaw.broken');
  assert.ok(failure);
  assert.equal(failure.code, 'package_incomplete');
  assert.ok(result.installed.includes('mineclaw.kitchen'));
  assert.ok(!result.installed.includes('mineclaw.broken'));
  const active = result.slot.read().active;
  assert.ok(!active.registry.byId.has('mineclaw.broken.execution.x'));
  assert.ok(active.registry.byId.has('mineclaw.kitchen.skill.cooking'));
});

test('依赖环与缺失依赖整批确定性失败', async () => {
  const dep = (pluginId: string): Record<string, unknown> => ({ schema: 'mineclaw.plugin/v1', id: pluginId, version: '1.0.0', apiVersion: '^2.0.0', kind: 'domain', entry: `e/${pluginId}`, dependencies: { plugins: [] }, permissions: ['world.read:bounded-block-snapshot'], contributions: [{ kind: 'skill', id: `${pluginId}.s`, version: '1.0.0', entryRef: 'x.md' }] });
  const a = dep('mineclaw.a');
  a.dependencies = { plugins: [{ pluginId: 'mineclaw.b', range: '^1.0.0' }] };
  const b = dep('mineclaw.b');
  b.dependencies = { plugins: [{ pluginId: 'mineclaw.a', range: '^1.0.0' }] };
  const index: BuiltinPluginIndex = {
    byEntryKey: new Map([
      ['e/mineclaw.a', { entryKey: 'e/mineclaw.a', manifest: a, factory: factoryFor('e/mineclaw.a', implFromDeclarations(a)) }],
      ['e/mineclaw.b', { entryKey: 'e/mineclaw.b', manifest: b, factory: factoryFor('e/mineclaw.b', implFromDeclarations(b)) }],
    ]),
  };
  const host = new PluginHost(hostConfig({ builtinIndex: index }));
  const result = await host.boot();
  const cycle = result.failures.find((f) => f.code === 'dependency_cycle');
  assert.ok(cycle, JSON.stringify(result.failures));

  const onlyA = dep('mineclaw.only');
  onlyA.dependencies = { plugins: [{ pluginId: 'mineclaw.missing', range: '^1.0.0' }] };
  const index2: BuiltinPluginIndex = {
    byEntryKey: new Map([['e/mineclaw.only', { entryKey: 'e/mineclaw.only', manifest: onlyA, factory: factoryFor('e/mineclaw.only', implFromDeclarations(onlyA)) }]]),
  };
  const host2 = new PluginHost(hostConfig({ builtinIndex: index2 }));
  const result2 = await host2.boot();
  const missing = result2.failures.find((f) => f.code === 'dependency_missing');
  assert.ok(missing, JSON.stringify(result2.failures));
});
