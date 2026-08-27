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
    biomesById: { 4: { name: 'forest' } },
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
    entity: { position: { x: 8, y: 64, z: 8 } },
    game: { minY: 0, height: 16, dimension: 'overworld' },
    version: '1.21',
    registry: { blocksByStateId: { 0: { name: 'air' } }, biomesById: { 1: { name: 'plains' } } },
    entities: {},
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
