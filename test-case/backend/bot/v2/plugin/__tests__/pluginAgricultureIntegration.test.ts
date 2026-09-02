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
import { createMineclawAgriculturePlugin, HARVEST_GOAL, HARVEST_BINDING, HARVEST_FACT, HARVEST_CANDIDATE, HARVEST_EXECUTOR, HARVEST_PREDICATE, HARVEST_PROGRESS, HARVEST_RESULT } from '../../../../../../apps/minecraft-companion/src/bot/v2/plugins/builtin/agriculture/index.js';
import type { BuiltinPluginIndex } from '../../../../../../apps/minecraft-companion/src/bot/v2/plugin-kernel/discovery.js';
import type { PluginObservationProvider } from '../../../../../../apps/minecraft-companion/src/bot/v2/plugin-sdk/contracts/observation.js';

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
    assert.equal(crops.length, 1, 'only age=7 counts as mature');
    assert.equal(crops[0]!.position.x, 1);
  }

  const portless = createMineclawAgriculturePlugin().create({ host: { version: '2.0.0', buildId: 'b' }, plugin: { pluginId: 'mineclaw.agriculture', pluginVersion: '1.0.0' } });
  const obsContribution = (portless.find(c => c.kind === 'observation') as { factory: { create: (ctx: { signal: AbortSignal }) => PluginObservationProvider } }).factory;
  const missingPort = await obsContribution.create({ signal: new AbortController().signal }).observe({ params: {}, signal: new AbortController().signal, scope: {}, budget: { timeoutMs: 1000, maxResults: 1 } });
  assert.equal(missingPort.status, 'unavailable');
  assert.equal((missingPort as { reason: string }).reason, 'service_missing:bounded.block.observation');
});

test('P2-5 执行器在 body 服务未装配时显式不可用（不伪装成功）', async () => {
  const contributions = createMineclawAgriculturePlugin().create({
    host: { version: '2.0.0', buildId: 'b' },
    plugin: { pluginId: 'mineclaw.agriculture', pluginVersion: '1.0.0' },
  });
  const execution = contributions.find(c => c.kind === 'execution') as { behaviorFactory: { create: (lease: Record<string, unknown>, scoped: Record<string, unknown>) => { run: (ctx: { signal: AbortSignal; facts: Record<string, unknown>[] }) => Promise<{ ok: boolean; cancelled: boolean; error?: string }>; halt: () => Promise<void>; close: () => Promise<void>; settled: boolean } } };
  const instance = execution.behaviorFactory.create({ goalId: 'g1' } as never, {} as never);
  const outcome = await instance.run({ signal: new AbortController().signal, facts: [] } as never);
  assert.equal(outcome.ok, false);
  assert.match(outcome.error ?? '', /body_submit_service_missing/);
  void HARVEST_PREDICATE; void HARVEST_PROGRESS; void HARVEST_RESULT;
});
