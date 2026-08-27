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
    this.environment = null;
    this.serverResourcePack = null;
    this.sections = new Map();
    this.entities = new Map();
    this.queuedBatches = [];
    this.needsResync = false;
    this.resyncReason = null;
  }

  applyBootstrap(bootstrap) {
    if (bootstrap?.protocol !== 'mineclaw.visual-world/v1' || typeof bootstrap.sessionId !== 'string') {
      this.markResync('invalid_bootstrap');
      return false;
    }
    const queued = this.queuedBatches;
    this.status = 'ready';
    this.sessionId = bootstrap.sessionId;
    this.generation = bootstrap.generation;
    this.sequence = bootstrap.sequence;
    this.gameVersion = bootstrap.gameVersion;
    this.center = bootstrap.center;
    this.environment = bootstrap.environment;
    this.serverResourcePack = bootstrap.serverResourcePack ?? null;
    this.sections = new Map();
    this.entities = new Map((bootstrap.entities ?? []).map(entity => [entity.id, entity]));
    this.queuedBatches = [];
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
    const section = this.sections.get(sectionKey(chunkX, sectionY, chunkZ));
    if (!section) {
      this.markResync('missing_section_for_block');
      return;
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
    section.indices[index] = paletteIndex;
    section.blockLight[index] = delta.blockLight;
    section.skyLight[index] = delta.skyLight;
  }

  removeColumn(chunkX, chunkZ) {
    for (const [key, section] of this.sections) {
      if (section.chunkX === chunkX && section.chunkZ === chunkZ) this.sections.delete(key);
    }
  }

  markResync(reason) {
    this.needsResync = true;
    this.resyncReason = reason;
    this.status = 'needs-resync';
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
