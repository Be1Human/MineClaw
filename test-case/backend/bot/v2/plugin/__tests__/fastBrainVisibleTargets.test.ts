import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import type { Bot } from 'mineflayer';
import { MineflayerGameAdapter } from '../../../../../../apps/minecraft-companion/src/bot/mineflayer/MineflayerGameAdapter.js';
import { MineflayerVisibleTargets } from '../../../../../../apps/minecraft-companion/src/bot/mineflayer/MineflayerVisibleTargets.js';
import { SwitchableGameAdapter } from '../../../../../../apps/minecraft-companion/src/bot/adapter/SwitchableGameAdapter.js';
import { NullGameAdapter } from '../../../../../../apps/minecraft-companion/src/bot/adapter/NullGameAdapter.js';
import { FastBrainAdapter, type DecisionContext } from '../../../../../../apps/minecraft-companion/src/bot/v2/plugins/builtin/fastbrain/adapter.js';
import { createFastBrainVisibleTargets, createFastBrainVisibleTargetHandlers } from '../../../../../../apps/minecraft-companion/src/bot/v2/plugins/builtin/fastbrain/visibleTargets.js';
import { __setTuningOverride } from '../../../../../../apps/minecraft-companion/src/bot/v2/infra/tuning.js';

const require = createRequire(new URL('../../../../../../apps/minecraft-companion/package.json', import.meta.url));
const { Vec3 } = require('vec3');
const registry = require('minecraft-data')('1.20.4');
const World = require('prismarine-world')(registry);
const Chunk = require('prismarine-chunk')(registry);
const injectBlocks = require('mineflayer/lib/plugins/blocks.js');
afterEach(() => __setTuningOverride(null));

function context(overrides: Partial<DecisionContext> = {}): DecisionContext {
  const now = Date.now();
  return { requestId: 'request-1', sessionId: 'session-1', actor: 'fixture-bot', dimension: 'overworld',
    notBefore: now - 1000, deadlineAt: now + 30_000, signal: new AbortController().signal,
    isCurrent: () => true, ...overrides };
}

/** Real Mineflayer findBlocks/canSeeBlock and real chunk/raycast; no server or body writes. */
function device() {
  const bot: any = new EventEmitter();
  bot.username = 'fixture-bot'; bot.version = '1.20.4'; bot.registry = registry;
  bot._client = new EventEmitter();
  bot.game = { dimension: 'overworld', minY: -64, height: 384 };
  bot.world = new World(null).sync;
  bot.world.setColumn(0, 0, new Chunk({ minY: -64, worldHeight: 384 }));
  bot.entity = { id: 1, position: new Vec3(0.5, 64, 0.5), eyeHeight: 1.62 };
  bot.health = 20;
  bot.supportFeature = () => false;
  const writes: string[] = [];
  for (const name of ['dig', 'setControlState', 'placeBlock', 'activateItem']) {
    bot[name] = () => { writes.push(name); throw new Error('read_must_not_write'); };
  }
  injectBlocks(bot, { version: '1.20.4' });
  const setBlock = (x: number, y: number, z: number, name: string, emit = true) => {
    const p = new Vec3(x, y, z);
    const before = bot.blockAt(p);
    bot.world.setBlockStateId(p, registry.blocksByName[name].defaultState);
    if (emit) bot.emit('blockUpdate', before, bot.blockAt(p));
  };
  setBlock(2, 65, 0, 'oak_log');
  let current: Bot | null = bot;
  const adapter = new MineflayerGameAdapter(() => current);
  adapter.rebindSubscriptions(bot);
  return { bot, adapter, writes, setBlock,
    spawn: () => bot.emit('spawn'),
    replace: (next: Bot | null) => { current = next; },
  };
}

test('real blocks plugin yields a visible scoped reference, revalidated without binding or moving the body', () => {
  const f = device(); f.spawn();
  const service = createFastBrainVisibleTargets(f.adapter);
  const result = service.search('oak_log', 6, context());
  assert.equal(result.status, 'partial');
  assert.equal(result.complete, false);
  assert.equal(result.reason, 'search_coverage_unproven');
  assert.equal(result.targets.length, 1);
  const target = result.targets[0]!;
  assert.equal(target.name, 'oak_log');
  assert.equal(target.actor, 'fixture-bot');
  assert.equal(target.sessionId, 'session-1');
  assert.deepEqual(target.position, { x: 2, y: 65, z: 0 });
  assert.equal(service.resolve(target.targetId, context()).status, 'resolved');
  assert.deepEqual(f.writes, []);
  service.close();
});

test('loaded oak behind a real opaque block is not visible and does not prove the region empty', () => {
  const f = device(); f.setBlock(1, 65, 0, 'stone'); f.spawn();
  assert.equal(f.bot.blockAt(new Vec3(2, 65, 0)).name, 'oak_log');
  assert.equal(f.bot.canSeeBlock(f.bot.blockAt(new Vec3(2, 65, 0))), false);
  const service = createFastBrainVisibleTargets(f.adapter);
  const result = service.search('oak_log', 6, context());
  assert.deepEqual(result.targets, []);
  assert.deepEqual(result.observedBounds.positions, []);
  assert.equal(result.complete, false);
  assert.equal(result.status, 'partial');
  service.close();
});

test('search filters range, duplicate coordinates, changed block types and unloaded candidates', () => {
  const f = device(); f.spawn();
  f.bot.findBlocks = () => [new Vec3(2, 65, 0), new Vec3(2, 65, 0), new Vec3(10, 65, 0),
    new Vec3(3, 65, 0), new Vec3(0, 65, 20), new Vec3(NaN, 65, 0)];
  f.setBlock(3, 65, 0, 'stone');
  const service = createFastBrainVisibleTargets(f.adapter);
  assert.equal(service.search('oak_log', 6, context()).targets.length, 1);
  service.close();
});

test('runtime scan limits constrain radius and expose truncation without claiming complete coverage', () => {
  __setTuningOverride({ worldScan: { blockScanRadius: 4, blockScanCount: 1 } });
  const f = device(); f.setBlock(0, 65, 3, 'oak_log'); f.spawn();
  const service = createFastBrainVisibleTargets(f.adapter);
  const truncated = service.search('oak_log', 4, context());
  assert.equal(truncated.truncated, true);
  assert.equal(truncated.targets.length, 1);
  assert.equal(truncated.complete, false);
  let queries = 0; const find = f.bot.findBlocks;
  f.bot.findBlocks = (...args: any[]) => { queries++; return find(...args); };
  assert.equal(service.search('oak_log', 5, context()).reason, 'search_radius_out_of_bounds');
  assert.equal(queries, 0);
  service.close();
});

test('spawn must be witnessed; same-dimension respawn invalidates all old references', () => {
  const f = device();
  const service = createFastBrainVisibleTargets(f.adapter);
  assert.equal(service.search('oak_log', 6, context()).reason, 'visible_targets_not_spawned');
  f.spawn();
  const old = service.search('oak_log', 6, context()).targets[0]!;
  f.bot.emit('respawn');
  assert.equal(service.resolve(old.targetId, context()).status, 'unavailable');
  assert.equal(service.search('oak_log', 6, context()).reason, 'visible_targets_not_spawned');
  f.spawn();
  assert.equal(service.resolve(old.targetId, context()).status, 'unavailable');
  assert.equal(service.search('oak_log', 6, context()).targets.length, 1);
  service.close();
});

test('opaque read generation rejects pre-spawn and never recovers after a same-world respawn', () => {
  const f = device();
  const source = new MineflayerVisibleTargets(() => f.bot);
  source.rebind(f.bot);
  const preSpawn = source.captureReadGeneration('fixture-bot', 'overworld');
  assert.equal(preSpawn(), false);
  f.spawn();
  assert.equal(preSpawn(), false);
  const current = source.captureReadGeneration('fixture-bot', 'minecraft:overworld');
  assert.equal(current(), true);
  assert.equal(source.captureReadGeneration('other-bot', 'overworld')(), false);
  f.bot.emit('respawn');
  assert.equal(current(), false);
  f.spawn();
  assert.equal(current(), false);
  assert.equal(source.captureReadGeneration('fixture-bot', 'overworld')(), true);
  source.rebind(null);
});

test('actor, dimension and host session cannot be substituted for the issued reference', () => {
  const f = device(); f.spawn();
  const service = createFastBrainVisibleTargets(f.adapter);
  const target = service.search('oak_log', 6, context()).targets[0]!;
  assert.equal(service.search('oak_log', 6, context({ actor: 'other-bot' })).reason, 'observation_identity_mismatch');
  assert.equal(service.search('oak_log', 6, context({ dimension: 'the_nether' })).reason, 'observation_identity_mismatch');
  const fresh = service.search('oak_log', 6, context()).targets[0]!;
  assert.deepEqual(service.resolve(fresh.targetId, context({ sessionId: 'other-session' })),
    { status: 'unavailable', reason: 'target_ref_session_mismatch' });
  assert.equal(service.resolve(target.targetId, context()).status, 'unavailable');
  service.close();
});

test('a replacement Bot cannot inherit spawn proof or references, even with the same actor and dimension', () => {
  const first = device(); const second = device(); first.spawn();
  const service = createFastBrainVisibleTargets(first.adapter);
  const target = service.search('oak_log', 6, context()).targets[0]!;
  first.replace(second.bot);
  assert.equal(service.resolve(target.targetId, context()).status, 'unavailable');
  assert.equal(service.search('oak_log', 6, context()).reason, 'visible_targets_not_spawned');
  second.spawn();
  assert.equal(service.search('oak_log', 6, context()).targets.length, 1);
  assert.equal(service.resolve(target.targetId, context()).status, 'unavailable');
  service.close();
});

test('switchable adapter replacement fences old refs and stopping one service does not close the concrete source', () => {
  const first = device(); const second = device(); first.spawn(); second.spawn();
  const game = new SwitchableGameAdapter(first.adapter);
  const service = createFastBrainVisibleTargets(game);
  const old = service.search('oak_log', 6, context()).targets[0]!;
  game.setTarget(second.adapter);
  assert.equal(service.resolve(old.targetId, context()).status, 'unavailable');
  assert.equal(service.search('oak_log', 6, context()).targets.length, 1);
  service.close();
  assert.equal(service.search('oak_log', 6, context()).reason, 'visible_targets_closed');
  const next = createFastBrainVisibleTargets(game);
  assert.equal(next.search('oak_log', 6, context()).targets.length, 1);
  next.close();
});

test('new observation, forged IDs and returned-object edits never retarget an old reference', () => {
  const f = device(); f.spawn();
  const service = createFastBrainVisibleTargets(f.adapter);
  const first = service.search('oak_log', 6, context()).targets[0]!;
  (first.position as { x: number }).x = 99;
  const resolved = service.resolve(first.targetId, context());
  assert.equal(resolved.status, 'resolved');
  if (resolved.status === 'resolved') assert.equal(resolved.target.position.x, 2);
  service.search('oak_log', 6, context());
  assert.equal(service.resolve(first.targetId, context()).status, 'unavailable');
  assert.equal(service.resolve('forged-coordinate:2,65,0', context()).status, 'unavailable');
  service.close();
});

test('block removal/replacement ABA and newly introduced occlusion invalidate references', () => {
  const f = device(); f.spawn();
  const service = createFastBrainVisibleTargets(f.adapter);
  const old = service.search('oak_log', 6, context()).targets[0]!;
  f.setBlock(2, 65, 0, 'air'); f.setBlock(2, 65, 0, 'oak_log');
  assert.equal(service.resolve(old.targetId, context()).status, 'unavailable');
  const fresh = service.search('oak_log', 6, context()).targets[0]!;
  f.setBlock(1, 65, 0, 'stone');
  assert.deepEqual(service.resolve(fresh.targetId, context()), { status: 'unavailable', reason: 'target_ref_no_longer_visible' });
  service.close();
});

test('moving outside the observation radius and replacing the world cannot preserve target authority', () => {
  const f = device(); f.spawn();
  const service = createFastBrainVisibleTargets(f.adapter);
  const target = service.search('oak_log', 6, context()).targets[0]!;
  f.bot.entity.position.x = 30;
  assert.deepEqual(service.resolve(target.targetId, context()), { status: 'unavailable', reason: 'target_ref_out_of_bounds' });
  f.bot.entity.position.x = 0.5;
  f.bot.world = new World(null).sync;
  assert.equal(service.search('oak_log', 6, context()).reason, 'visible_targets_world_changed');
  service.close();
});

test('freshness is runtime configurable and dead/disconnected actors are never query-ready', () => {
  __setTuningOverride({ knowledgeQuery: { maxFreshnessMs: 10 } });
  const f = device(); let now = Date.now();
  const source = new MineflayerVisibleTargets(() => f.bot, () => now);
  source.rebind(f.bot); f.spawn();
  const reader = source.open();
  const target = reader.search('oak_log', 6, context()).targets[0]!;
  now += 11;
  assert.deepEqual(reader.resolve(target.targetId, context()), { status: 'unavailable', reason: 'target_ref_stale' });
  f.bot.health = 0;
  assert.equal(reader.search('oak_log', 6, context()).reason, 'visible_targets_world_changed');
  f.bot.emit('end', 'fixture disconnect');
  assert.equal(reader.search('oak_log', 6, context()).reason, 'visible_targets_not_spawned');
  reader.close(); source.rebind(null);
});

test('cancel, deadline and missing LOS fail closed before issuing a world query', () => {
  const f = device(); f.spawn(); let queries = 0;
  const find = f.bot.findBlocks; f.bot.findBlocks = (...args: any[]) => { queries++; return find(...args); };
  const service = createFastBrainVisibleTargets(f.adapter);
  const cancelled = new AbortController(); cancelled.abort();
  assert.equal(service.search('oak_log', 6, context({ signal: cancelled.signal })).status, 'cancelled');
  assert.equal(service.search('oak_log', 6, context({ deadlineAt: Date.now() - 1 })).status, 'timeout');
  assert.equal(queries, 0);
  f.bot.canSeeBlock = undefined;
  assert.equal(service.search('oak_log', 6, context()).reason, 'visible_targets_query_unavailable');
  assert.equal(queries, 0);
  service.close();
});

test('cancellation and world changes during a query never publish partially minted references', () => {
  const f = device(); f.spawn(); const controller = new AbortController();
  const find = f.bot.findBlocks;
  f.bot.findBlocks = (...args: any[]) => { const matches = find(...args); controller.abort(); return matches; };
  const service = createFastBrainVisibleTargets(f.adapter);
  const result = service.search('oak_log', 6, context({ signal: controller.signal }));
  assert.equal(result.status, 'cancelled');
  assert.deepEqual(result.targets, []);
  f.bot.findBlocks = find;
  const canSee = f.bot.canSeeBlock;
  f.bot.canSeeBlock = (block: unknown) => { const visible = canSee(block); f.bot.emit('respawn'); return visible; };
  assert.deepEqual(service.search('oak_log', 6, context()).targets, []);
  service.close();
});

test('unsupported entity kinds, unknown visibility and a missing concrete mapping do not become fake empty worlds', () => {
  const f = device(); f.spawn();
  const service = createFastBrainVisibleTargets(f.adapter);
  assert.equal(service.search('cow', 6, context()).reason, 'search_block_kind_unsupported');
  f.bot.canSeeBlock = () => { throw new Error('raycast unavailable'); };
  assert.equal(service.search('oak_log', 6, context()).status, 'error');
  service.close();
  const unavailable = createFastBrainVisibleTargets(new NullGameAdapter('fixture-bot'));
  const result = unavailable.search('oak_log', 6, context());
  assert.equal(result.reason, 'visible_targets_contract_unavailable');
  assert.equal(result.complete, false);
  unavailable.close();
});

test('search handler maps concrete partial results into the shared DecisionPort without an observation-schema fork', async () => {
  const f = device(); f.spawn();
  const service = createFastBrainVisibleTargets(f.adapter);
  const adapter = new FastBrainAdapter({ handlers: createFastBrainVisibleTargetHandlers(service), isActive: () => true });
  const result = await adapter.port().submit({ type: 'call', skill: 'search', args: { kind: 'oak_log', radius: 6 } }, context());
  assert.equal(result.status, 'partial');
  assert.equal(result.observation, undefined);
  assert.equal(result.details?.complete, false);
  assert.equal((result.details?.targets as unknown[]).length, 1);
  assert.equal(result.effectKnowledge, 'confirmed');
  assert.deepEqual(f.writes, []);
  adapter.close(); service.close();
});
