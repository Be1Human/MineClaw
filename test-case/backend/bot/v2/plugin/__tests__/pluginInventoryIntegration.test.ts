/**
 * FEAT-CROSS-26-001-004-002/-004 · mineclaw.inventory domain plugin (P2-3).
 * Dependency-ordered service injection: minecraft-system publishes the bounded
 * inventory port, the inventory plugin consumes it and emits the versioned
 * owner-inventory Fact; without the port it returns structured unavailable.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { PluginHost } from '../../../../../../apps/minecraft-companion/src/bot/v2/plugin-kernel/index.js';
import { createMineclawMinecraftSystemPlugin } from '../../../../../../apps/minecraft-companion/src/bot/v2/plugins/builtin/minecraft-system/index.js';
import { createMineclawInventoryPlugin } from '../../../../../../apps/minecraft-companion/src/bot/v2/plugins/builtin/inventory/index.js';
import type { BuiltinPluginIndex } from '../../../../../../apps/minecraft-companion/src/bot/v2/plugin-kernel/discovery.js';
import type { PluginObservationProvider } from '../../../../../../apps/minecraft-companion/src/bot/v2/plugin-sdk/contracts/observation.js';

function index(): BuiltinPluginIndex {
  const base = fileURLToPath(new URL('../../../../../../apps/minecraft-companion/src/bot/v2/plugins/builtin', import.meta.url));
  const systemManifest = parse(readFileSync(`${base}/minecraft-system/plugin.yaml`, 'utf8')) as Record<string, unknown>;
  const inventoryManifest = parse(readFileSync(`${base}/inventory/plugin.yaml`, 'utf8')) as Record<string, unknown>;
  return {
    byEntryKey: new Map([
      ['plugins/builtin/mineclaw.minecraft-system', { entryKey: 'plugins/builtin/mineclaw.minecraft-system', manifest: systemManifest, factory: createMineclawMinecraftSystemPlugin() }],
      ['plugins/builtin/mineclaw.inventory', { entryKey: 'plugins/builtin/mineclaw.inventory', manifest: inventoryManifest, factory: createMineclawInventoryPlugin() }],
    ]),
  };
}

test('P2-3 服务注入全链：system 端口经 host 服务表被 inventory 消费并产出版本化 Fact', async () => {
  let observeCalls = 0;
  const mockPort = {
    observe: async (input: { signal: AbortSignal }) => {
      observeCalls += 1;
      void input.signal;
      return {
        snapshotVersion: 'v1',
        observedAt: '2026-09-02T00:00:00.000Z',
        subjectRef: 'owner',
        slots: [{ slot: 0, itemId: 'oak_log', count: 2 }],
        complete: true,
        truncated: false,
        evidenceRefs: ['inv-w1'],
      };
    },
  };
  const host = new PluginHost({
    hostApiVersion: '2.0.0',
    buildId: 'build-1',
    builtinIndex: index(),
    trustedSystemPlugins: ['mineclaw.minecraft-system'],
    systemPorts: { inventoryObservation: mockPort },
  });
  const result = await host.boot();
  assert.deepEqual(result.failures, [], JSON.stringify(result.failures));
  assert.ok(result.installed.includes('mineclaw.inventory'));
  assert.ok(result.services['bounded.inventory.observation']);

  const active = result.slot.read().active;
  const observation = active.registry.byId.get('mineclaw.inventory.observation.owner-inventory');
  assert.ok(observation);
  const factory = (observation!.contribution as { factory: { create: (ctx: { signal: AbortSignal }) => PluginObservationProvider } }).factory;
  const provider = factory.create({ signal: new AbortController().signal });
  const observed = await provider.observe({
    params: {},
    signal: new AbortController().signal,
    scope: { radius: 0 },
    budget: { timeoutMs: 5000, maxResults: 64 },
  });
  assert.equal(observed.status, 'fulfilled');
  if (observed.status === 'fulfilled') {
    assert.equal(observed.fact.factKind, 'inventory');
    assert.equal((observed.fact.payload as { slots: unknown[] }).slots.length, 1);
    assert.equal(observed.fact.complete, true);
    assert.equal(observeCalls, 1);
  }
  const goal = active.registry.byId.get('mineclaw.inventory.goal.item-available');
  assert.ok(goal);
  assert.equal((goal!.contribution as { target?: { registryId: string } }).target?.registryId, 'mineclaw.inventory.goal.item-available');
});

test('P2-3 无端口时 inventory observation 结构化 unavailable（服务缺失 fail-closed）', async () => {
  const host = new PluginHost({
    hostApiVersion: '2.0.0',
    buildId: 'build-1',
    builtinIndex: index(),
    trustedSystemPlugins: ['mineclaw.minecraft-system'],
  });
  const result = await host.boot();
  assert.deepEqual(result.failures, []);
  const active = result.slot.read().active;
  const observation = active.registry.byId.get('mineclaw.inventory.observation.owner-inventory')!;
  const factory = (observation.contribution as { factory: { create: (ctx: { signal: AbortSignal }) => PluginObservationProvider } }).factory;
  // 与上面场景不同：即使 host 服务表存在，provider 也是 factory.create 时捕获的快照；
  // 这里直接用无端口工厂验证 fail-closed 语义。
  const portlessFactory = createFactoryWithoutService();
  const provider = portlessFactory.create({ signal: new AbortController().signal });
  const observed = await provider.observe({ params: {}, signal: new AbortController().signal, scope: {}, budget: { timeoutMs: 1000, maxResults: 1 } });
  assert.equal(observed.status, 'unavailable');
  if (observed.status === 'unavailable') assert.match(observed.reason, /service_missing/);
});

function createFactoryWithoutService(): { create: (ctx: { signal: AbortSignal }) => PluginObservationProvider } {
  // Reconstruct the plugin with an empty services table (host with a system plugin
  // that publishes no services would be equivalent; here we use the same factory
  // code path by constructing via the plugin factory with no services).
  const args = { entryKey: 'x', create: undefined } as never;
  void args;
  const factory = createMineclawInventoryPlugin();
  const contributions = factory.create({ host: { version: '2.0.0', buildId: 'b' }, plugin: { pluginId: 'mineclaw.inventory', pluginVersion: '1.0.0' } });
  const observation = contributions.find(contribution => contribution.kind === 'observation') as { factory: { create: (ctx: { signal: AbortSignal }) => PluginObservationProvider } };
  return { create: observation.factory.create };
}
