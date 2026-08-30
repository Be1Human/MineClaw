import {
  bakeMinecraftBlockModel,
  resolveMinecraftModel,
  selectBlockModelApplications,
} from './blockModel.js';
import { isCompatibleMinecraftVersion } from './resourcePackSelection.js';
import { isNonOpaqueMaterial } from './materialRenderLayer.js';

export class ResourcePackClient {
  constructor({ fetchImpl = fetch, baseUrl = '/api/resource-packs' } = {}) {
    this.fetchImpl = (...args) => fetchImpl(...args);
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.selected = null;
    this.gameVersion = null;
    this.jsonCache = new Map();
    this.baselineCache = new Map();
    this.paletteModelCache = new Map();
    this.assetExistenceCache = new Map();
  }

  async list() {
    const response = await this.fetchImpl(this.baseUrl);
    if (!response.ok) throw new Error(`resource pack list failed (${response.status})`);
    return (await response.json()).packs ?? [];
  }

  select(descriptor) {
    this.selected = descriptor;
    this.gameVersion = normalizeBaselineVersion(descriptor?.minecraftVersion);
    this.jsonCache.clear();
    this.baselineCache.clear();
    this.paletteModelCache.clear();
    this.assetExistenceCache.clear();
  }

  async verifySelected(gameVersion) {
    if (!this.selected) throw new Error('内置真实资源尚未就绪');
    if (this.selected.declaredMinecraftVersion
      && !isCompatibleMinecraftVersion(this.selected.minecraftVersion, gameVersion)) {
      throw new Error(`资源包版本 ${this.selected.minecraftVersion} 与游戏 ${gameVersion} 不匹配`);
    }
    this.gameVersion = normalizeBaselineVersion(gameVersion);
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
    try {
      const location = resourceLocation(state.name);
      const blockState = await this.loadBlockState(location);
      const applications = selectBlockModelApplications(blockState, state.properties, stableRandom(state.stateId));
      if (!applications.length) throw new Error('未匹配 blockstate variant/multipart');
      const models = [];
      const diagnostics = [];
      for (const application of applications) {
        const model = await resolveMinecraftModel(application.model, name => this.loadModel(name));
        const baked = bakeMinecraftBlockModel(model, application, { isTextureTransparent: likelyTransparentTexture });
        if (baked.geometry.getAttribute('position').count === 0) {
          diagnostics.push({
            type: 'unsupported-block-entity',
            block: state.name,
            message: `${application.model} 需要专用 block entity renderer`,
          });
          continue;
        }
        models.push(serializeBakedModel(baked, model, state));
      }
      return { models, missing: [], fallback: false, unsupported: models.length === 0, diagnostics };
    } catch (error) {
      const texture = await this.findFallbackTexture(state);
      return {
        models: [cubeModelDescriptor(texture, state)],
        missing: texture === 'mineclaw:missing' ? [`${state.name}: ${error.message}`] : [],
        fallback: true,
        fallbackKind: 'legacy-cube',
        diagnostics: [{ type: 'legacy-cube-fallback', block: state.name, message: error.message }],
      };
    }
  }

  async loadBlockState(location) {
    const path = `assets/${location.namespace}/blockstates/${location.path}.json`;
    try {
      return await this.readJson(path);
    } catch (overlayError) {
      if (location.namespace !== 'minecraft') throw overlayError;
      const states = await this.readBaselineJson('blocks_states');
      const state = states[location.path];
      if (!state) throw new Error(`${path} 在覆盖层和 ${this.gameVersion} 基线中都缺失`);
      return state;
    }
  }

  async findFallbackTexture(state) {
    const location = resourceLocation(state.name);
    const base = `${location.namespace}:block/${location.path}`;
    const candidates = [
      FALLBACK_TEXTURE_OVERRIDES[state.name],
      base,
      `${base}_side`,
      `${base}_top`,
      `${base}_front`,
    ].filter((value, index, values) => value && values.indexOf(value) === index);
    for (const textureKey of candidates) {
      if (await this.textureExists(textureKey)) return textureKey;
    }
    return 'mineclaw:missing';
  }

  async textureExists(textureKey) {
    if (this.assetExistenceCache.has(textureKey)) return this.assetExistenceCache.get(textureKey);
    const promise = this.fetchImpl(this.textureUrl(textureKey), { method: 'HEAD' })
      .then(response => response.ok)
      .catch(() => false);
    this.assetExistenceCache.set(textureKey, promise);
    return promise;
  }

  textureUrl(textureKey) {
    if (textureKey === 'mineclaw:missing') return null;
    const location = resourceLocation(textureKey);
    return `${this.baseUrl}/${encodeURIComponent(this.selected.id)}/files/assets/${location.namespace}/textures/${location.path}.png`;
  }

  async loadModel(name) {
    const location = resourceLocation(name);
    const path = `assets/${location.namespace}/models/${location.path}.json`;
    try {
      return await this.readJson(path);
    } catch (overlayError) {
      if (location.namespace !== 'minecraft') throw overlayError;
      const models = await this.readBaselineJson('blocks_models');
      const modelName = location.path.replace(/^block\//, '');
      const model = models[modelName];
      if (!model) throw new Error(`${path} 在覆盖层和 ${this.gameVersion} 基线中都缺失`);
      return model;
    }
  }

  async getTintData() {
    try {
      return await this.readBaselineJson('tints');
    } catch {
      return {};
    }
  }

  async readBaselineJson(kind) {
    const version = normalizeBaselineVersion(this.gameVersion ?? this.selected?.minecraftVersion);
    const key = `${this.selected?.id ?? 'none'}:${version}:${kind}`;
    if (this.baselineCache.has(key)) return this.baselineCache.get(key);
    if (!this.selected) throw new Error('resource pack not selected');
    const path = `assets/minecraft/mineclaw-baseline/${version}/${kind}.json`;
    const promise = this.readJson(path);
    this.baselineCache.set(key, promise);
    return promise;
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

function serializeBakedModel(baked, model, state = {}) {
  return {
    positions: Array.from(baked.geometry.getAttribute('position').array),
    normals: Array.from(baked.geometry.getAttribute('normal').array),
    uvs: Array.from(baked.geometry.getAttribute('uv').array),
    indices: Array.from(baked.geometry.index.array),
    groups: baked.geometry.groups.map((group, index) => ({
      start: group.start, count: group.count, materialIndex: group.materialIndex,
      direction: baked.geometry.userData.faceDirections?.[index] ?? null,
      tintIndex: baked.geometry.userData.faceTintIndices?.[index] ?? null,
    })),
    materialKeys: baked.materialKeys,
    transparent: baked.transparent,
    occluding: isFullOpaqueCube(model) && !baked.transparent,
    blockName: state.name ?? null,
    properties: state.properties ?? {},
  };
}

function missingModelDescriptor() {
  return cubeModelDescriptor('mineclaw:missing');
}

function cubeModelDescriptor(texture, state = {}) {
  const model = {
    textures: { all: texture },
    elements: [{
      from: [0, 0, 0], to: [16, 16, 16],
      faces: Object.fromEntries(['west', 'east', 'down', 'up', 'north', 'south'].map(direction => [direction, { texture: '#all' }])),
    }],
  };
  return serializeBakedModel(bakeMinecraftBlockModel(model), model, state);
}

const FALLBACK_TEXTURE_OVERRIDES = {
  grass_block: 'minecraft:block/grass_block_side',
  mycelium: 'minecraft:block/mycelium_side',
  podzol: 'minecraft:block/podzol_side',
};

function fluidModelDescriptor(state) {
  const level = Math.max(0, Math.min(15, Number(state.properties?.level) || 0));
  const height = level >= 8 ? 16 : Math.max(2, 15 - level);
  const texture = `minecraft:block/${state.name}_still`;
  const model = {
    textures: { all: texture },
    elements: [{
      from: [0, 0, 0], to: [16, height, 16],
      faces: Object.fromEntries(['west', 'east', 'down', 'up', 'north', 'south'].map(direction => [direction, {
        texture: '#all', tintindex: state.name === 'water' ? 0 : undefined,
      }])),
    }],
  };
  const descriptor = serializeBakedModel(bakeMinecraftBlockModel(model, {}, { isTextureTransparent: () => true }), model, state);
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
  return isNonOpaqueMaterial(key);
}

function isFullOpaqueCube(model) {
  return Array.isArray(model?.elements) && model.elements.length === 1
    && JSON.stringify(model.elements[0].from) === '[0,0,0]'
    && JSON.stringify(model.elements[0].to) === '[16,16,16]';
}

function normalizeBaselineVersion(version) {
  const normalized = String(version ?? '').trim();
  if (normalized === '1.21') return '1.21.1';
  return normalized || '1.21.1';
}
