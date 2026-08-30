import test from 'node:test';
import assert from 'node:assert/strict';
import { VisualWorldStore } from '../../apps/minecraft-companion/web/src/lib/authentic/visualWorldStore.js';

function section({ key = '-1,-4,2', chunkX = -1, sectionY = -4, chunkZ = 2 } = {}) {
  return {
    key, chunkX, sectionY, chunkZ,
    palette: [{ stateId: 0, name: 'air', properties: {} }],
    indices: new Uint16Array(4096),
    blockLight: new Uint8Array(4096),
    skyLight: new Uint8Array(4096).fill(15),
    biomePalette: [{ id: 1, name: 'plains' }],
    biomeIndices: new Uint16Array(4096), nonAirBlocks: 0,
  };
}

function bootstrapStart(snapshot) {
  const { sections, ...metadata } = snapshot;
  return {
    sessionId: snapshot.sessionId,
    generation: snapshot.generation,
    sectionCount: sections.length,
    bootstrap: metadata,
  };
}

function bootstrapSection(snapshot, index) {
  return {
    sessionId: snapshot.sessionId,
    generation: snapshot.generation,
    index,
    section: snapshot.sections[index],
  };
}

function bootstrapEnd(snapshot) {
  return {
    sessionId: snapshot.sessionId,
    generation: snapshot.generation,
    sectionCount: snapshot.sections.length,
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

test('BUG-WEBUI-23-002 | 分段首帧收齐前不提交，收齐后原子提交并续接排队增量', () => {
  const snapshot = {
    ...bootstrap(),
    sections: [
      section(),
      section({ key: '0,-4,2', chunkX: 0 }),
      section({ key: '1,-4,2', chunkX: 1 }),
    ],
  };
  const store = new VisualWorldStore({ maxQueuedDeltaBatches: 4 });

  assert.equal(store.beginBootstrap(bootstrapStart(snapshot)), true);
  assert.equal(store.status, 'receiving-bootstrap');
  assert.equal(store.sections.size, 0);
  assert.equal(store.receiveBatch(batch(5, 5, [blockDelta(5)])), true);
  snapshot.sections.forEach((_, index) => {
    assert.equal(store.appendBootstrapSection(bootstrapSection(snapshot, index)), true);
    assert.equal(store.sections.size, 0);
  });

  assert.equal(store.commitBootstrap(bootstrapEnd(snapshot)), true);
  assert.equal(store.status, 'ready');
  assert.equal(store.sections.size, 3);
  assert.equal(store.sequence, 5);
  assert.equal(store.sections.get('-1,-4,2').palette[1].name, 'stone');
});

test('BUG-WEBUI-23-002 | 缺段和旧会话分段 fail-closed，不提交半帧', () => {
  const snapshot = {
    ...bootstrap(),
    sections: [section(), section({ key: '0,-4,2', chunkX: 0 })],
  };
  const incomplete = new VisualWorldStore({ maxQueuedDeltaBatches: 4 });
  incomplete.beginBootstrap(bootstrapStart(snapshot));
  incomplete.appendBootstrapSection(bootstrapSection(snapshot, 0));
  assert.equal(incomplete.commitBootstrap(bootstrapEnd(snapshot)), false);
  assert.equal(incomplete.resyncReason, 'incomplete_bootstrap');
  assert.equal(incomplete.sections.size, 0);

  const stale = new VisualWorldStore({ maxQueuedDeltaBatches: 4 });
  stale.beginBootstrap(bootstrapStart(snapshot));
  assert.equal(stale.appendBootstrapSection({
    ...bootstrapSection(snapshot, 0),
    sessionId: 'old-session',
  }), false);
  assert.equal(stale.resyncReason, 'bootstrap_session_mismatch');
  assert.equal(stale.sections.size, 0);

  const duplicate = new VisualWorldStore({ maxQueuedDeltaBatches: 4 });
  duplicate.beginBootstrap(bootstrapStart(snapshot));
  duplicate.appendBootstrapSection(bootstrapSection(snapshot, 0));
  assert.equal(duplicate.appendBootstrapSection(bootstrapSection(snapshot, 0)), false);
  assert.equal(duplicate.resyncReason, 'duplicate_bootstrap_section');

  const aborted = new VisualWorldStore({ maxQueuedDeltaBatches: 4 });
  aborted.beginBootstrap(bootstrapStart(snapshot));
  aborted.appendBootstrapSection(bootstrapSection(snapshot, 0));
  aborted.abortBootstrap('connection_lost');
  assert.equal(aborted.pendingBootstrap, null);
  assert.equal(aborted.status, 'needs-resync');
  assert.equal(aborted.resyncReason, 'connection_lost');
});

test('BUG-WEBUI-23-002 | 多 section 列更新也分段并在 end 时原子应用', () => {
  const store = new VisualWorldStore({ maxQueuedDeltaBatches: 4 });
  store.applyBootstrap(bootstrap());
  const sections = [
    section({ key: '0,-4,2', chunkX: 0 }),
    section({ key: '0,-3,2', chunkX: 0, sectionY: -3 }),
    section({ key: '0,-2,2', chunkX: 0, sectionY: -2 }),
  ];
  const wireBatch = {
    protocol: 'mineclaw.visual-world-delta/v1',
    sessionId: 's1',
    generation: 2,
    fromSequence: 5,
    toSequence: 5,
    deltas: [{
      kind: 'column_replace', sessionId: 's1', generation: 2, sequence: 5, timestamp: 5,
      chunkX: 0, chunkZ: 2, sections: [], sectionCount: sections.length,
    }],
    createdAt: Date.now(),
  };
  const identity = {
    sessionId: 's1', generation: 2, fromSequence: 5, toSequence: 5,
  };

  assert.equal(store.beginDeltaBatch({ ...identity, batch: wireBatch, sectionCount: sections.length }), true);
  sections.forEach((value, index) => {
    assert.equal(store.appendDeltaSection({
      ...identity, index, deltaIndex: 0, sectionIndex: index, section: value,
    }), true);
  });
  assert.equal(store.sections.has('0,-4,2'), false);
  assert.equal(store.commitDeltaBatch({ ...identity, sectionCount: sections.length }), true);
  assert.equal(store.sequence, 5);
  assert.equal(store.sections.has('0,-4,2'), true);
  assert.equal(store.sections.has('0,-3,2'), true);
  assert.equal(store.sections.has('0,-2,2'), true);
});

test('BUG-WEBUI-23-002 | 新加载空区段的首个方块增量建立稀疏 section 而不触发重建循环', () => {
  const store = new VisualWorldStore({ maxQueuedDeltaBatches: 4 });
  store.applyBootstrap({ ...bootstrap(), sections: [] });
  assert.equal(store.receiveBatch(batch(5, 5, [blockDelta(5)])), true);
  assert.equal(store.needsResync, false);
  assert.equal(store.sequence, 5);
  assert.equal(store.sections.get('-1,-4,2').palette[1].name, 'stone');
  assert.equal(store.sections.get('-1,-4,2').indices[0], 1);
  assert.equal(store.sections.get('-1,-4,2').nonAirBlocks, 1);
});
