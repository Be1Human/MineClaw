import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { PluginHost } from '../../../../../../apps/minecraft-companion/src/bot/v2/plugin-kernel/index.js';
import { createMineclawMinecraftSystemPlugin } from '../../../../../../apps/minecraft-companion/src/bot/v2/plugins/builtin/minecraft-system/index.js';
import { createMineclawOwnerProtectionPlugin } from '../../../../../../apps/minecraft-companion/src/bot/v2/plugins/builtin/owner-protection/index.js';
import type { BuiltinPluginIndex } from '../../../../../../apps/minecraft-companion/src/bot/v2/plugin-kernel/discovery.js';

const BUILTIN = fileURLToPath(new URL('../../../../../../apps/minecraft-companion/src/bot/v2/plugins/builtin/', import.meta.url));
const EXECUTOR = 'mineclaw.owner-protection.execution.protect-owner';

function builtin(id: string, factory: () => unknown) {
  const manifest = parse(readFileSync(`${BUILTIN}/${id}/plugin.yaml`, 'utf8')) as Record<string, unknown>;
  return { entryKey: `plugins/builtin/${manifest.id}`, manifest, factory: factory() as never };
}

function index(): BuiltinPluginIndex {
  return { byEntryKey: new Map([
    ['plugins/builtin/mineclaw.minecraft-system', builtin('minecraft-system', createMineclawMinecraftSystemPlugin)],
    ['plugins/builtin/mineclaw.owner-protection', builtin('owner-protection', createMineclawOwnerProtectionPlugin)],
  ]) };
}

function world(input: {
  distance?: number;
  hostile?: boolean;
  held?: string | null;
  items?: Array<{ name: string; count: number; slot: number }>;
  armor?: { head: null; torso: null; legs: null; feet: null };
  dropped?: { id: number; name: string; distance: number; position: { x: number; y: number; z: number }; droppedItem: { name: string; count: number } };
} = {}) {
  const owner = { username: 'cloudboyboy', position: { x: 10, y: 64, z: 0 }, distance: input.distance ?? 10, entityId: 7, isVisible: true };
  return {
    tick: 1, observedAt: Date.now(), self: { position: { x: 0, y: 64, z: 0 }, health: 20, maxHealth: 20, food: 20 }, owner,
    inventory: { items: input.items ?? [], held: input.held ? { name: input.held, count: 1, slot: 0 } : null, armor: input.armor ?? { head: null, torso: null, legs: null, feet: null }, freeSlots: 36 },
    entities: [
      ...(input.hostile ? [{ id: 99, name: 'zombie', category: 'hostile', distance: 2, position: { x: 2, y: 64, z: 0 } }] : []),
      ...(input.dropped ? [{ ...input.dropped, category: 'item' }] : []),
    ],
  };
}

const config = {
  loopIntervalMs: 1, ownerProtectionFollowDistance: 4, ownerProtectionThreatRadius: 10, ownerProtectionEngagementRange: 2.5, ownerProtectionAttackRange: 3,
  ownerProtectionMoveCooldownMs: 0, ownerProtectionMovementSliceMs: 350, ownerProtectionFollowSliceMs: 250, ownerProtectionHealthThreshold: 16, ownerProtectionRecoveryCooldownMs: 1,
  ownerProtectionLoadoutPickupRadius: 16, ownerProtectionLoadoutRetryMs: 1,
};

test('owner-protection registers as a default-on proactive persistent activity', async () => {
  const host = new PluginHost({ hostApiVersion: '2.0.0', buildId: 'owner-protection', builtinIndex: index(), trustedSystemPlugins: ['mineclaw.minecraft-system'] });
  const result = await host.boot();
  assert.deepEqual(result.failures, [], JSON.stringify(result.failures));
  const registry = result.slot.read().active.registry;
  assert.ok(registry.byId.has(EXECUTOR));
  const proactive = registry.byId.get('mineclaw.owner-protection.proactive.auto-protect-owner')!.contribution as { defaultEnabled: boolean; evaluator: (input: Record<string, unknown>) => boolean };
  assert.equal(proactive.defaultEnabled, true);
  assert.equal(proactive.evaluator({ world: { owner: world().owner } }), true);
  assert.equal(proactive.evaluator({ world: { owner: { ...world().owner, isVisible: false } } }), false);
});

test('owner-protection activity follows a visible owner and intercepts a hostile near them', async () => {
  const contributions = createMineclawOwnerProtectionPlugin().create({ host: { version: '2.0.0', buildId: 'test' }, plugin: { pluginId: 'mineclaw.owner-protection', pluginVersion: '1.0.0' } });
  const execution = contributions.find(value => value.kind === 'execution' && value.id === EXECUTOR) as Extract<typeof contributions[number], { kind: 'execution' }>;
  const factory = execution.activityFactory!;

  const follow = factory.create({ goalId: 'follow' } as never, {} as never);
  const followActions: Array<Record<string, unknown>> = [];
  const followAbort = new AbortController();
  await follow.run({ goal: {} as never, signal: followAbort.signal, params: {}, observe: () => world(), getHostConfig: () => config,
    submitBody: async action => { followActions.push(action as Record<string, unknown>); return { ok: true }; },
    wait: async () => { followAbort.abort(); }, publish: () => undefined,
  });
  assert.deepEqual(followActions, [{ atomicId: 'follow_entity', args: {
    entityId: 7, range: 4, durationMs: 250,
  }, timeoutMs: 350 }]);

  const intercept = factory.create({ goalId: 'intercept' } as never, {} as never);
  const interceptActions: Array<Record<string, unknown>> = [];
  const interceptAbort = new AbortController();
  await intercept.run({ goal: {} as never, signal: interceptAbort.signal, params: {}, observe: () => world({ hostile: true, held: 'cooked_beef', items: [
    { name: 'iron_sword', count: 1, slot: 10 }, { name: 'diamond_sword', count: 1, slot: 11 }, { name: 'diamond_helmet', count: 1, slot: 12 },
  ] }), getHostConfig: () => config,
    submitBody: async action => { interceptActions.push(action as Record<string, unknown>); return { ok: true }; },
    wait: async () => { interceptAbort.abort(); }, publish: () => undefined,
  });
  assert.deepEqual(interceptActions, [
    { atomicId: 'combat_round', args: { entityId: 99 } },
  ]);
});

test('owner-protection never lets a dropped loadout preempt a nearby owner threat', async () => {
  const contributions = createMineclawOwnerProtectionPlugin().create({ host: { version: '2.0.0', buildId: 'test' }, plugin: { pluginId: 'mineclaw.owner-protection', pluginVersion: '1.0.0' } });
  const execution = contributions.find(value => value.kind === 'execution' && value.id === EXECUTOR) as Extract<typeof contributions[number], { kind: 'execution' }>;
  const activity = execution.activityFactory!.create({ goalId: 'threat-before-loot' } as never, {} as never);
  const controller = new AbortController();
  const actions: Array<Record<string, unknown>> = [];
  await activity.run({
    goal: {} as never, signal: controller.signal, params: {},
    observe: () => world({ hostile: true, dropped: { id: 31, name: 'item', distance: 1, position: { x: 1, y: 64, z: 0 }, droppedItem: { name: 'diamond_sword', count: 1 } } }),
    getHostConfig: () => config,
    submitBody: async action => { actions.push(action as Record<string, unknown>); return { ok: true }; },
    wait: async () => { controller.abort(); }, publish: () => undefined,
  });
  assert.deepEqual(actions, [{ atomicId: 'combat_round', args: { entityId: 99 } }]);
});

test('owner-protection ranks threats by owner distance before guard distance', async () => {
  const contributions = createMineclawOwnerProtectionPlugin().create({ host: { version: '2.0.0', buildId: 'test' }, plugin: { pluginId: 'mineclaw.owner-protection', pluginVersion: '1.0.0' } });
  const execution = contributions.find(value => value.kind === 'execution' && value.id === EXECUTOR) as Extract<typeof contributions[number], { kind: 'execution' }>;
  const activity = execution.activityFactory!.create({ goalId: 'rank-owner-nearest' } as never, {} as never);
  const controller = new AbortController();
  const actions: Array<Record<string, unknown>> = [];
  const rankedWorld = {
    ...world(),
    entities: [
      { id: 10, name: 'zombie', category: 'hostile' as const, distance: 1, position: { x: 1, y: 64, z: 0 } },
      { id: 11, name: 'zombie', category: 'hostile' as const, distance: 8, position: { x: 9, y: 64, z: 0 } },
    ],
  };
  await activity.run({ goal: {} as never, signal: controller.signal, params: {}, observe: () => rankedWorld, getHostConfig: () => config,
    submitBody: async action => { actions.push(action as Record<string, unknown>); return { ok: true }; },
    wait: async () => { controller.abort(); }, publish: () => undefined,
  });
  assert.deepEqual(actions, [{ atomicId: 'invoke_behavior', args: {
    behavior: 'advanced_move_to', behaviorParams: { position: { x: 9, y: 64, z: 0 }, range: 2.5 },
  }, timeoutMs: 350 }]);
});

test('owner-protection pursues the nearest visible threat instead of tailing a running owner', async () => {
  const contributions = createMineclawOwnerProtectionPlugin().create({ host: { version: '2.0.0', buildId: 'test' }, plugin: { pluginId: 'mineclaw.owner-protection', pluginVersion: '1.0.0' } });
  const execution = contributions.find(value => value.kind === 'execution' && value.id === EXECUTOR) as Extract<typeof contributions[number], { kind: 'execution' }>;
  const activity = execution.activityFactory!.create({ goalId: 'pursue' } as never, {} as never);
  const controller = new AbortController();
  const actions: Array<Record<string, unknown>> = [];
  const farThreat = { ...world(), entities: [{ id: 55, name: 'zombie', category: 'hostile', distance: 40, position: { x: 10, y: 64, z: 40 } }] };
  await activity.run({ goal: {} as never, signal: controller.signal, params: {}, observe: () => farThreat, getHostConfig: () => ({ ...config, ownerProtectionThreatRadius: 64 }),
    submitBody: async action => { actions.push(action as Record<string, unknown>); return { ok: true }; },
    wait: async () => { controller.abort(); }, publish: () => undefined,
  });
  assert.deepEqual(actions, [{ atomicId: 'invoke_behavior', args: {
    behavior: 'advanced_move_to', behaviorParams: { position: { x: 10, y: 64, z: 40 }, range: 2.5 },
  }, timeoutMs: 350 }]);
});

test('owner-protection restores a dropped combat item through the normal movement behavior before fighting', async () => {
  const contributions = createMineclawOwnerProtectionPlugin().create({ host: { version: '2.0.0', buildId: 'test' }, plugin: { pluginId: 'mineclaw.owner-protection', pluginVersion: '1.0.0' } });
  const execution = contributions.find(value => value.kind === 'execution' && value.id === EXECUTOR) as Extract<typeof contributions[number], { kind: 'execution' }>;
  const activity = execution.activityFactory!.create({ goalId: 'restore-loadout' } as never, {} as never);
  const controller = new AbortController();
  const actions: Array<Record<string, unknown>> = [];
  await activity.run({
    goal: {} as never,
    signal: controller.signal,
    params: {},
    observe: () => world({
      dropped: { id: 31, name: 'item', distance: 3, position: { x: 3, y: 64, z: 0 }, droppedItem: { name: 'diamond_sword', count: 1 } },
    }),
    getHostConfig: () => config,
    submitBody: async action => { actions.push(action as Record<string, unknown>); return { ok: true }; },
    wait: async () => { controller.abort(); },
    publish: () => undefined,
  });
  assert.deepEqual(actions, [{ atomicId: 'invoke_behavior', args: {
    behavior: 'advanced_move_to', behaviorParams: { position: { x: 3, y: 64, z: 0 }, range: 1 },
  } }]);
});
