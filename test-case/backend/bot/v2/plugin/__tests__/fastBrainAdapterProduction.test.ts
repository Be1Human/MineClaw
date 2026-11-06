import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildRuntimePluginKernel } from '../../../../../../apps/minecraft-companion/src/bot/v2/infra/pluginRuntimeBridge.js';
import { FASTBRAIN_DECISION_SERVICE, type DecisionContext, type DecisionPort } from '../../../../../../apps/minecraft-companion/src/bot/v2/plugins/builtin/fastbrain/adapter.js';
import { fastBrainDecisionCatalog } from '../../../../../../apps/minecraft-companion/src/bot/v2/plugins/builtin/fastbrain/decisionContract.js';
import type { WorldStateView } from '../../../../../../apps/minecraft-companion/src/bot/v2/types.js';
import { parseDomainKnowledgeContent } from '../../../../../../apps/minecraft-companion/src/bot/v2/knowledge/domainKnowledge.js';

function hostContext(now: number): DecisionContext {
  return { requestId: 'production-r1', sessionId: 'production-s1', actor: 'test-bot', dimension: 'overworld',
    notBefore: now, deadlineAt: now + 5000, signal: new AbortController().signal, isCurrent: () => true };
}

test('generated production bridge publishes a reachable DecisionPort without adding a trusted system plugin', async () => {
  const now = Date.now();
  let binds = 0;
  const world: WorldStateView = {
    tick: 42, timestamp: now,
    self: { position: { x: 1, y: 64, z: 2 }, yaw: 0, pitch: 0, health: 20, maxHealth: 20, food: 18, isOnGround: true },
    inventory: { items: [{ name: 'oak_log', count: 2, slot: 36 }], held: null, freeSlots: 35 },
    environment: { dimension: 'overworld', timeOfDay: 1000, isDay: true, isRaining: false },
    owner: { username: 'private-owner', position: { x: 999, y: 99, z: 999 }, entityId: 9, distance: 1, isVisible: false },
    entities: [{ id: 3, name: 'hidden-diamond', type: 'object', position: { x: 999, y: 1, z: 999 }, distance: 1, category: 'other' }],
    taskContext: { currentTaskId: 'hidden-teacher-route', currentTaskKind: null, currentTaskState: null },
  };
  const result = await buildRuntimePluginKernel({ buildId: 'fastbrain-production-test', systemPorts: {
    game: { username: 'test-bot', bind: () => { binds++; throw new Error('read_must_not_bind'); } },
    getWorld: () => world,
  } });
  assert.equal(result.ok, true, result.failures.join('\n'));
  assert.ok(result.installed.includes('mineclaw.fastbrain'));
  assert.ok(result.resolvers && result.slot);
  const active = result.slot.read().active;
  const snapshot = { generationId: active.generationId, buildId: active.buildId, graphHash: active.graphHash };
  const resolved = result.resolvers.resolveById(snapshot, 'mineclaw.minecraft-system.integration.game');
  assert.equal(resolved.status, 'resolved');
  assert.equal(resolved.entry?.contribution.kind, 'integration');
  if (resolved.entry?.contribution.kind !== 'integration') throw new Error('integration_required');
  const port = resolved.entry.contribution.integration.services?.[FASTBRAIN_DECISION_SERVICE] as DecisionPort;
  assert.equal(typeof port?.submit, 'function');
  assert.equal(port.catalog().length, 18);
  const receipt = await port.submit({ type: 'call', skill: 'observe', args: {} }, hostContext(now));
  assert.equal(receipt.status, 'partial');
  assert.equal(receipt.observation?.version, 'world-tick-42');
  assert.equal(receipt.observation?.actor, 'test-bot');
  assert.deepEqual(receipt.observation?.inventory, [{ name: 'oak_log', count: 2, slot: 36 }]);
  assert.deepEqual(receipt.evidenceRefs, ['world:tick:42']);
  assert.equal(receipt.observation?.targets.status, 'unavailable');
  assert.doesNotMatch(JSON.stringify(receipt), /private-owner|hidden-diamond|hidden-teacher-route|entities|owner|taskContext/);
  assert.equal(binds, 0);

  const blocked = await port.submit({ type: 'call', skill: 'smelt', args: { station_id: 'f1', input: 'raw_iron', count: 1, fuel: 'coal' } }, hostContext(now));
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.reason, 'capability_unavailable:smelt');
  assert.equal(binds, 0);
  await resolved.entry.contribution.integration.stop(new AbortController().signal);
  assert.equal((await port.submit({ type: 'call', skill: 'observe', args: {} }, hostContext(now))).reason, 'adapter_not_active');
});

test('real FastBrain package embeds the public eighteen-name protocol with no permissions or false execution contributions', async () => {
  const result = await buildRuntimePluginKernel({ buildId: 'fastbrain-packaging-test' });
  assert.equal(result.ok, true, result.failures.join('\n'));
  const active = result.slot!.read().active;
  const manifest = active.manifests.find(m => m.id === 'mineclaw.fastbrain')!;
  assert.equal(manifest.kind, 'domain');
  assert.deepEqual(manifest.permissions, []);
  assert.deepEqual(manifest.contributions.map(c => c.kind), ['knowledge']);
  const entry = active.registry.byId.get('mineclaw.fastbrain.knowledge.decision-protocol');
  assert.equal(entry?.contribution.kind, 'knowledge');
  if (entry?.contribution.kind !== 'knowledge') throw new Error('protocol_knowledge_required');
  const protocol = parseDomainKnowledgeContent(entry.contribution.content!, entry.contribution.contentRef);
  assert.equal(protocol.id, 'fastbrain-decision-protocol');
  const names = [...protocol.body.matchAll(/`([a-z_]+)`/g)].map(match => match[1]);
  assert.deepEqual(names.sort(), fastBrainDecisionCatalog().map(x => x.name).sort());
  const generated = JSON.parse(readFileSync(fileURLToPath(new URL('../../../../../../apps/minecraft-companion/src/bot/v2/plugin-kernel/builtin-manifest.generated.json', import.meta.url)), 'utf8'));
  const pkg = generated.plugins.find((p: { pluginId: string }) => p.pluginId === 'mineclaw.fastbrain');
  assert.equal(pkg.kind, 'domain');
  assert.ok(pkg.imports.every((value: string) => !/adapter\/|systemPorts|GameAdapter/.test(value)));
});

test('missing production observation sources remain unavailable, not a fabricated empty inventory', async () => {
  const result = await buildRuntimePluginKernel({ buildId: 'fastbrain-unavailable-test' });
  assert.equal(result.ok, true, result.failures.join('\n'));
  const active = result.slot!.read().active;
  const entry = active.registry.byId.get('mineclaw.minecraft-system.integration.game')!;
  if (entry.contribution.kind !== 'integration') throw new Error('integration_required');
  const port = entry.contribution.integration.services?.[FASTBRAIN_DECISION_SERVICE] as DecisionPort;
  const now = Date.now();
  const receipt = await port.submit({ type: 'call', skill: 'observe', args: {} }, hostContext(now));
  assert.equal(receipt.status, 'blocked');
  assert.equal(receipt.reason, 'capability_unavailable:observe');
  assert.equal(receipt.observation, undefined);
});
