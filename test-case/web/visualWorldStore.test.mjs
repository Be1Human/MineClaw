import test from 'node:test';
import assert from 'node:assert/strict';
import { VisualWorldStore } from '../../apps/minecraft-companion/web/src/lib/authentic/visualWorldStore.js';

function section() {
  return {
    key: '-1,-4,2', chunkX: -1, sectionY: -4, chunkZ: 2,
    palette: [{ stateId: 0, name: 'air', properties: {} }],
    indices: new Uint16Array(4096),
    blockLight: new Uint8Array(4096),
    skyLight: new Uint8Array(4096).fill(15),
    biomePalette: [{ id: 1, name: 'plains' }],
    biomeIndices: new Uint16Array(4096), nonAirBlocks: 0,
  };
}

function bootstrap(sequence = 4) {
  return {
    protocol: 'mineclaw.visual-world/v1', sessionId: 's1', generation: 2, sequence,
    gameVersion: '1.21', center: { chunkX: -1, chunkZ: 2 }, sections: [section()],
    entities: [], environment: { dimension: 'overworld' }, serverResourcePack: null,
  };
}

function blockDelta(sequence, stateId = 1) {
  return {
    kind: 'block', sessionId: 's1', generation: 2, sequence, timestamp: sequence,
    position: { x: -16, y: -64, z: 32 },
    state: { stateId, name: 'stone', properties: {} }, blockLight: 3, skyLight: 12,
    biome: { id: 1, name: 'plains' },
  };
}

function batch(fromSequence, toSequence, deltas) {
  return {
    protocol: 'mineclaw.visual-world-delta/v1', sessionId: 's1', generation: 2,
    fromSequence, toSequence, deltas, createdAt: Date.now(),
  };
}

test('FEAT-WEBUI-27-002 | bootstrap 前增量排队，负坐标 section/state/light round-trip', () => {
  const store = new VisualWorldStore({ maxQueuedDeltaBatches: 4 });
  store.receiveBatch(batch(5, 6, [blockDelta(6)]));
  assert.equal(store.applyBootstrap(bootstrap()), true);
  assert.equal(store.sequence, 6);
  assert.equal(store.sections.get('-1,-4,2').palette[1].name, 'stone');
  assert.equal(store.sections.get('-1,-4,2').indices[0], 1);
  assert.equal(store.sections.get('-1,-4,2').blockLight[0], 3);
});

test('FEAT-WEBUI-27-002 | 序列缺口、跨 session 和 reset 均 fail-closed 请求 resync', () => {
  const gap = new VisualWorldStore({ maxQueuedDeltaBatches: 4 });
  gap.applyBootstrap(bootstrap());
  assert.equal(gap.receiveBatch(batch(8, 8, [blockDelta(8)])), false);
  assert.equal(gap.resyncReason, 'sequence_gap');

  const reset = new VisualWorldStore({ maxQueuedDeltaBatches: 4 });
  reset.applyBootstrap(bootstrap());
  assert.equal(reset.receiveBatch(batch(5, 5, [{
    kind: 'reset', sessionId: 's1', generation: 2, sequence: 5, timestamp: 5, reason: 'dimension_change',
  }])), false);
  assert.equal(reset.resyncReason, 'dimension_change');
  assert.equal(reset.sections.size, 0);
  assert.equal(reset.entities.size, 0);
  assert.deepEqual(reset.takeRemovedSections(), ['-1,-4,2']);
});
