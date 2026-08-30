import * as THREE from 'three';
import { ResourcePackClient } from './resourcePackClient.js';
import { AuthenticEntityRenderer } from './AuthenticEntityRenderer.js';
import { AuthenticEnvironmentRenderer } from './AuthenticEnvironmentRenderer.js';
import { classifyMaterialRenderLayer, materialRenderOptions } from './materialRenderLayer.js';

export class AuthenticWorldRenderer {
  constructor({ scene, config, onDiagnostic = () => {}, onProgress = () => {}, workerFactory, packClient } = {}) {
    this.scene = scene;
    this.config = config;
    this.onDiagnostic = onDiagnostic;
    this.onProgress = onProgress;
    this.packClient = packClient ?? new ResourcePackClient();
    this.workerFactory = workerFactory ?? (() => new Worker(new URL('./sectionMeshWorker.js', import.meta.url), { type: 'module' }));
    this.group = new THREE.Group();
    this.group.name = 'authenticWorld';
    this.group.visible = false;
    this.entityGroup = new THREE.Group();
    this.entityGroup.name = 'authenticEntities';
    this.group.add(this.entityGroup);
    this.entityRenderer = new AuthenticEntityRenderer({ group: this.entityGroup, config, onDiagnostic });
    this.environmentRenderer = new AuthenticEnvironmentRenderer({ scene, config });
    this.store = null;
    this.pack = null;
    this.sectionMeshes = new Map();
    this.materials = new Map();
    this.queue = [];
    this.queued = new Set();
    this.running = new Map();
    this.buildVersion = new Map();
    this.renderGeneration = 0;
    this.pendingWorkers = new Map();
    this.nextTaskId = 1;
    this.worker = null;
    this.active = false;
    this.lastTickAt = null;
    this.lastEnvironment = null;
    this.lastEnvironmentConfig = null;
    this.focusPosition = new THREE.Vector3();
    this.focusChunk = { chunkX: 0, chunkZ: 0 };
    this.lastWindowRadius = null;
    this.completedSections = new Set();
    this.failedSections = new Set();
    this.firstVisibleReady = false;
    this.lastProgressSignature = '';
  }

  mount() {
    this.scene.add(this.group);
  }

  setStore(store) {
    if (store === this.store) return;
    this.renderGeneration += 1;
    this.store = store;
    this.clearSections();
    this.queue.length = 0;
    this.queued.clear();
    this.resetProgress();
    if (store?.status === 'ready') {
      // putSection marks the initial bootstrap dirty. The renderer already queues
      // the complete snapshot here, so consume those initial flags once instead
      // of rebuilding every section twice on the first tick.
      store.takeDirtySections?.();
      this.enqueueAll(store.sections.keys());
    }
    this.emitProgress(true);
  }

  setPack(descriptor) {
    if (descriptor?.id === this.pack?.id) return;
    this.renderGeneration += 1;
    this.pack = descriptor;
    this.packClient.select(descriptor);
    this.clearSections();
    this.queue.length = 0;
    this.queued.clear();
    this.resetProgress();
    if (this.store?.status === 'ready') this.enqueueAll(this.store.sections.keys());
    this.emitProgress(true);
  }

  setFocusPosition(position) {
    if (!position || ![position.x, position.y, position.z].every(Number.isFinite)) return;
    const nextChunk = { chunkX: Math.floor(position.x / 16), chunkZ: Math.floor(position.z / 16) };
    const chunkChanged = nextChunk.chunkX !== this.focusChunk.chunkX || nextChunk.chunkZ !== this.focusChunk.chunkZ;
    this.focusPosition.set(position.x, position.y, position.z);
    this.focusChunk = nextChunk;
    if (chunkChanged) this.reconcileWindow();
  }

  async activate() {
    if (!this.store || this.store.status !== 'ready') throw new Error('真实世界数据尚未就绪');
    await this.packClient.verifySelected(this.store.gameVersion);
    this.active = true;
    const first = nearestSectionKey(this.store.sections, this.focusPosition, key => this.isWithinWindow(key));
    if (first && !this.sectionMeshes.has(first)) await this.buildSection(first);
    this.entityRenderer.sync(this.store.entities, this.store.center);
    this.environmentRenderer.activate(this.store.environment, this.store.center);
    this.lastEnvironment = this.store.environment;
    this.lastEnvironmentConfig = environmentConfigSignature(this.config);
    this.lastTickAt = performance.now();
    this.group.visible = true;
  }

  deactivate() {
    this.active = false;
    this.group.visible = false;
    this.environmentRenderer.deactivate();
    this.lastEnvironment = null;
    this.lastEnvironmentConfig = null;
    this.lastTickAt = null;
  }

  update({ store, pack } = {}) {
    if (store) this.setStore(store);
    if (pack) this.setPack(pack);
  }

  tick() {
    if (!this.active || !this.store) return;
    if (this.lastWindowRadius !== this.windowRadius()) this.reconcileWindow();
    const now = performance.now();
    const deltaSeconds = Math.min(0.1, Math.max(0, (now - (this.lastTickAt ?? now)) / 1000));
    this.lastTickAt = now;
    this.entityRenderer.sync(this.store.entities, this.store.center);
    this.entityRenderer.tick(deltaSeconds);
    const environmentConfig = environmentConfigSignature(this.config);
    if (this.store.environment !== this.lastEnvironment || environmentConfig !== this.lastEnvironmentConfig) {
      this.environmentRenderer.update(this.store.environment, this.store.center);
      this.lastEnvironment = this.store.environment;
      this.lastEnvironmentConfig = environmentConfig;
    }
    this.environmentRenderer.tick(deltaSeconds);
    for (const key of this.store.takeRemovedSections?.() ?? []) {
      this.completedSections.delete(key);
      this.failedSections.delete(key);
      this.removeSection(key);
    }
    for (const key of this.store.takeDirtySections?.() ?? []) {
      this.completedSections.delete(key);
      this.failedSections.delete(key);
      this.enqueue(key, true);
    }
    this.evictFarSections();
    const startedAt = performance.now();
    let started = 0;
    while (this.queue.length && started < this.config.maxSectionBuildsPerFrame
      && this.currentRunningCount() < this.maxPendingBuilds()
      && performance.now() - startedAt < this.config.sectionBuildBudgetMs) {
      const key = this.queue.shift();
      this.queued.delete(key);
      if (this.running.get(key) === this.renderGeneration || !this.store.sections.has(key)) continue;
      started += 1;
      void this.buildSection(key).catch(error => this.onDiagnostic({ type: 'section-build-failed', key, message: error.message }));
    }
    this.emitProgress();
  }

  enqueueAll(keys) {
    for (const key of Array.from(keys).sort((left, right) => sectionDistance(left, this.focusPosition) - sectionDistance(right, this.focusPosition))) {
      this.enqueue(key);
    }
  }

  enqueue(key, force = false) {
    if (!key || !this.isWithinWindow(key) || this.queued.has(key) || this.running.get(key) === this.renderGeneration) return;
    if (!force && (this.sectionMeshes.has(key) || this.completedSections.has(key))) return;
    this.queued.add(key);
    this.queue.push(key);
  }

  async buildSection(key) {
    const section = this.store?.sections.get(key);
    if (!section || !this.isWithinWindow(key)) return;
    const renderGeneration = this.renderGeneration;
    this.running.set(key, renderGeneration);
    const version = (this.buildVersion.get(key) ?? 0) + 1;
    this.buildVersion.set(key, version);
    try {
      const resolved = await Promise.all(section.palette.map(state => this.packClient.resolvePaletteState(state)));
      for (const item of resolved) for (const message of item.missing ?? []) {
        this.onDiagnostic({ type: 'missing-model', key, message });
      }
      for (const item of resolved) for (const diagnostic of item.diagnostics ?? []) {
        this.onDiagnostic({ ...diagnostic, key });
      }
      const tintData = this.packClient.getTintData ? await this.packClient.getTintData() : {};
      const result = await this.runWorker({
        section,
        paletteModels: resolved.map(item => item.models),
        tintData,
      });
      if (this.renderGeneration !== renderGeneration || this.buildVersion.get(key) !== version
        || !this.store?.sections.has(key) || !this.isWithinWindow(key)) return;
      await this.applySectionResult(key, result);
      this.failedSections.delete(key);
      this.completedSections.add(key);
      if (!this.firstVisibleReady && result.meshes.length > 0) this.firstVisibleReady = true;
      this.emitProgress(true);
    } catch (error) {
      if (this.renderGeneration === renderGeneration && this.store?.sections.has(key) && this.isWithinWindow(key)) {
        this.failedSections.add(key);
        this.emitProgress(true);
      }
      throw error;
    } finally {
      if (this.running.get(key) === renderGeneration) this.running.delete(key);
      if (this.renderGeneration !== renderGeneration || this.store?.dirtySections?.has(key)) this.enqueue(key);
      this.emitProgress();
    }
  }

  async runWorker(payload) {
    this.ensureWorker();
    const taskId = this.nextTaskId++;
    return new Promise((resolve, reject) => {
      this.pendingWorkers.set(taskId, { resolve, reject });
      this.worker.postMessage({ taskId, payload });
    });
  }

  ensureWorker() {
    if (this.worker) return;
    this.worker = this.workerFactory();
    this.worker.onmessage = event => {
      const pending = this.pendingWorkers.get(event.data.taskId);
      if (!pending) return;
      this.pendingWorkers.delete(event.data.taskId);
      pending.resolve(event.data.result);
    };
    this.worker.onerror = event => {
      const error = new Error(event.message || 'section mesh worker failed');
      for (const pending of this.pendingWorkers.values()) pending.reject(error);
      this.pendingWorkers.clear();
    };
  }

  async applySectionResult(key, result) {
    const group = new THREE.Group();
    group.name = `section:${key}`;
    for (const payload of result.meshes) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(payload.positions, 3));
      geometry.setAttribute('normal', new THREE.BufferAttribute(payload.normals, 3));
      geometry.setAttribute('color', new THREE.BufferAttribute(payload.colors ?? whiteColors(payload.positions.length / 3), 3));
      geometry.setAttribute('uv', new THREE.BufferAttribute(payload.uvs, 2));
      geometry.setIndex(new THREE.BufferAttribute(payload.indices, 1));
      geometry.computeBoundingSphere();
      const material = await this.getMaterial(payload.materialKey);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.renderOrder = material.transparent ? 2 : 0;
      group.add(mesh);
    }
    this.removeSection(key);
    this.sectionMeshes.set(key, group);
    this.group.add(group);
  }

  async getMaterial(materialKey) {
    if (this.materials.has(materialKey)) return this.materials.get(materialKey);
    const promise = materialKey === 'mineclaw:missing'
      ? Promise.resolve(new THREE.MeshLambertMaterial({ map: missingTexture(), side: THREE.DoubleSide, vertexColors: true }))
      : loadTexture(this.packClient.textureUrl(materialKey)).then(texture => {
        const layer = classifyMaterialRenderLayer(materialKey);
        const options = materialRenderOptions(layer);
        return new THREE.MeshLambertMaterial({
          map: texture,
          transparent: options.transparent,
          opacity: options.opacity,
          alphaTest: options.alphaTest,
          depthWrite: options.depthWrite,
          side: options.doubleSided ? THREE.DoubleSide : THREE.FrontSide,
          vertexColors: true,
        });
      }).catch(error => {
        this.onDiagnostic({ type: 'missing-texture', materialKey, message: error?.message ?? String(error) });
        return new THREE.MeshLambertMaterial({ map: missingTexture(), side: THREE.DoubleSide, vertexColors: true });
      });
    this.materials.set(materialKey, promise);
    return promise;
  }

  evictFarSections() {
    const limit = this.config.maxResidentSections;
    if (this.sectionMeshes.size <= limit) return;
    const ordered = Array.from(this.sectionMeshes.keys()).sort((left, right) => sectionDistance(right, this.focusPosition) - sectionDistance(left, this.focusPosition));
    for (const key of ordered.slice(0, this.sectionMeshes.size - limit)) this.removeSection(key);
  }

  removeSection(key) {
    const group = this.sectionMeshes.get(key);
    if (!group) return;
    this.group.remove(group);
    group.traverse(object => object.geometry?.dispose?.());
    this.sectionMeshes.delete(key);
  }

  clearSections() {
    for (const key of Array.from(this.sectionMeshes.keys())) this.removeSection(key);
  }

  reconcileWindow() {
    const radius = this.windowRadius();
    this.lastWindowRadius = radius;
    if (!this.store) return;
    this.queue = this.queue.filter(key => this.isWithinWindow(key));
    this.queued = new Set(this.queue);
    for (const key of this.sectionMeshes.keys()) {
      if (!this.isWithinWindow(key)) this.removeSection(key);
    }
    for (const key of this.completedSections) {
      if (!this.isWithinWindow(key)) this.completedSections.delete(key);
    }
    for (const key of this.failedSections) {
      if (!this.isWithinWindow(key)) this.failedSections.delete(key);
    }
    this.enqueueAll(this.store.sections.keys());
    this.queue.sort((left, right) => sectionDistance(left, this.focusPosition) - sectionDistance(right, this.focusPosition));
    this.firstVisibleReady = Array.from(this.sectionMeshes.entries())
      .some(([key, group]) => this.isWithinWindow(key) && group.children.length > 0);
    this.emitProgress(true);
  }

  isWithinWindow(key) {
    const [chunkX, , chunkZ] = key.split(',').map(Number);
    const radius = this.windowRadius();
    return Math.abs(chunkX - this.focusChunk.chunkX) <= radius
      && Math.abs(chunkZ - this.focusChunk.chunkZ) <= radius;
  }

  windowRadius() {
    const configured = Number(this.config?.viewDistanceChunks ?? this.store?.viewDistanceChunks ?? 3);
    return Math.max(1, Math.floor(Number.isFinite(configured) ? configured : 3));
  }

  maxPendingBuilds() {
    const configured = Number(this.config?.maxPendingSectionBuilds ?? 4);
    return Math.max(1, Math.floor(Number.isFinite(configured) ? configured : 4));
  }

  currentRunningCount() {
    const currentGeneration = this.renderGeneration;
    return Array.from(this.running.values()).filter(generation => generation === currentGeneration).length;
  }

  resetProgress() {
    this.completedSections.clear();
    this.failedSections.clear();
    this.firstVisibleReady = false;
    this.lastProgressSignature = '';
  }

  progressSnapshot() {
    const eligibleKeys = this.store?.sections ? Array.from(this.store.sections.keys()).filter(key => this.isWithinWindow(key)) : [];
    const runningSections = Array.from(this.running.entries())
      .filter(([key, generation]) => generation === this.renderGeneration && this.isWithinWindow(key)).length;
    return {
      sessionId: this.store?.sessionId ?? null,
      generation: this.store?.generation ?? null,
      totalSections: eligibleKeys.length,
      queuedSections: this.queue.length,
      runningSections,
      completedSections: Array.from(this.completedSections).filter(key => this.isWithinWindow(key)).length,
      failedSections: Array.from(this.failedSections).filter(key => this.isWithinWindow(key)).length,
      firstVisibleReady: this.firstVisibleReady,
    };
  }

  emitProgress(force = false) {
    const progress = this.progressSnapshot();
    const signature = JSON.stringify(progress);
    if (!force && signature === this.lastProgressSignature) return;
    this.lastProgressSignature = signature;
    this.onProgress(progress);
  }

  dispose() {
    this.active = false;
    this.environmentRenderer.dispose();
    this.entityRenderer.dispose();
    this.clearSections();
    this.scene.remove(this.group);
    this.worker?.terminate();
    this.worker = null;
    for (const pending of this.pendingWorkers.values()) pending.reject(new Error('renderer disposed'));
    this.pendingWorkers.clear();
    for (const promise of this.materials.values()) void promise.then(material => {
      material.map?.dispose?.();
      material.dispose();
    });
    this.materials.clear();
  }
}

function nearestSectionKey(sections, center, predicate = () => true) {
  return Array.from(sections.keys()).filter(predicate)
    .sort((left, right) => sectionDistance(left, center) - sectionDistance(right, center))[0] ?? null;
}

function sectionDistance(key, center = { x: 0, y: 0, z: 0 }) {
  const [chunkX, sectionY, chunkZ] = key.split(',').map(Number);
  const centerChunkX = Number.isFinite(center.x) ? Math.floor(center.x / 16) : Number(center.chunkX ?? 0);
  const centerSectionY = Number.isFinite(center.y) ? Math.floor(center.y / 16) : Number(center.sectionY ?? 0);
  const centerChunkZ = Number.isFinite(center.z) ? Math.floor(center.z / 16) : Number(center.chunkZ ?? 0);
  return (chunkX - centerChunkX) ** 2 + (chunkZ - centerChunkZ) ** 2 + (sectionY - centerSectionY) ** 2;
}

function environmentConfigSignature(config) {
  return JSON.stringify([
    config.weatherParticleCount, config.weatherRadius, config.weatherFallSpeed,
    config.fogDensity, config.rainFogMultiplier, config.ambientFillLightIntensity,
  ]);
}

function loadTexture(url) {
  return new Promise((resolve, reject) => {
    new THREE.TextureLoader().load(url, texture => {
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.magFilter = THREE.NearestFilter;
      texture.minFilter = THREE.NearestMipmapNearestFilter;
      texture.wrapS = THREE.RepeatWrapping;
      texture.wrapT = THREE.RepeatWrapping;
      resolve(texture);
    }, undefined, reject);
  });
}

function whiteColors(vertexCount) {
  const colors = new Float32Array(vertexCount * 3);
  colors.fill(1);
  return colors;
}

let sharedMissingTexture = null;
function missingTexture() {
  if (sharedMissingTexture) return sharedMissingTexture;
  const data = new Uint8Array([
    255, 0, 255, 255, 0, 0, 0, 255,
    0, 0, 0, 255, 255, 0, 255, 255,
  ]);
  sharedMissingTexture = new THREE.DataTexture(data, 2, 2, THREE.RGBAFormat);
  sharedMissingTexture.magFilter = THREE.NearestFilter;
  sharedMissingTexture.needsUpdate = true;
  return sharedMissingTexture;
}
