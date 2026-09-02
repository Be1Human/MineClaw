/**
 * FEAT-CROSS-26-001-004-002/-004 · mineclaw.minecraft-presence plugin (P2-4).
 * Owner-context fact: position/dimension/observedAt with the closed pointing
 * union; missing port or unavailable pitch returns structured unavailable.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { PluginHost } from '../../../../../../apps/minecraft-companion/src/bot/v2/plugin-kernel/index.js';
import { createMineclawMinecraftSystemPlugin } from '../../../../../../apps/minecraft-companion/src/bot/v2/plugins/builtin/minecraft-system/index.js';
import { createMineclawMinecraftPresencePlugin } from '../../../../../../apps/minecraft-companion/src/bot/v2/plugins/builtin/minecraft-presence/index.js';
import type { BuiltinPluginIndex } from '../../../../../../apps/minecraft-companion/src/bot/v2/plugin-kernel/discovery.js';
import type { PluginObservationProvider } from '../../../../../../apps/minecraft-companion/src/bot/v2/plugin-sdk/contracts/observation.js';

function index(): BuiltinPluginIndex {
  const base = fileURLToPath(new URL('../../../../../../apps/minecraft-companion/src/bot/v2/plugins/builtin', import.meta.url));
  const systemManifest = parse(readFileSync(`${base}/minecraft-system/plugin.yaml`, 'utf8')) as Record<string, unknown>;
  const presenceManifest = parse(readFileSync(`${base}/minecraft-presence/plugin.yaml`, 'utf8')) as Record<string, unknown>;
  return {
    byEntryKey: new Map([
      ['plugins/builtin/mineclaw.minecraft-system', { entryKey: 'plugins/builtin/mineclaw.minecraft-system', manifest: systemManifest, factory: createMineclawMinecraftSystemPlugin() }],
      ['plugins/builtin/mineclaw.minecraft-presence', { entryKey: 'plugins/builtin/mineclaw.minecraft-presence', manifest: presenceManifest, factory: createMineclawMinecraftPresencePlugin() }],
    ]),
  };
}

test('P2-4 owner-context 经服务端口产出版本化 Fact（含位置/维度/pointing 判别联合）', async () => {
  const ownerContextObservation = {
    observe: async (input: { signal: AbortSignal }) => {
      void input.signal;
      return {
        snapshotVersion: 'v1',
        observedAt: '2026-09-02T00:00:00.000Z',
        dimension: 'minecraft:overworld',
        botPosition: { x: 0, y: 64, z: 0 },
        ownerPosition: { x: 3, y: 64, z: 1 },
        pointing: { kind: 'observed' as const, yaw: 90, pitch: 0, ray: { target: 'field:1' } },
        complete: true,
        evidenceRefs: ['pos-w1'],
      };
    },
  };
  const host = new PluginHost({
    hostApiVersion: '2.0.0',
    buildId: 'build-1',
    builtinIndex: index(),
    trustedSystemPlugins: ['mineclaw.minecraft-system'],
    systemPorts: { ownerContextObservation },
  });
  const result = await host.boot();
  assert.deepEqual(result.failures, [], JSON.stringify(result.failures));
  assert.ok(result.installed.includes('mineclaw.minecraft-presence'));
  assert.ok(result.services['context.owner']);
  const active = result.slot.read().active;
  const observation = active.registry.byId.get('mineclaw.minecraft-presence.observation.owner-context');
  assert.ok(observation);
  const factory = (observation!.contribution as { factory: { create: (ctx: { signal: AbortSignal }) => PluginObservationProvider } }).factory;
  const provider = factory.create({ signal: new AbortController().signal });
  const observed = await provider.observe({ params: {}, signal: new AbortController().signal, scope: {}, budget: { timeoutMs: 3000, maxResults: 1 } });
  assert.equal(observed.status, 'fulfilled');
  if (observed.status === 'fulfilled') {
    assert.equal(observed.fact.factKind, 'owner_location');
    const payload = observed.fact.payload as { ownerPosition: { x: number }; pointing: { kind: string; yaw: number } };
    assert.equal(payload.ownerPosition.x, 3);
    assert.equal(payload.pointing.kind, 'observed');
    assert.equal(payload.pointing.yaw, 90);
    assert.equal(observed.fact.complete, true);
  }
});

test('P2-4 pointing 不可用时显式 unavailable 分支（不虚构方向）；无端口 fail-closed', async () => {
  const ownerContextObservation = {
    observe: async (input: { signal: AbortSignal }) => {
      void input.signal;
      return {
        snapshotVersion: 'v1',
        observedAt: new Date().toISOString(),
        dimension: 'minecraft:overworld',
        botPosition: { x: 0, y: 64, z: 0 },
        ownerPosition: { x: 3, y: 64, z: 1 },
        pointing: { kind: 'unavailable' as const, reason: 'pitch_unavailable' },
        complete: true,
        evidenceRefs: ['pos-w2'],
      };
    },
  };
  const host = new PluginHost({
    hostApiVersion: '2.0.0',
    buildId: 'build-1',
    builtinIndex: index(),
    trustedSystemPlugins: ['mineclaw.minecraft-system'],
    systemPorts: { ownerContextObservation },
  });
  const result = await host.boot();
  assert.deepEqual(result.failures, []);
  const active = result.slot.read().active;
  const observation = active.registry.byId.get('mineclaw.minecraft-presence.observation.owner-context')!;
  const factory = (observation.contribution as { factory: { create: (ctx: { signal: AbortSignal }) => PluginObservationProvider } }).factory;
  const provider = factory.create({ signal: new AbortController().signal });
  const observed = await provider.observe({ params: {}, signal: new AbortController().signal, scope: {}, budget: { timeoutMs: 3000, maxResults: 1 } });
  assert.equal(observed.status, 'fulfilled');
  if (observed.status === 'fulfilled') {
    const pointing = (observed.fact.payload as { pointing: { kind: string; reason?: string } }).pointing;
    assert.equal(pointing.kind, 'unavailable');
    assert.equal(pointing.reason, 'pitch_unavailable');
  }

  // 无端口（只装 presence 的工厂，模拟服务缺失）→ unavailable
  const portlessHost = new PluginHost({
    hostApiVersion: '2.0.0',
    buildId: 'build-1',
    builtinIndex: index(),
    trustedSystemPlugins: ['mineclaw.minecraft-system'],
  });
  const portlessResult = await portlessHost.boot();
  assert.deepEqual(portlessResult.failures, []);
  const portlessObservation = portlessResult.slot.read().active.registry.byId.get('mineclaw.minecraft-presence.observation.owner-context')!;
  const portlessFactory = (portlessObservation.contribution as { factory: { create: (ctx: { signal: AbortSignal }) => PluginObservationProvider } }).factory;
  // 与 inventory 同语义：工厂在 create 时未捕获服务 -> provider unavailable（此处通过直接构造验证）
  const presenceFactory = createMineclawMinecraftPresencePlugin();
  const contributions = presenceFactory.create({ host: { version: '2.0.0', buildId: 'b' }, plugin: { pluginId: 'mineclaw.minecraft-presence', pluginVersion: '1.0.0' } });
  const emptyObs = (contributions.find(c => c.kind === 'observation') as { factory: { create: (ctx: { signal: AbortSignal }) => PluginObservationProvider } }).factory;
  const observedEmpty = await emptyObs.create({ signal: new AbortController().signal }).observe({ params: {}, signal: new AbortController().signal, scope: {}, budget: { timeoutMs: 1000, maxResults: 1 } });
  assert.equal(observedEmpty.status, 'unavailable');
  if (observedEmpty.status === 'unavailable') assert.match(observedEmpty.reason, /service_missing/);
  void portlessFactory;
});
