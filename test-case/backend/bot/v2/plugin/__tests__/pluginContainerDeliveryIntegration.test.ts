/**
 * FEAT-CROSS-26-001-004-004 · container/delivery batch (P2-8).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { PluginHost } from '../../../../../../apps/minecraft-companion/src/bot/v2/plugin-kernel/index.js';
import { createMineclawMinecraftSystemPlugin } from '../../../../../../apps/minecraft-companion/src/bot/v2/plugins/builtin/minecraft-system/index.js';
import { createMineclawStorageSystemPlugin } from '../../../../../../apps/minecraft-companion/src/bot/v2/plugins/builtin/storage-system/index.js';
import { createMineclawInventoryPlugin } from '../../../../../../apps/minecraft-companion/src/bot/v2/plugins/builtin/inventory/index.js';
import { createMineclawMinecraftPresencePlugin } from '../../../../../../apps/minecraft-companion/src/bot/v2/plugins/builtin/minecraft-presence/index.js';
import { createMineclawContainerPlugin } from '../../../../../../apps/minecraft-companion/src/bot/v2/plugins/builtin/container/index.js';
import { createMineclawDeliveryPlugin } from '../../../../../../apps/minecraft-companion/src/bot/v2/plugins/builtin/delivery/index.js';
import type { BuiltinPluginIndex } from '../../../../../../apps/minecraft-companion/src/bot/v2/plugin-kernel/discovery.js';
import { parse } from 'yaml';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const BUILTIN = fileURLToPath(new URL('../../../../../../apps/minecraft-companion/src/bot/v2/plugins/builtin/', import.meta.url));

function index(): BuiltinPluginIndex {
  const entry = (id: string, factory: () => unknown) => {
    const manifest = parse(readFileSync(`${BUILTIN}/${id}/plugin.yaml`, 'utf8')) as Record<string, unknown>;
    return { entryKey: `plugins/builtin/${manifest.id}`, manifest, factory: factory() as never };
  };
  return {
    byEntryKey: new Map([
      ['plugins/builtin/mineclaw.minecraft-system', entry('minecraft-system', createMineclawMinecraftSystemPlugin)],
      ['plugins/builtin/mineclaw.storage-system', entry('storage-system', createMineclawStorageSystemPlugin)],
      ['plugins/builtin/mineclaw.inventory', entry('inventory', createMineclawInventoryPlugin)],
      ['plugins/builtin/mineclaw.minecraft-presence', entry('minecraft-presence', createMineclawMinecraftPresencePlugin)],
      ['plugins/builtin/mineclaw.container', entry('container', createMineclawContainerPlugin)],
      ['plugins/builtin/mineclaw.delivery', entry('delivery', createMineclawDeliveryPlugin)],
    ]),
  };
}

test('P2-8 container/delivery 闭环注册（owner-context 驱动交付候选），Host body 失败显式失败', async () => {
  const result = await new PluginHost({
    hostApiVersion: '2.0.0',
    buildId: 'build-1',
    builtinIndex: index(),
    trustedSystemPlugins: ['mineclaw.minecraft-system', 'mineclaw.storage-system'],
    systemPorts: {
      ownerContextObservation: {
        observe: async () => ({
          snapshotVersion: 'v1',
          observedAt: new Date().toISOString(),
          dimension: 'minecraft:overworld',
          botPosition: { x: 0, y: 64, z: 0 },
          ownerPosition: { x: 5, y: 64, z: 0 },
          pointing: { kind: 'observed', yaw: 0, pitch: 0 },
          complete: true,
          evidenceRefs: ['pos-1'],
        }),
      },
    },
  }).boot();
  assert.deepEqual(result.failures, [], JSON.stringify(result.failures));
  assert.ok(result.installed.includes('mineclaw.container'));
  assert.ok(result.installed.includes('mineclaw.delivery'));
  const active = result.slot.read().active;
  assert.ok(active.registry.byId.has('mineclaw.container.execution.chest-access'));
  assert.ok(active.registry.byId.has('mineclaw.delivery.execution.deliver-to-owner'));

  const deliveryCandidates = (active.registry.byId.get('mineclaw.delivery.planning.deliver-candidates')!.contribution as { candidateProvider: { list: (i: unknown) => Promise<{ status: string; candidates: Array<{ params: { target?: { x: number } } }>; reason?: string }> } }).candidateProvider;
  const presenceFactory = (active.registry.byId.get('mineclaw.minecraft-presence.observation.owner-context')!.contribution as { factory: { create: (c: { signal: AbortSignal }) => { observe: (i: unknown) => Promise<{ status: string; fact?: Record<string, unknown> }> } } }).factory;
  const fact = await presenceFactory.create({ signal: new AbortController().signal }).observe({ params: {}, signal: new AbortController().signal, scope: {}, budget: { timeoutMs: 1000, maxResults: 1 } });
  const listed = await deliveryCandidates.list({ goal: {}, snapshot: {}, facts: [fact.fact], params: {}, signal: new AbortController().signal, budget: {} } as never);
  assert.equal(listed.status, 'complete');
  assert.equal(listed.candidates[0]!.params.target!.x, 5);

  for (const [index, plugin] of [createMineclawContainerPlugin as () => { create: (c: never) => never }, createMineclawDeliveryPlugin as () => { create: (c: never) => never }].entries()) {
    const contributions = (plugin() as { create: (c: { host: { version: string; buildId: string }; plugin: { pluginId: string; pluginVersion: string } }) => Array<unknown> }).create({ host: { version: '2.0.0', buildId: 'b' }, plugin: { pluginId: 'x', pluginVersion: '1.0.0' } });
    const exec = contributions.find(c => (c as { kind?: string }).kind === 'execution') as any;
    const params = index === 0
      ? { chest: { x: 1, y: 2, z: 3 }, item: 'torch', count: 1 }
      : { target: { x: 1, y: 2, z: 3 }, item: 'torch', count: 1 };
    const instance = exec.behaviorFactory.create({ goalId: 'g' } as never);
    const compiled = instance.compile({ goal: { goalId: 'g' }, facts: [], params });
    assert.equal(instance.kind, 'sequence');
    assert.equal(compiled.ok, true);
    assert.ok(compiled.steps.length >= 1);
  }
});
