/**
 * FEAT-CROSS-28-003 E2E contract side (CR/QR, E2E offline subset).
 * The QueryRunner consumes the real agriculture observation contribution through
 * the plugin catalog: nearby_crops answers carry mature crops with positions,
 * coverage, time and completeness plus evidence; budgets hot-read from tuning.
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
import { createMineclawAgriculturePlugin, HARVEST_FACT } from '../../../../../../apps/minecraft-companion/src/bot/v2/plugins/builtin/agriculture/index.js';
import { QueryRunner } from '../../../../../../apps/minecraft-companion/src/bot/v2/decision/knowledgeQueryRunner.js';
import type { KnowledgeQueryV1 } from '../../../../../../apps/minecraft-companion/src/bot/v2/decision/goalAgentPort/knowledgeQueryContracts.js';

const SNAPSHOT = { generationId: 'gen-41', buildId: 'build-1', graphHash: 'h1' };
const BUILTIN = fileURLToPath(new URL('../../../../../../apps/minecraft-companion/src/bot/v2/plugins/builtin/', import.meta.url));

function query(): KnowledgeQueryV1 {
  return {
    schemaVersion: 'mineclaw.knowledge-query/v1',
    kind: 'knowledge_query',
    requestId: 'kq-crops-1',
    correlationId: 'corr-crops',
    idempotencyKey: 'idem-crops',
    emittedAt: new Date().toISOString(),
    source: 'player',
    replyMode: 'answer_player',
    originalText: '旁边有什么农作物',
    factKinds: ['nearby_crops'],
    anchor: { kind: 'bot_self' },
    scope: { radius: 8 },
    freshness: { maxAgeMs: 5000 },
    registryGeneration: SNAPSHOT,
  };
}

test('CR/QR E2E：QueryRunner 经真实 agriculture 观察回答 nearby_crops（成熟度/位置/范围/时间/证据）', async () => {
  const blockPort = {
    observe: async () => ({
      snapshotVersion: 'v1',
      observedAt: new Date().toISOString(),
      dimension: 'minecraft:overworld',
      requestedBounds: { radius: 8 },
      observedBounds: { radius: 8 },
      blocks: [
        { name: 'minecraft:wheat', position: { x: 3, y: 64, z: 1 }, properties: { age: 7 } },
        { name: 'minecraft:wheat', position: { x: 4, y: 64, z: 1 }, properties: { age: 5 } },
        { name: 'minecraft:stone', position: { x: 9, y: 64, z: 9 }, properties: {} },
      ],
      unloadedRegions: [],
      complete: true,
      truncated: false,
      evidenceRefs: ['b1', 'b2'],
    }),
  };
  const manifests: Record<string, Record<string, unknown>> = {
    'minecraft-system': parse(readFileSync(`${BUILTIN}/minecraft-system/plugin.yaml`, 'utf8')) as Record<string, unknown>,
    'minecraft-presence': parse(readFileSync(`${BUILTIN}/minecraft-presence/plugin.yaml`, 'utf8')) as Record<string, unknown>,
    inventory: parse(readFileSync(`${BUILTIN}/inventory/plugin.yaml`, 'utf8')) as Record<string, unknown>,
    'storage-system': parse(readFileSync(`${BUILTIN}/storage-system/plugin.yaml`, 'utf8')) as Record<string, unknown>,
    agriculture: parse(readFileSync(`${BUILTIN}/agriculture/plugin.yaml`, 'utf8')) as Record<string, unknown>,
  };
  const factories: Record<string, () => unknown> = {
    'minecraft-system': createMineclawMinecraftSystemPlugin,
    'minecraft-presence': createMineclawMinecraftPresencePlugin,
    inventory: createMineclawInventoryPlugin,
    'storage-system': createMineclawStorageSystemPlugin,
    agriculture: createMineclawAgriculturePlugin,
  };
  const byEntryKey = new Map<string, { entryKey: string; manifest: Record<string, unknown>; factory: never }>();
  for (const [id, manifest] of Object.entries(manifests)) {
    const entryKey = `plugins/builtin/mineclaw.${id}`;
    byEntryKey.set(entryKey, { entryKey, manifest, factory: factories[id]!() as never });
  }
  const host = new PluginHost({
    hostApiVersion: '2.0.0',
    buildId: 'build-1',
    builtinIndex: { byEntryKey },
    trustedSystemPlugins: ['mineclaw.minecraft-system', 'mineclaw.storage-system'],
    systemPorts: { blockObservation: blockPort },
  });
  const result = await host.boot();
  assert.deepEqual(result.failures, [], JSON.stringify(result.failures));

  const active = result.slot.read().active;
  const entry = active.registry.byId.get(HARVEST_FACT)!;
  const factory = (entry.contribution as { factory: unknown }).factory;
  const runner = new QueryRunner({ resolveProvider: (factKind: string) => factKind === 'nearby_crops' ? [factory] : [] });
  const answer = await runner.run(query(), new AbortController().signal);
  assert.equal(answer.outcome, 'answered');
  assert.equal(answer.facts.length, 1);
  const fact = answer.facts[0]!;
  const payload = fact.payload as { crops: Array<{ position: { x: number }; state: string }>; count: number };
  assert.equal(payload.count, 1, 'only age=7 wheat counts as mature');
  assert.equal(payload.crops[0]!.position.x, 3);
  assert.equal(payload.crops[0]!.state, 'mature');
  assert.equal(fact.complete, true);
  assert.ok(fact.evidenceRefs.length >= 1);
  assert.ok(answer.freshness.fresh);
  assert.equal(answer.coverage.dimension, 'overworld');
  assert.equal(answer.registryGeneration.generationId, 'gen-41');
});

test('CR 负向：范围外无作物 → not_found 精确区分（不冒充全局否定）', async () => {
  const blockPort = {
    observe: async () => ({
      snapshotVersion: 'v1',
      observedAt: new Date().toISOString(),
      dimension: 'minecraft:overworld',
      requestedBounds: { radius: 8 },
      observedBounds: { radius: 8 },
      blocks: [{ name: 'minecraft:grass', position: { x: 0, y: 64, z: 0 }, properties: {} }],
      unloadedRegions: [],
      complete: true,
      truncated: false,
      evidenceRefs: [],
    }),
  };
  const byEntryKey = new Map<string, { entryKey: string; manifest: Record<string, unknown>; factory: never }>();
  const manifests: Record<string, Record<string, unknown>> = {
    'minecraft-system': parse(readFileSync(`${BUILTIN}/minecraft-system/plugin.yaml`, 'utf8')) as Record<string, unknown>,
    'minecraft-presence': parse(readFileSync(`${BUILTIN}/minecraft-presence/plugin.yaml`, 'utf8')) as Record<string, unknown>,
    inventory: parse(readFileSync(`${BUILTIN}/inventory/plugin.yaml`, 'utf8')) as Record<string, unknown>,
    'storage-system': parse(readFileSync(`${BUILTIN}/storage-system/plugin.yaml`, 'utf8')) as Record<string, unknown>,
    agriculture: parse(readFileSync(`${BUILTIN}/agriculture/plugin.yaml`, 'utf8')) as Record<string, unknown>,
  };
  const factories: Record<string, () => unknown> = {
    'minecraft-system': createMineclawMinecraftSystemPlugin,
    'minecraft-presence': createMineclawMinecraftPresencePlugin,
    inventory: createMineclawInventoryPlugin,
    'storage-system': createMineclawStorageSystemPlugin,
    agriculture: createMineclawAgriculturePlugin,
  };
  for (const [id, manifest] of Object.entries(manifests)) {
    const key = `plugins/builtin/mineclaw.${id}`;
    byEntryKey.set(key, { entryKey: key, manifest, factory: factories[id]!() as never });
  }
  const host = new PluginHost({
    hostApiVersion: '2.0.0',
    buildId: 'build-1',
    builtinIndex: { byEntryKey },
    trustedSystemPlugins: ['mineclaw.minecraft-system', 'mineclaw.storage-system'],
    systemPorts: { blockObservation: blockPort },
  });
  const result = await host.boot();
  assert.deepEqual(result.failures, []);
  const factory = (result.slot.read().active.registry.byId.get(HARVEST_FACT)!.contribution as { factory: unknown }).factory;
  const answer = await new QueryRunner({ resolveProvider: (kind: string) => kind === 'nearby_crops' ? [factory] : [] }).run(query(), new AbortController().signal);
  // 有 provider 且扫描完整但零成熟作物 → not_found（范围性），而不是 unavailable。
  assert.equal(answer.outcome, 'not_found');
  assert.match(answer.reason ?? '', /no_facts_in_scope/);
});
