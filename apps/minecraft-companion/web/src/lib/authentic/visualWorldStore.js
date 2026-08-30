function sectionKey(chunkX, sectionY, chunkZ) {
  return `${chunkX},${sectionY},${chunkZ}`;
}

export class VisualWorldStore {
  constructor({ maxQueuedDeltaBatches }) {
    if (!Number.isInteger(maxQueuedDeltaBatches) || maxQueuedDeltaBatches < 1) {
      throw new Error('maxQueuedDeltaBatches must be a positive integer');
    }
    this.maxQueuedDeltaBatches = maxQueuedDeltaBatches;
    this.reset();
  }

  reset() {
    this.status = 'awaiting-bootstrap';
    this.sessionId = null;
    this.generation = 0;
    this.sequence = 0;
    this.gameVersion = null;
    this.center = null;
    this.viewDistanceChunks = null;
    this.environment = null;
    this.serverResourcePack = null;
    this.pendingBootstrap = null;
    this.pendingDeltaBatch = null;
    this.sections = new Map();
    this.entities = new Map();
    this.dirtySections = new Set();
    this.removedSections = new Set();
    this.queuedBatches = [];
    this.needsResync = false;
    this.resyncReason = null;
  }

  applyBootstrap(bootstrap) {
    if (bootstrap?.protocol !== 'mineclaw.visual-world/v1'
      || typeof bootstrap.sessionId !== 'string'
      || !Number.isInteger(bootstrap.generation)
      || !Array.isArray(bootstrap.sections)) {
      this.markResync('invalid_bootstrap');
      return false;
    }
    const queued = this.queuedBatches;
    this.pendingBootstrap = null;
    this.status = 'ready';
    this.sessionId = bootstrap.sessionId;
    this.generation = bootstrap.generation;
    this.sequence = bootstrap.sequence;
    this.gameVersion = bootstrap.gameVersion;
    this.center = bootstrap.center;
    this.viewDistanceChunks = bootstrap.viewDistanceChunks;
    this.environment = bootstrap.environment;
    this.serverResourcePack = bootstrap.serverResourcePack ?? null;
    this.sections = new Map();
    this.entities = new Map((bootstrap.entities ?? []).map(entity => [entity.id, entity]));
    this.queuedBatches = [];
    this.dirtySections = new Set();
    this.removedSections = new Set();
    this.needsResync = false;
    this.resyncReason = null;
    for (const section of bootstrap.sections ?? []) this.putSection(section);
    for (const batch of queued
      .filter(item => item.sessionId === this.sessionId && item.toSequence > this.sequence)
      .sort((left, right) => left.fromSequence - right.fromSequence)) {
      if (!this.applyBatch(batch)) break;
    }
    return !this.needsResync;
  }

  beginBootstrap(message) {
    const bootstrap = message?.bootstrap;
    const sectionCount = message?.sectionCount;
    if (bootstrap?.protocol !== 'mineclaw.visual-world/v1'
      || typeof bootstrap.sessionId !== 'string'
      || !Number.isInteger(bootstrap.generation)
      || bootstrap.sessionId !== message?.sessionId
      || bootstrap.generation !== message?.generation
      || !Number.isInteger(sectionCount)
      || sectionCount < 0) {
      this.markResync('invalid_bootstrap_start');
      return false;
    }
    this.pendingBootstrap = {
      bootstrap,
      sessionId: message.sessionId,
      generation: message.generation,
      sectionCount,
      sections: new Map(),
    };
    this.status = 'receiving-bootstrap';
    this.needsResync = false;
    this.resyncReason = null;
    return true;
  }

  appendBootstrapSection(message) {
    const pending = this.pendingBootstrap;
    if (!pending) {
      this.markResync('bootstrap_not_started');
      return false;
    }
    if (message?.sessionId !== pending.sessionId || message?.generation !== pending.generation) {
      this.markResync('bootstrap_session_mismatch');
      return false;
    }
    if (!Number.isInteger(message?.index)
      || message.index < 0
      || message.index >= pending.sectionCount
      || !message.section) {
      this.markResync('invalid_bootstrap_section');
      return false;
    }
    if (pending.sections.has(message.index)) {
      this.markResync('duplicate_bootstrap_section');
      return false;
    }
    pending.sections.set(message.index, message.section);
    return true;
  }

  commitBootstrap(message) {
    const pending = this.pendingBootstrap;
    if (!pending) {
      this.markResync('bootstrap_not_started');
      return false;
    }
    if (message?.sessionId !== pending.sessionId || message?.generation !== pending.generation) {
      this.markResync('bootstrap_session_mismatch');
      return false;
    }
    if (message?.sectionCount !== pending.sectionCount || pending.sections.size !== pending.sectionCount) {
      this.markResync('incomplete_bootstrap');
      return false;
    }
    const sections = [];
    for (let index = 0; index < pending.sectionCount; index += 1) {
      const section = pending.sections.get(index);
      if (!section) {
        this.markResync('incomplete_bootstrap');
        return false;
      }
      sections.push(section);
    }
    return this.applyBootstrap({ ...pending.bootstrap, sections });
  }

  abortBootstrap(reason = 'bootstrap_aborted') {
    this.markResync(reason);
  }

  beginDeltaBatch(message) {
    const batch = message?.batch;
    const sectionCount = message?.sectionCount;
    if (batch?.protocol !== 'mineclaw.visual-world-delta/v1'
      || typeof batch.sessionId !== 'string'
      || !Number.isInteger(batch.generation)
      || batch.sessionId !== message?.sessionId
      || batch.generation !== message?.generation
      || batch.fromSequence !== message?.fromSequence
      || batch.toSequence !== message?.toSequence
      || !Number.isInteger(sectionCount)
      || sectionCount < 1
      || !Array.isArray(batch.deltas)) {
      this.markResync('invalid_delta_start');
      return false;
    }
    const expectedSections = batch.deltas.reduce((count, delta) => count
      + (delta.kind === 'column_replace' && Number.isInteger(delta.sectionCount) ? delta.sectionCount : 0), 0);
    if (expectedSections !== sectionCount) {
      this.markResync('invalid_delta_start');
      return false;
    }
    this.pendingDeltaBatch = {
      batch,
      sessionId: message.sessionId,
      generation: message.generation,
      fromSequence: message.fromSequence,
      toSequence: message.toSequence,
      sectionCount,
      sections: new Map(),
    };
    return true;
  }

  appendDeltaSection(message) {
    const pending = this.pendingDeltaBatch;
    if (!pending) {
      this.markResync('delta_not_started');
      return false;
    }
    if (!matchesDeltaIdentity(message, pending)) {
      this.markResync('delta_session_mismatch');
      return false;
    }
    const delta = pending.batch.deltas[message?.deltaIndex];
    if (!Number.isInteger(message?.index)
      || message.index < 0
      || message.index >= pending.sectionCount
      || !Number.isInteger(message?.deltaIndex)
      || !Number.isInteger(message?.sectionIndex)
      || delta?.kind !== 'column_replace'
      || message.sectionIndex < 0
      || message.sectionIndex >= delta.sectionCount
      || !message.section
      || pending.sections.has(message.index)) {
      this.markResync('invalid_delta_section');
      return false;
    }
    pending.sections.set(message.index, {
      deltaIndex: message.deltaIndex,
      sectionIndex: message.sectionIndex,
      section: message.section,
    });
    return true;
  }

  commitDeltaBatch(message) {
    const pending = this.pendingDeltaBatch;
    if (!pending) {
      this.markResync('delta_not_started');
      return false;
    }
    if (!matchesDeltaIdentity(message, pending)
      || message?.sectionCount !== pending.sectionCount
      || pending.sections.size !== pending.sectionCount) {
      this.markResync('incomplete_delta_batch');
      return false;
    }
    const deltas = pending.batch.deltas.map(delta => delta.kind === 'column_replace'
      ? { ...delta, sections: Array.from({ length: delta.sectionCount }, () => null) }
      : delta);
    for (let index = 0; index < pending.sectionCount; index += 1) {
      const fragment = pending.sections.get(index);
      const delta = fragment && deltas[fragment.deltaIndex];
      if (!fragment || delta?.kind !== 'column_replace') {
        this.markResync('incomplete_delta_batch');
        return false;
      }
      delta.sections[fragment.sectionIndex] = fragment.section;
    }
    if (deltas.some(delta => delta.kind === 'column_replace' && delta.sections.some(section => !section))) {
      this.markResync('incomplete_delta_batch');
      return false;
    }
    const batch = { ...pending.batch, deltas };
    this.pendingDeltaBatch = null;
    return this.receiveBatch(batch);
  }

  receiveBatch(batch) {
    if (batch?.protocol !== 'mineclaw.visual-world-delta/v1') {
      this.markResync('invalid_delta_batch');
      return false;
    }
    if (this.status !== 'ready') {
      this.queuedBatches.push(batch);
      if (this.queuedBatches.length > this.maxQueuedDeltaBatches) {
        this.queuedBatches.shift();
        this.markResync('bootstrap_queue_overflow');
      }
      return !this.needsResync;
    }
    return this.applyBatch(batch);
  }

  applyBatch(batch) {
    if (batch.sessionId !== this.sessionId || batch.generation !== this.generation) {
      this.markResync('session_changed');
      return false;
    }
    if (batch.toSequence <= this.sequence) return true;
    if (batch.fromSequence > this.sequence + 1) {
      this.markResync('sequence_gap');
      return false;
    }
    const deltas = [...(batch.deltas ?? [])].sort((left, right) => left.sequence - right.sequence);
    for (const delta of deltas) {
      if (delta.sessionId !== this.sessionId || delta.generation !== this.generation) {
        this.markResync('delta_session_mismatch');
        return false;
      }
      if (delta.sequence > this.sequence) this.applyDelta(delta);
      if (this.needsResync) return false;
    }
    this.sequence = Math.max(this.sequence, batch.toSequence);
    return true;
  }

  putSection(section) {
    const normalized = {
      ...section,
      indices: toUint16Array(section.indices),
      blockLight: toUint8Array(section.blockLight),
      skyLight: toUint8Array(section.skyLight),
      biomeIndices: toUint16Array(section.biomeIndices),
    };
    this.sections.set(section.key ?? sectionKey(section.chunkX, section.sectionY, section.chunkZ), normalized);
    this.dirtySections.add(normalized.key ?? sectionKey(normalized.chunkX, normalized.sectionY, normalized.chunkZ));
  }

  applyDelta(delta) {
    switch (delta.kind) {
      case 'block': this.applyBlock(delta); break;
      case 'column_replace':
        this.removeColumn(delta.chunkX, delta.chunkZ);
        for (const section of delta.sections ?? []) this.putSection(section);
        break;
      case 'column_unload': this.removeColumn(delta.chunkX, delta.chunkZ); break;
      case 'entity_upsert': this.entities.set(delta.entity.id, delta.entity); break;
      case 'entity_remove': this.entities.delete(delta.entityId); break;
      case 'environment': this.environment = delta.environment; break;
      case 'resource_pack': this.serverResourcePack = delta.offer; break;
      case 'reset': this.markResync(delta.reason); break;
    }
    this.sequence = Math.max(this.sequence, delta.sequence);
  }

  applyBlock(delta) {
    const chunkX = Math.floor(delta.position.x / 16);
    const chunkZ = Math.floor(delta.position.z / 16);
    const sectionY = Math.floor(delta.position.y / 16);
    const key = sectionKey(chunkX, sectionY, chunkZ);
    let section = this.sections.get(key);
    if (!section) {
      if (isAirState(delta.state)) return;
      this.putSection(emptySectionForDelta(key, chunkX, sectionY, chunkZ, delta));
      section = this.sections.get(key);
    }
    let paletteIndex = section.palette.findIndex(state => state.stateId === delta.state.stateId
      && shallowEqual(state.properties, delta.state.properties));
    if (paletteIndex < 0) {
      paletteIndex = section.palette.length;
      section.palette.push(delta.state);
    }
    const x = positiveModulo(delta.position.x, 16);
    const y = positiveModulo(delta.position.y, 16);
    const z = positiveModulo(delta.position.z, 16);
    const index = (y * 16 + z) * 16 + x;
    const wasAir = isAirState(section.palette[section.indices[index]]);
    const becomesAir = isAirState(delta.state);
    section.indices[index] = paletteIndex;
    section.blockLight[index] = delta.blockLight;
    section.skyLight[index] = delta.skyLight;
    if (wasAir !== becomesAir) section.nonAirBlocks += becomesAir ? -1 : 1;
    this.dirtySections.add(section.key);
  }

  removeColumn(chunkX, chunkZ) {
    for (const [key, section] of this.sections) {
      if (section.chunkX === chunkX && section.chunkZ === chunkZ) {
        this.sections.delete(key);
        this.dirtySections.delete(key);
        this.removedSections.add(key);
      }
    }
  }

  markResync(reason) {
    for (const key of this.sections.keys()) this.removedSections.add(key);
    this.sections.clear();
    this.entities.clear();
    this.dirtySections.clear();
    this.pendingBootstrap = null;
    this.pendingDeltaBatch = null;
    this.queuedBatches = [];
    this.needsResync = true;
    this.resyncReason = reason;
    this.status = 'needs-resync';
  }

  takeDirtySections() {
    const dirty = Array.from(this.dirtySections);
    this.dirtySections.clear();
    return dirty;
  }

  takeRemovedSections() {
    const removed = Array.from(this.removedSections);
    this.removedSections.clear();
    return removed;
  }
}

function toUint16Array(value) {
  if (value instanceof Uint16Array) return value.slice();
  const bytes = toUint8Array(value);
  return new Uint16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2)).slice();
}

function toUint8Array(value) {
  if (value instanceof Uint8Array) return value.slice();
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
  if (value?.type === 'Buffer' && Array.isArray(value.data)) return Uint8Array.from(value.data);
  if (Array.isArray(value)) return Uint8Array.from(value);
  return new Uint8Array();
}

function positiveModulo(value, divisor) {
  return ((Math.floor(value) % divisor) + divisor) % divisor;
}

function shallowEqual(left, right) {
  const leftEntries = Object.entries(left ?? {});
  const rightEntries = Object.entries(right ?? {});
  return leftEntries.length === rightEntries.length
    && leftEntries.every(([key, value]) => String(right?.[key]) === String(value));
}

function matchesDeltaIdentity(message, pending) {
  return message?.sessionId === pending.sessionId
    && message?.generation === pending.generation
    && message?.fromSequence === pending.fromSequence
    && message?.toSequence === pending.toSequence;
}

function emptySectionForDelta(key, chunkX, sectionY, chunkZ, delta) {
  return {
    key,
    chunkX,
    sectionY,
    chunkZ,
    palette: [{ stateId: 0, name: 'air', properties: {} }],
    indices: new Uint16Array(4096),
    blockLight: new Uint8Array(4096),
    skyLight: new Uint8Array(4096),
    biomePalette: [delta.biome],
    biomeIndices: new Uint16Array(4096),
    nonAirBlocks: 0,
  };
}

function isAirState(state) {
  return state?.name === 'air' || state?.name === 'cave_air' || state?.name === 'void_air';
}
