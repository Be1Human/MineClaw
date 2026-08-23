import assert from 'node:assert/strict';
import test from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { GameAdapter } from '../../../../../../apps/minecraft-companion/src/bot/adapter/GameAdapter.js';
import type { RawEntity, RawItem, Vec3 } from '../../../../../../apps/minecraft-companion/src/bot/adapter/types.js';
import { createAgricultureCapabilityPackage } from '../../../../../../apps/minecraft-companion/src/bot/v2/capabilities/agriculture/agricultureCapabilityPackage.js';
import { loadCapabilityResourcePackage } from '../../../../../../apps/minecraft-companion/src/bot/v2/capabilities/capabilityManifestLoader.js';
import { HarvestWorldFactProvider } from '../../../../../../apps/minecraft-companion/src/bot/v2/capabilities/agriculture/harvestWorldFactProvider.js';
import type { GoalSuccessCriterion } from '../../../../../../apps/minecraft-companion/src/bot/v2/task/contracts/goalTypes.js';
import { createGoalAgentState } from '../../../../../../apps/minecraft-companion/src/bot/v2/task/goalAgent/goalAgentState.js';
import type { WorldStateView } from '../../../../../../apps/minecraft-companion/src/bot/v2/types.js';

const resources = loadCapabilityResourcePackage(join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../../../apps/minecraft-companion/capability-packages/agriculture',
));

function agriculture(input: {
  game: GameAdapter;
  resolveChestTargets: Parameters<typeof createAgricultureCapabilityPackage>[0]['resolveChestTargets'];
}) {
  return createAgricultureCapabilityPackage({ ...input, manifest: resources.manifest, pause: async () => {} });
}

function world(): WorldStateView {
  return {
    tick: 1,
    timestamp: 100,
    self: { position: { x: 0, y: 64, z: 0 }, yaw: 0, pitch: 0, health: 20, maxHealth: 20, food: 20, isOnGround: true },
    owner: { username: 'owner', position: { x: 0, y: 64, z: 0 }, distance: 0, entityId: 9, isVisible: true },
    environment: { dimension: 'overworld', timeOfDay: 1000, isDay: true, isRaining: false },
    entities: [], inventory: { items: [], held: null, freeSlots: 36 }, taskContext: null,
  };
}

function gameState() {
  const ages = new Map<string, string>([
    ['1:63:0', '7'], ['2:63:0', '7'], ['3:63:0', '4'],
  ]);
  const state = { ages, entities: [] as RawEntity[], inventory: [] as RawItem[] };
  const game = {
    findBlocks: ({ count = 999 }: { count?: number }) => [...ages.keys()].slice(0, count).map(parsePosition),
    getBlockProperties: (pos: Vec3) => ages.has(key(pos)) ? { age: ages.get(key(pos))! } : null,
    getEntities: () => state.entities,
    getInventoryItems: () => state.inventory,
  } as unknown as GameAdapter;
  return { state, game };
}

test('BUG-CROSS-75 · mature crop fact distinguishes age=7 and declares truncation bounds', () => {
  const { game } = gameState();
  const provider = new HarvestWorldFactProvider(game);
  const complete = provider.observe({ world: world(), params: { limit: 8 } });
  assert.equal(complete.complete, true);
  assert.deepEqual(complete.value.matureCrops.map(value => key(value.position)), ['1:63:0', '2:63:0']);
  assert.equal(complete.value.matureCrops.every(value => value.age === 7), true);
  const truncated = provider.observe({ world: world(), params: { limit: 1 } });
  assert.equal(truncated.complete, false);
  assert.equal(truncated.truncated, true);
  assert.deepEqual(truncated.bounds, {
    origin: { x: 0, y: 64, z: 0 }, radius: 32, cropLimit: 1, dropLimit: 128,
  });
});

test('BUG-CROSS-75 · one agriculture package drives harvest → collect → store and machine verification', async () => {
  const { game, state: gameFacts } = gameState();
  const chestPos = { x: 6, y: 64, z: 0 };
  const capability = agriculture({
    game,
    resolveChestTargets: () => [{ pos: chestPos, relation: 'nearby', distance: 6 }],
  });
  const provider = capability.actionProviders[0]!;
  const criterion: GoalSuccessCriterion = {
    type: 'predicate', predicate: 'agriculture.harvest_to_chest', since: 50,
  };
  const shared = createGoalAgentState({
    sessionId: 'goal-harvest', interactionSessionId: 'interaction-harvest',
    request: {
      meta: { schemaVersion: 2, sessionId: 'i', messageId: 'm', correlationId: 'c', conversationId: 'v', sequence: 1, emittedAt: '2026-08-23T00:00:00Z', idempotencyKey: 'k' },
      origin: 'player_message', originalText: '把田收了放箱子', requestText: '把田收了放箱子', requestKind: 'task', constraints: [],
    },
  });
  const input = { state: shared, criteria: [criterion], goalText: '把田收了放进家里的箱子', world: world(), signal: new AbortController().signal };

  const candidates = await provider.list(input);
  assert.deepEqual(candidates.map(value => value.id), ['behavior:harvest_mature_crops_to_chest']);
  assert.deepEqual(candidates[0]?.fixedArgs.behaviorParams, {
    chestPos, radius: 32, cropLimit: 128, dropLimit: 128,
    maxHarvestActions: 256, maxPickupActions: 256,
  });

  gameFacts.ages.clear();
  gameFacts.entities = [];
  gameFacts.inventory = [];
  const evaluator = capability.predicateEvaluators[0]!;
  const verdict = evaluator.evaluate({
    criterion,
    world: world(),
    evidence: { deposits: [
      { item: 'wheat', count: 2, at: 60, position: chestPos },
      { item: 'wheat_seeds', count: 3, at: 61, position: chestPos },
    ] },
  });
  assert.equal(verdict.ok, true);
  assert.match(verdict.detail, /mature=0/);
  assert.ok(verdict.evidenceRefs?.some(value => value.includes('deposited_wheat=2')));
});

test('BUG-CROSS-75 · incomplete facts and residue fail closed', async () => {
  const { game, state: gameFacts } = gameState();
  const capability = agriculture({
    game,
    resolveChestTargets: () => [{ pos: { x: 6, y: 64, z: 0 }, relation: 'nearby', distance: 6 }],
  });
  const criterion: GoalSuccessCriterion = { type: 'predicate', predicate: 'agriculture.harvest_to_chest', since: 50 };
  const shared = createGoalAgentState({
    sessionId: 'goal-harvest-fail', interactionSessionId: 'interaction-harvest-fail',
    request: {
      meta: { schemaVersion: 2, sessionId: 'i', messageId: 'm', correlationId: 'c', conversationId: 'v', sequence: 1, emittedAt: '2026-08-23T00:00:00Z', idempotencyKey: 'k' },
      origin: 'player_message', originalText: '收田', requestText: '收田', requestKind: 'task', constraints: [],
    },
  });
  const input = { state: shared, criteria: [criterion], goalText: '收田', world: world(), signal: new AbortController().signal };
  await capability.actionProviders[0]!.list(input);
  const matureSnapshot = new Map(gameFacts.ages);
  gameFacts.ages.clear();
  gameFacts.inventory = [{ name: 'wheat', count: 2, slot: 0 }];
  await capability.actionProviders[0]!.list(input);
  gameFacts.inventory = [];
  for (const [position, age] of matureSnapshot) gameFacts.ages.set(position, age);
  assert.match(capability.predicateEvaluators[0]!.evaluate({ criterion, world: world(), evidence: {} }).detail, /mature crops remain/);
  gameFacts.ages.clear();
  gameFacts.entities = [{ id: 8, name: 'item', type: 'object', position: { x: 1, y: 64, z: 0 }, droppedItem: { name: 'wheat', count: 1 } }];
  assert.match(capability.predicateEvaluators[0]!.evaluate({ criterion, world: world(), evidence: {} }).detail, /drops remain/);
});

test('BUG-CROSS-75 · agriculture Behaviors execute only registered movement/dig/deposit Atomics', async () => {
  const { game, state: gameFacts } = gameState();
  const capability = agriculture({
    game,
    resolveChestTargets: () => [{ pos: { x: 6, y: 64, z: 0 }, relation: 'nearby', distance: 6 }],
  });
  const executed: string[] = [];
  const claimedDropZones: Vec3[] = [];
  let ownerStolenWheat = 0;
  let ownerStolenSeeds = 0;
  const context = (taskParams: Record<string, unknown>) => ({
    taskParams,
    getWorld: world,
    publish: () => {},
    execute: async (request: Parameters<NonNullable<(typeof capability.behaviors)[number]['run']>>[0] extends { execute(value: infer T): unknown } ? T : never) => {
      executed.push(request.type);
      if (request.type === 'dig' && request.target?.position) {
        // Model a nearby player taking any previous crop drops that the Bot
        // failed to collect before starting the next dig.
        for (const entity of gameFacts.entities) {
          if (entity.droppedItem?.name === 'wheat') ownerStolenWheat += entity.droppedItem.count;
          if (entity.droppedItem?.name === 'wheat_seeds') ownerStolenSeeds += entity.droppedItem.count;
        }
        gameFacts.entities = [];
        gameFacts.ages.delete(key(request.target.position));
        const base = 40 + gameFacts.entities.length;
        gameFacts.entities.push(
          { id: base, name: 'item', type: 'object', position: request.target.position, droppedItem: { name: 'wheat', count: 1 } },
          { id: base + 1, name: 'item', type: 'object', position: request.target.position, droppedItem: { name: 'wheat_seeds', count: 1 } },
        );
      }
      if (request.type === 'move_to' && request.resource.includes('inventory') && request.target?.position) {
        claimedDropZones.push(request.target.position);
      }
      if (request.type === 'move_to' && request.resource.includes('inventory') && gameFacts.entities.length > 0) {
        const drop = gameFacts.entities.shift()?.droppedItem;
        if (drop) gameFacts.inventory.push({ name: drop.name, count: drop.count, slot: gameFacts.inventory.length });
      }
      if (request.type === 'deposit') gameFacts.inventory = gameFacts.inventory.filter(value => value.name !== request.target?.itemName);
      return { ok: true, request, durationMs: 1 };
    },
  });

  const harvest = capability.behaviors?.find(value => value.id === 'harvest_mature_crops_to_chest');
  assert.ok(harvest?.run);
  assert.equal((await harvest.run(context({
    chestPos: { x: 6, y: 64, z: 0 },
    maxHarvestActions: 20,
    maxPickupActions: 20,
  }))).ok, true);
  assert.equal(gameFacts.ages.has('1:63:0'), false);
  assert.equal(gameFacts.ages.has('2:63:0'), false);
  assert.equal(gameFacts.ages.get('3:63:0'), '4');

  assert.equal(gameFacts.entities.length, 0);
  assert.equal(ownerStolenWheat, 0);
  assert.equal(ownerStolenSeeds, 0);
  assert.ok(claimedDropZones.length >= 2);
  assert.ok(claimedDropZones[0]!.x < 1, 'drop claim point should intercept between crop x=1 and owner x=0');
  assert.deepEqual([...new Set(executed)], ['move_to', 'dig', 'deposit']);
  assert.equal(gameFacts.inventory.length, 0);
});

function key(value: Vec3): string { return `${value.x}:${value.y}:${value.z}`; }
function parsePosition(value: string): Vec3 {
  const [x, y, z] = value.split(':').map(Number);
  return { x: x!, y: y!, z: z! };
}
