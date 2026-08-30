import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { CapabilityPackageRegistry } from '../../../../../../apps/minecraft-companion/src/bot/v2/capabilities/capabilityPackageRegistry.js';
import { createAmbientProactiveCapabilityPackage } from '../../../../../../apps/minecraft-companion/src/bot/v2/capabilities/ambient/ambientProactiveCapabilityPackage.js';
import { resolveProactiveCapabilityCatalog } from '../../../../../../apps/minecraft-companion/src/bot/v2/proactive/contracts.js';
import type { WorldStateView } from '../../../../../../apps/minecraft-companion/src/bot/v2/types.js';

function world(input: { owner?: WorldStateView['owner']; items?: Array<{ name: string; count: number; slot: number }>; hostile?: boolean } = {}): WorldStateView {
  return {
    tick: 1, timestamp: 1,
    self: { position: { x: 0, y: 64, z: 0 }, yaw: 0, pitch: 0, health: 20, maxHealth: 20, food: 20, isOnGround: true },
    owner: input.owner ?? null,
    environment: { dimension: 'overworld', timeOfDay: 1000, isDay: true, isRaining: false },
    entities: input.hostile ? [{ id: 2, name: 'zombie', type: 'mob', position: { x: 3, y: 64, z: 0 }, distance: 3, category: 'hostile' }] : [],
    inventory: { items: input.items ?? [], held: null, freeSlots: 20 },
    taskContext: null,
  };
}

function registry() {
  return new CapabilityPackageRegistry({
    atomicIds: [], behaviorIds: [], strategyIds: [], skillNames: [], knowledgeIds: [],
    goalTargetIds: ['mineclaw:owner_position', 'minecraft:oak_log'],
  });
}

test('ambient package is proactive-only, default-off and needs no execution-layer dependency', () => {
  const packages = registry();
  packages.register(createAmbientProactiveCapabilityPackage());
  const ticks = packages.snapshot().proactiveTicks;
  assert.deepEqual(ticks.map(entry => entry.manifest.id), ['auto_follow', 'auto_stockpile']);
  assert.ok(resolveProactiveCapabilityCatalog(ticks).every(entry => entry.enabled === false));

  const source = readFileSync(join(process.cwd(), 'src', 'bot', 'v2', 'capabilities', 'ambient', 'ambientProactiveCapabilityPackage.ts'), 'utf8');
  assert.doesNotMatch(source, /TaskRuntime|MotorService|GameAdapter|NavigationAdapter|\.createTask\(|\.start\(/);
});

test('auto_follow only proposes while owner is visible and the bot is idle', async () => {
  const entry = createAmbientProactiveCapabilityPackage().proactiveTicks!.find(item => item.id === 'auto_follow')!;
  const config = { startDistance: 8, stopDistance: 4 };
  const base = { profileId: 'p', now: 1, config, foregroundBusy: false, signal: new AbortController().signal };
  assert.deepEqual(await entry.evaluate({ ...base, world: world() }), { kind: 'release', reason: 'owner_offline_or_not_observed' });
  const owner = { username: 'Steve', position: { x: 12, y: 64, z: 0 }, distance: 12, entityId: 1, isVisible: true };
  const candidate = await entry.evaluate({ ...base, world: world({ owner }) });
  assert.equal(candidate.kind, 'candidate');
  if (candidate.kind === 'candidate') assert.equal(candidate.candidate.idempotencyKey, 'auto_follow:Steve');
  assert.deepEqual(await entry.evaluate({ ...base, foregroundBusy: true, world: world({ owner }) }), { kind: 'idle', reason: 'foreground_busy' });
});

test('auto_stockpile gates owner, danger and inventory before choosing logs then food', async () => {
  const entry = createAmbientProactiveCapabilityPackage().proactiveTicks!.find(item => item.id === 'auto_stockpile')!;
  const config = { targetLogs: 4, targetFood: 3, minHealth: 16, dangerRadius: 16, minFreeSlots: 4 };
  const base = { profileId: 'p', now: 1, config, foregroundBusy: false, signal: new AbortController().signal };
  const owner = { username: 'Steve', position: { x: 2, y: 64, z: 0 }, distance: 2, entityId: 1, isVisible: true };
  assert.deepEqual(await entry.evaluate({ ...base, world: world({ owner }) }), { kind: 'release', reason: 'owner_present' });
  assert.deepEqual(await entry.evaluate({ ...base, world: world({ hostile: true }) }), { kind: 'release', reason: 'hostile_nearby' });
  const logs = await entry.evaluate({ ...base, world: world() });
  assert.equal(logs.kind === 'candidate' ? logs.candidate.idempotencyKey : '', 'auto_stockpile:logs');
  const food = await entry.evaluate({ ...base, world: world({ items: [{ name: 'oak_log', count: 4, slot: 0 }] }) });
  assert.equal(food.kind === 'candidate' ? food.candidate.idempotencyKey : '', 'auto_stockpile:food');
  const satisfied = await entry.evaluate({ ...base, world: world({ items: [
    { name: 'oak_log', count: 4, slot: 0 }, { name: 'bread', count: 3, slot: 1 },
  ] }) });
  assert.deepEqual(satisfied, { kind: 'release', reason: 'stock_targets_satisfied' });
});
