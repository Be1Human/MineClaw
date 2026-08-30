import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeVisualSection } from '../../../../../apps/minecraft-companion/src/bot/mineflayer/MineflayerVisualWorldSource.js';
import { VisualWorldDeltaBatcher } from '../../../../../apps/minecraft-companion/src/hub/visualWorldDeltaBatcher.js';
import type { VisualWorldDelta } from '../../../../../apps/minecraft-companion/src/bot/adapter/VisualWorldSource.js';
import { MineflayerVisualWorldSource } from '../../../../../apps/minecraft-companion/src/bot/mineflayer/MineflayerVisualWorldSource.js';
import { EventEmitter } from 'node:events';

test('FEAT-WEBUI-27-002 | 区段编码保留方块状态、属性、光照、生物群系与紧凑调色板', () => {
  const column = {
    getBlockStateId: (position: { x: number; y: number; z: number }) => position.x === 0 && position.y === 0 && position.z === 0 ? 1 : 0,
    getBlock: (position: { x: number; y: number; z: number }) => {
      const stone = position.x === 0 && position.y === 0 && position.z === 0;
      return {
        stateId: stone ? 1 : 0,
        name: stone ? 'oak_log' : 'air',
        getProperties: () => stone ? { axis: 'y' } : {},
      };
    },
    getBlockLight: (position: { x: number }) => position.x === 0 ? 7 : 0,
    getSkyLight: () => 15,
    getBiome: () => 4,
  };
  const registry = {
    blocksByStateId: { 0: { name: 'air' }, 1: { name: 'oak_log' } },
    biomes: { 4: { name: 'forest' } },
  };

  const section = encodeVisualSection(column as never, registry, 2, 0, -3);
  assert.equal(section.key, '2,0,-3');
  assert.equal(section.indices.length, 4096);
  assert.equal(section.palette.length, 2);
  assert.equal(section.nonAirBlocks, 1);
  assert.deepEqual(section.palette[0], { stateId: 1, name: 'oak_log', properties: { axis: 'y' } });
  assert.equal(section.blockLight[0], 7);
  assert.equal(section.skyLight[0], 15);
  assert.deepEqual(section.biomePalette, [{ id: 4, name: 'forest' }]);
  const highSection = encodeVisualSection(column as never, registry, -2, 19, 3);
  assert.equal(highSection.key, '-2,19,3');
  assert.equal(highSection.indices.length, 4096);
});

test('FEAT-WEBUI-27-002 | 增量批处理按方块/实体去重、保序并由 reset 截断旧世代', () => {
  const sent: Array<{ deltas: VisualWorldDelta[]; fromSequence: number; toSequence: number }> = [];
  const batcher = new VisualWorldDeltaBatcher(
    () => ({ deltaBatchMs: 60_000, maxDeltaBatchEntries: 20 }),
    (_botId, batch) => sent.push(batch),
  );
  const block = (sequence: number, stateId: number): VisualWorldDelta => ({
    kind: 'block', sessionId: 'session-1', generation: 1, sequence, timestamp: sequence,
    position: { x: 1, y: 2, z: 3 },
    state: { stateId, name: stateId ? 'stone' : 'air', properties: {} },
    blockLight: 0, skyLight: 15, biome: { id: 1, name: 'plains' },
  });
  batcher.enqueue('bot-a', block(1, 0));
  batcher.enqueue('bot-a', block(2, 1));
  batcher.enqueue('bot-a', {
    kind: 'entity_remove', sessionId: 'session-1', generation: 1, sequence: 3, timestamp: 3, entityId: 9,
  });
  batcher.flush('bot-a');
  assert.deepEqual(sent[0].deltas.map(delta => delta.sequence), [2, 3]);
  assert.deepEqual([sent[0].fromSequence, sent[0].toSequence], [1, 3]);

  batcher.enqueue('bot-a', block(4, 1));
  batcher.enqueue('bot-a', {
    kind: 'reset', sessionId: 'session-2', generation: 2, sequence: 5, timestamp: 5, reason: 'dimension_change',
  });
  batcher.flush('bot-a');
  assert.deepEqual(sent[1].deltas.map(delta => delta.kind), ['reset']);
  assert.deepEqual([sent[1].fromSequence, sent[1].toSequence], [5, 5]);
  batcher.close();
});

test('FEAT-WEBUI-27-002 | 没有真实模式订阅者时不注册 Mineflayer 视觉监听', () => {
  const bot = new EventEmitter();
  const source = new MineflayerVisualWorldSource();
  source.rebind(bot as never);
  assert.equal(bot.listenerCount('blockUpdate'), 0);
  assert.equal(bot.listenerCount('entityMoved'), 0);

  const unsubscribe = source.subscribe(() => {});
  assert.equal(bot.listenerCount('blockUpdate'), 1);
  assert.equal(bot.listenerCount('entityMoved'), 1);

  unsubscribe();
  assert.equal(bot.listenerCount('blockUpdate'), 0);
  assert.equal(bot.listenerCount('entityMoved'), 0);
  source.rebind(null);
});

test('FEAT-WEBUI-27-002 | bootstrap 带版本化 session/seq 且只编码视距内已加载列', async () => {
  const bot = Object.assign(new EventEmitter(), {
    entity: visualEntityFixture(1, { type: 'player', username: 'Bot', name: 'player' }),
    game: { minY: 0, height: 16, dimension: 'overworld' },
    version: '1.21',
    registry: { blocksByStateId: { 0: { name: 'air' } }, biomesById: { 1: { name: 'plains' } } },
    entities: {
      1: visualEntityFixture(1, { type: 'player', username: 'Bot', name: 'player' }),
      2: visualEntityFixture(2, { type: 'player', username: 'Alex', name: 'player' }),
      3: visualEntityFixture(3, { type: 'object', name: 'item', getDroppedItem: () => ({ name: 'diamond' }) }),
    },
    players: { Alex: { skinData: { url: 'https://textures.example/alex.png', model: 'slim' } } },
    time: { timeOfDay: 6_000 }, isRaining: false, thunderState: 0,
    world: {
      getColumns: () => [
        { chunkX: 0, chunkZ: 0, column: emptyColumn() },
        { chunkX: 4, chunkZ: 4, column: emptyColumn() },
      ],
    },
  });
  const source = new MineflayerVisualWorldSource();
  source.rebind(bot as never);
  const snapshot = await source.createBootstrap({ viewDistanceChunks: 1, entityRenderDistance: 64 });
  assert.equal(snapshot?.protocol, 'mineclaw.visual-world/v1');
  assert.match(snapshot?.sessionId ?? '', /^[0-9a-f-]{36}$/);
  assert.equal(snapshot?.sequence, 1);
  assert.equal(snapshot?.sections.length, 0);
  assert.deepEqual(snapshot?.center, { chunkX: 0, chunkZ: 0 });
  assert.equal(snapshot?.entities.find(entity => entity.id === 1)?.isSelf, true);
  assert.equal(snapshot?.entities.find(entity => entity.id === 2)?.skinUrl, 'https://textures.example/alex.png');
  assert.equal(snapshot?.entities.find(entity => entity.id === 2)?.skinModel, 'slim');
  assert.equal(snapshot?.entities.find(entity => entity.id === 3)?.itemName, 'diamond');
  source.rebind(null);
});

test('BUG-WEBUI-28-001 | 实时列和方块只发布宽视野窗口，传送后旧窗口退出', async () => {
  const botEntity = visualEntityFixture(1, { type: 'player', username: 'Bot', name: 'player' });
  const column = emptyColumn();
  const bot = Object.assign(new EventEmitter(), {
    entity: botEntity,
    game: { minY: 0, height: 16, dimension: 'overworld' },
    version: '1.21.1',
    registry: { blocksByStateId: { 0: { name: 'air' }, 1: { name: 'stone' } }, biomes: { 1: { name: 'plains' } } },
    entities: { 1: botEntity },
    players: {},
    time: { timeOfDay: 6_000 }, isRaining: false, thunderState: 0,
    world: {
      getColumns: () => [],
      getColumn: (chunkX: number, chunkZ: number) => (chunkZ === 0 && (chunkX === 3 || chunkX === 13) ? column : null),
    },
  });
  const source = new MineflayerVisualWorldSource();
  const deltas: VisualWorldDelta[] = [];
  source.rebind(bot as never);
  const unsubscribe = source.subscribe(delta => deltas.push(delta));
  const snapshot = await source.createBootstrap({ viewDistanceChunks: 3, entityRenderDistance: 96 });
  assert.equal(snapshot?.viewDistanceChunks, 3);
  deltas.length = 0;

  bot.emit('chunkColumnLoad', { x: 4 * 16, z: 0 });
  bot.emit('blockUpdate', null, visualBlockFixture(4 * 16, 64, 0));
  await settleAsyncWork();
  assert.equal(deltas.length, 0, '半径 3 外的实时事件不得发布');

  bot.emit('chunkColumnLoad', { x: 3 * 16, z: 0 });
  bot.emit('blockUpdate', null, visualBlockFixture(3 * 16, 64, 0));
  await settleAsyncWork();
  assert.ok(deltas.some(delta => delta.kind === 'column_replace' && delta.chunkX === 3));
  assert.ok(deltas.some(delta => delta.kind === 'block' && Math.floor(delta.position.x / 16) === 3));
  deltas.length = 0;

  bot.entity.position.x = 10 * 16;
  bot.emit('move');
  await settleAsyncWork();
  assert.equal(deltas.filter(delta => delta.kind === 'column_unload').length, 49, '无重叠传送应完整卸载旧的 7×7 窗口');
  assert.ok(deltas.some(delta => delta.kind === 'column_replace' && delta.chunkX === 13), '新窗口已加载列应渐进替换');

  deltas.length = 0;
  bot.emit('blockUpdate', null, visualBlockFixture(0, 64, 0));
  bot.emit('blockUpdate', null, visualBlockFixture(10 * 16, 64, 0));
  assert.deepEqual(deltas.filter(delta => delta.kind === 'block').map(delta => Math.floor(delta.position.x / 16)), [10]);

  unsubscribe();
  source.rebind(null);
});

function emptyColumn() {
  return {
    getBlockStateId: () => 0,
    getBlock: () => ({ stateId: 0, name: 'air', getProperties: () => ({}) }),
    getBlockLight: () => 0,
    getSkyLight: () => 15,
    getBiome: () => 1,
  };
}

function visualEntityFixture(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id, type: 'mob', name: 'zombie', position: { x: 8 + id, y: 64, z: 8 }, velocity: { x: 0, y: 0, z: 0 },
    yaw: 0, pitch: 0, width: 0.6, height: 1.8, onGround: true, equipment: [],
    getDroppedItem: () => null,
    ...overrides,
  };
}

function visualBlockFixture(x: number, y: number, z: number) {
  return {
    position: { x, y, z }, stateId: 1, name: 'stone', light: 0, skyLight: 15,
    biome: { id: 1 }, getProperties: () => ({}),
  };
}

async function settleAsyncWork(turns = 24) {
  for (let index = 0; index < turns; index += 1) await new Promise(resolve => setImmediate(resolve));
}
