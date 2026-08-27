import * as THREE from 'three';
import { ResourcePackClient } from './resourcePackClient.js';

export class AuthenticWorldRenderer {
  constructor({ scene, config, onDiagnostic = () => {}, workerFactory, packClient } = {}) {
    this.scene = scene;
    this.config = config;
    this.onDiagnostic = onDiagnostic;
    this.packClient = packClient ?? new ResourcePackClient();
    this.workerFactory = workerFactory ?? (() => new Worker(new URL('./sectionMeshWorker.js', import.meta.url), { type: 'module' }));
    this.group = new THREE.Group();
    this.group.name = 'authenticWorld';
    this.group.visible = false;
    this.store = null;
    this.pack = null;
    this.sectionMeshes = new Map();
    this.materials = new Map();
    this.queue = [];
    this.queued = new Set();
    this.running = new Set();
    this.buildVersion = new Map();
    this.pendingWorkers = new Map();
    this.nextTaskId = 1;
    this.worker = null;
    this.active = false;
  }

  mount() {
    this.scene.add(this.group);
  }

  setStore(store) {
    if (store === this.store) return;
    this.store = store;
    this.clearSections();
    this.queue.length = 0;
    this.queued.clear();
    if (store?.status === 'ready') for (const key of store.sections.keys()) this.enqueue(key);
  }

  setPack(descriptor) {
    if (descriptor?.id === this.pack?.id) return;
    this.pack = descriptor;
    this.packClient.select(descriptor);
    this.clearSections();
    this.queue.length = 0;
    this.queued.clear();
    if (this.store?.status === 'ready') for (const key of this.store.sections.keys()) this.enqueue(key);
  }

  async activate() {
    if (!this.store || this.store.status !== 'ready') throw new Error('真实世界数据尚未就绪');
    await this.packClient.verifySelected(this.store.gameVersion);
    this.active = true;
    const first = nearestSectionKey(this.store.sections, this.store.center);
    if (first && !this.sectionMeshes.has(first)) await this.buildSection(first);
    this.group.visible = true;
  }

  deactivate() {
    this.active = false;
    this.group.visible = false;
  }

  update({ store, pack } = {}) {
    if (store) this.setStore(store);
    if (pack) this.setPack(pack);
  }

  tick() {
    if (!this.active || !this.store) return;
    for (const key of this.store.takeRemovedSections?.() ?? []) this.removeSection(key);
    for (const key of this.store.takeDirtySections?.() ?? []) this.enqueue(key);
    this.evictFarSections();
    const startedAt = performance.now();
    let started = 0;
    while (this.queue.length && started < this.config.maxSectionBuildsPerFrame
      && performance.now() - startedAt < this.config.sectionBuildBudgetMs) {
      const key = this.queue.shift();
      this.queued.delete(key);
      if (this.running.has(key) || !this.store.sections.has(key)) continue;
      started += 1;
      void this.buildSection(key).catch(error => this.onDiagnostic({ type: 'section-build-failed', key, message: error.message }));
    }
  }

  enqueue(key) {
    if (!key || this.queued.has(key) || this.running.has(key)) return;
    this.queued.add(key);
    this.queue.push(key);
  }

  async buildSection(key) {
    const section = this.store?.sections.get(key);
    if (!section) return;
    this.running.add(key);
    const version = (this.buildVersion.get(key) ?? 0) + 1;
    this.buildVersion.set(key, version);
    try {
      const resolved = await Promise.all(section.palette.map(state => this.packClient.resolvePaletteState(state)));
      for (const item of resolved) for (const message of item.missing ?? []) {
        this.onDiagnostic({ type: 'missing-model', key, message });
      }
      const result = await this.runWorker({
        section,
        paletteModels: resolved.map(item => item.models),
      });
      if (this.buildVersion.get(key) !== version || !this.store?.sections.has(key)) return;
      await this.applySectionResult(key, result);
    } finally {
      this.running.delete(key);
      if (this.store?.dirtySections?.has(key)) this.enqueue(key);
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
      ? Promise.resolve(new THREE.MeshLambertMaterial({ map: missingTexture(), side: THREE.DoubleSide }))
      : loadTexture(this.packClient.textureUrl(materialKey)).then(texture => {
        const transparent = /(glass|water|lava|leaves|ice|portal|slime|honey|web)/i.test(materialKey);
        return new THREE.MeshLambertMaterial({
          map: texture,
          transparent,
          opacity: transparent ? 0.82 : 1,
          alphaTest: /leaves|web/i.test(materialKey) ? 0.1 : 0,
          depthWrite: !transparent,
          side: transparent ? THREE.DoubleSide : THREE.FrontSide,
        });
      }).catch(() => new THREE.MeshLambertMaterial({ map: missingTexture(), side: THREE.DoubleSide }));
    this.materials.set(materialKey, promise);
    return promise;
  }

  evictFarSections() {
    const limit = this.config.maxResidentSections;
    if (this.sectionMeshes.size <= limit) return;
    const center = this.store?.center ?? { chunkX: 0, chunkZ: 0 };
    const ordered = Array.from(this.sectionMeshes.keys()).sort((left, right) => sectionDistance(right, center) - sectionDistance(left, center));
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

  dispose() {
    this.active = false;
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

function nearestSectionKey(sections, center) {
  return Array.from(sections.keys()).sort((left, right) => sectionDistance(left, center) - sectionDistance(right, center))[0] ?? null;
}

function sectionDistance(key, center = { chunkX: 0, chunkZ: 0 }) {
  const [chunkX, sectionY, chunkZ] = key.split(',').map(Number);
  return (chunkX - center.chunkX) ** 2 + (chunkZ - center.chunkZ) ** 2 + sectionY ** 2 * 0.01;
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
