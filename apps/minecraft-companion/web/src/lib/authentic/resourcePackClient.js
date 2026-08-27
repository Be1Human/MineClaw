import {
  bakeMinecraftBlockModel,
  resolveMinecraftModel,
  selectBlockModelApplications,
} from './blockModel.js';

export class ResourcePackClient {
  constructor({ fetchImpl = fetch, baseUrl = '/api/resource-packs' } = {}) {
    this.fetchImpl = fetchImpl;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.selected = null;
    this.jsonCache = new Map();
    this.paletteModelCache = new Map();
  }

  async list() {
    const response = await this.fetchImpl(this.baseUrl);
    if (!response.ok) throw new Error(`resource pack list failed (${response.status})`);
    return (await response.json()).packs ?? [];
  }

  async import(file, minecraftVersion, source = 'local-import') {
    const query = new URLSearchParams({ fileName: file.name, minecraftVersion, source });
    const response = await this.fetchImpl(`${this.baseUrl}?${query}`, {
      method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: file,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error ?? `resource pack import failed (${response.status})`);
    return payload;
  }

  select(descriptor) {
    this.selected = descriptor;
    this.jsonCache.clear();
    this.paletteModelCache.clear();
  }

  async verifySelected(gameVersion) {
    if (!this.selected) throw new Error('请先导入并选择一个资源包');
    if (this.selected.declaredMinecraftVersion && this.selected.minecraftVersion !== gameVersion) {
      throw new Error(`资源包版本 ${this.selected.minecraftVersion} 与游戏 ${gameVersion} 不匹配`);
    }
    await this.readJson('pack.mcmeta');
    return this.selected;
  }

  async resolvePaletteState(state) {
    const cacheKey = `${state.stateId}:${JSON.stringify(state.properties ?? {})}`;
    if (this.paletteModelCache.has(cacheKey)) return this.paletteModelCache.get(cacheKey);
    const promise = this.resolvePaletteStateUncached(state).catch(error => ({
      models: [missingModelDescriptor()],
      missing: [`${state.name}: ${error.message}`],
    }));
    this.paletteModelCache.set(cacheKey, promise);
    return promise;
  }

  async resolvePaletteStateUncached(state) {
    if (state.name === 'air' || state.name === 'cave_air' || state.name === 'void_air') {
      return { models: [], missing: [] };
    }
    if (state.name === 'water' || state.name === 'lava') {
      return { models: [fluidModelDescriptor(state)], missing: [] };
    }
    const location = resourceLocation(state.name);
    const blockState = await this.readJson(`assets/${location.namespace}/blockstates/${location.path}.json`);
    const applications = selectBlockModelApplications(blockState, state.properties, stableRandom(state.stateId));
    if (!applications.length) throw new Error('未匹配 blockstate variant/multipart');
    const models = [];
    for (const application of applications) {
      const model = await resolveMinecraftModel(application.model, name => this.loadModel(name));
      const baked = bakeMinecraftBlockModel(model, application, { isTextureTransparent: likelyTransparentTexture });
      models.push(serializeBakedModel(baked, model));
    }
    return { models, missing: [] };
  }

  textureUrl(textureKey) {
    if (textureKey === 'mineclaw:missing') return null;
    const location = resourceLocation(textureKey);
    return `${this.baseUrl}/${encodeURIComponent(this.selected.id)}/files/assets/${location.namespace}/textures/${location.path}.png`;
  }

  async loadModel(name) {
    const location = resourceLocation(name);
    return this.readJson(`assets/${location.namespace}/models/${location.path}.json`);
  }

  async readJson(path) {
    const key = `${this.selected?.id ?? 'none'}:${path}`;
    if (this.jsonCache.has(key)) return this.jsonCache.get(key);
    if (!this.selected) throw new Error('resource pack not selected');
    const promise = this.fetchImpl(`${this.baseUrl}/${encodeURIComponent(this.selected.id)}/files/${path}`)
      .then(async response => {
        if (!response.ok) throw new Error(`${path} 缺失 (${response.status})`);
        return response.json();
      });
    this.jsonCache.set(key, promise);
    return promise;
  }
}

function serializeBakedModel(baked, model) {
  return {
    positions: Array.from(baked.geometry.getAttribute('position').array),
    normals: Array.from(baked.geometry.getAttribute('normal').array),
    uvs: Array.from(baked.geometry.getAttribute('uv').array),
    indices: Array.from(baked.geometry.index.array),
    groups: baked.geometry.groups.map((group, index) => ({
      start: group.start, count: group.count, materialIndex: group.materialIndex,
      direction: baked.geometry.userData.faceDirections?.[index] ?? null,
    })),
    materialKeys: baked.materialKeys,
    transparent: baked.transparent,
    occluding: isFullOpaqueCube(model) && !baked.transparent,
  };
}

function missingModelDescriptor() {
  const model = {
    textures: { all: 'mineclaw:missing' },
    elements: [{
      from: [0, 0, 0], to: [16, 16, 16],
      faces: Object.fromEntries(['west', 'east', 'down', 'up', 'north', 'south'].map(direction => [direction, { texture: '#all' }])),
    }],
  };
  return serializeBakedModel(bakeMinecraftBlockModel(model), model);
}

function fluidModelDescriptor(state) {
  const level = Math.max(0, Math.min(15, Number(state.properties?.level) || 0));
  const height = level >= 8 ? 16 : Math.max(2, 15 - level);
  const texture = `minecraft:block/${state.name}_still`;
  const model = {
    textures: { all: texture },
    elements: [{
      from: [0, 0, 0], to: [16, height, 16],
      faces: Object.fromEntries(['west', 'east', 'down', 'up', 'north', 'south'].map(direction => [direction, { texture: '#all' }])),
    }],
  };
  const descriptor = serializeBakedModel(bakeMinecraftBlockModel(model, {}, { isTextureTransparent: () => true }), model);
  descriptor.occluding = false;
  return descriptor;
}

function resourceLocation(value) {
  const normalized = String(value || 'minecraft:missingno').replace(/^#/, '');
  const separator = normalized.indexOf(':');
  return separator < 0
    ? { namespace: 'minecraft', path: normalized }
    : { namespace: normalized.slice(0, separator), path: normalized.slice(separator + 1) };
}

function stableRandom(stateId) {
  const x = Math.sin(Number(stateId) * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

function likelyTransparentTexture(key) {
  return /(glass|water|lava|leaves|ice|portal|slime|honey|web)/i.test(key);
}

function isFullOpaqueCube(model) {
  return Array.isArray(model?.elements) && model.elements.length === 1
    && JSON.stringify(model.elements[0].from) === '[0,0,0]'
    && JSON.stringify(model.elements[0].to) === '[16,16,16]';
}
