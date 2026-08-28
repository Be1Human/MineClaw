import test from 'node:test';
import assert from 'node:assert/strict';
import { PerceptionRendererRegistry } from '../../apps/minecraft-companion/web/src/lib/authentic/rendererRegistry.js';
import { ResourcePackClient } from '../../apps/minecraft-companion/web/src/lib/authentic/resourcePackClient.js';
import { bakeMinecraftBlockModel } from '../../apps/minecraft-companion/web/src/lib/authentic/blockModel.js';
import { buildSectionMeshPayload } from '../../apps/minecraft-companion/web/src/lib/authentic/sectionMeshWorker.js';
import { AuthenticWorldRenderer } from '../../apps/minecraft-companion/web/src/lib/authentic/AuthenticWorldRenderer.js';
import { selectPreferredResourcePack } from '../../apps/minecraft-companion/web/src/lib/authentic/resourcePackSelection.js';
import * as THREE from 'three';

test('FEAT-WEBUI-27-003 | RendererRegistry 原子切换，失败保留旧渲染器且 50 次切换不重复实例', async () => {
  const events = [];
  const registry = new PerceptionRendererRegistry();
  registry.register('simple', () => ({
    mount: () => events.push('simple:mount'), activate: () => events.push('simple:on'), deactivate: () => events.push('simple:off'),
  }));
  registry.register('authentic', () => ({
    mount: () => events.push('auth:mount'), activate: () => events.push('auth:on'), deactivate: () => events.push('auth:off'),
  }));
  registry.register('broken', () => ({ activate: () => { throw new Error('first frame failed'); } }));
  await registry.activate('simple');
  await assert.rejects(() => registry.activate('broken'), /first frame failed/);
  assert.equal(registry.activeId, 'simple');
  for (let i = 0; i < 50; i++) await registry.activate(i % 2 ? 'simple' : 'authentic');
  assert.equal(events.filter(event => event === 'simple:mount').length, 1);
  assert.equal(events.filter(event => event === 'auth:mount').length, 1);
  await registry.dispose();
});

test('FEAT-WEBUI-27-003 | ResourcePackClient 按 state 解析 blockstate/model 并缓存', async () => {
  const hits = new Map();
  const files = new Map([
    ['pack.mcmeta', { pack: { pack_format: 34, description: 'fixture' } }],
    ['assets/mineclaw/blockstates/probe.json', { variants: { 'facing=north': { model: 'mineclaw:block/probe', y: 90 } } }],
    ['assets/mineclaw/models/block/probe.json', {
      textures: { all: 'mineclaw:block/probe' },
      elements: [{ from: [0, 0, 0], to: [16, 16, 16], faces: cubeFaces('#all') }],
    }],
  ]);
  const client = new ResourcePackClient({
    fetchImpl: async url => {
      const path = String(url).split('/files/')[1];
      hits.set(path, (hits.get(path) ?? 0) + 1);
      return files.has(path)
        ? new Response(JSON.stringify(files.get(path)), { status: 200, headers: { 'Content-Type': 'application/json' } })
        : new Response('missing', { status: 404 });
    },
  });
  client.select({ id: 'pack-1234567890abcdef', minecraftVersion: '1.21', declaredMinecraftVersion: '1.21' });
  await client.verifySelected('1.21');
  const first = await client.resolvePaletteState({ stateId: 7, name: 'mineclaw:probe', properties: { facing: 'north' } });
  const second = await client.resolvePaletteState({ stateId: 7, name: 'mineclaw:probe', properties: { facing: 'north' } });
  assert.equal(first.models[0].positions.length, 72);
  assert.equal(first.models[0].groups.length, 6);
  assert.equal(second, first);
  assert.equal(hits.get('assets/mineclaw/models/block/probe.json'), 1);
});

test('FEAT-WEBUI-27-003 | Worker 合并 section 材质桶并剔除相邻完整方块内表面', () => {
  const model = serializableCube();
  const indices = new Uint16Array(4096);
  indices.fill(0);
  indices[0] = 1;
  indices[1] = 1;
  const result = buildSectionMeshPayload({
    section: { key: '0,0,0', chunkX: 0, sectionY: 0, chunkZ: 0, indices },
    paletteModels: [[], [model]],
  });
  assert.equal(result.renderedBlocks, 2);
  assert.equal(result.meshes.length, 1);
  assert.equal(result.meshes[0].indices.length, 60, '两方块共 10 个外露面，应为 20 个三角形');
  assert.equal(result.meshes[0].positions.length / 3, 40);
});

test('FEAT-WEBUI-27-005 | 无手工选择时优先内置包，已保存的兼容选择仍优先', () => {
  const imported = { id: 'imported', source: 'local-import', minecraftVersion: '1.21' };
  const builtin = { id: 'builtin', source: 'mineclaw-original', minecraftVersion: '1.21' };
  const wrongVersion = { id: 'old', source: 'mineclaw-original', minecraftVersion: '1.20.6' };
  assert.equal(selectPreferredResourcePack([imported, wrongVersion, builtin], { gameVersion: '1.21' }), builtin);
  assert.equal(selectPreferredResourcePack([builtin, imported], { savedId: 'imported', gameVersion: '1.21' }), imported);
  assert.equal(selectPreferredResourcePack([wrongVersion], { savedId: 'old', gameVersion: '1.21' }), null);
});

test('FEAT-WEBUI-27-005 | blockstate/model 缺失时使用贴图基础方块回退', async () => {
  const requests = [];
  const client = new ResourcePackClient({
    fetchImpl: async (url, options = {}) => {
      requests.push({ url: String(url), method: options.method ?? 'GET' });
      if (options.method === 'HEAD' && String(url).endsWith('/textures/block/stone.png')) return new Response(null, { status: 200 });
      return new Response('missing', { status: 404 });
    },
  });
  client.select({ id: 'pack-1234567890abcdef', source: 'mineclaw-original', minecraftVersion: '1.21' });
  const resolved = await client.resolvePaletteState({ stateId: 1, name: 'stone', properties: {} });
  assert.equal(resolved.fallback, true);
  assert.deepEqual(resolved.missing, []);
  assert.deepEqual(resolved.models[0].materialKeys, ['minecraft:block/stone']);
  assert.ok(requests.some(request => request.method === 'HEAD'));
});

test('FEAT-WEBUI-27-004 | Profile/session 切换使旧 Worker 结果失效，同 section key 可启动新世代首帧', async () => {
  const tasks = [];
  const worker = {
    onmessage: null, onerror: null,
    postMessage(message) { tasks.push(message); },
    terminate() {},
  };
  const packClient = {
    select() {}, verifySelected: async () => {}, textureUrl: () => '',
    resolvePaletteState: async () => ({ models: [], missing: [] }),
  };
  const scene = new THREE.Scene();
  const renderer = new AuthenticWorldRenderer({
    scene, packClient, workerFactory: () => worker,
    config: {
      maxAuthenticEntities: 2, entityInterpolationMs: 120, weatherParticleCount: 0, weatherRadius: 8,
      weatherFallSpeed: 18, fogDensity: { overworld: 0.004, theNether: 0.018, theEnd: 0.009 }, rainFogMultiplier: 1.45,
      maxResidentSections: 4, maxSectionBuildsPerFrame: 1, sectionBuildBudgetMs: 4,
    },
  });
  renderer.mount();
  const firstStore = rendererStore('old-session');
  renderer.setStore(firstStore);
  const oldBuild = renderer.buildSection('0,0,0');
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(tasks.length, 1);

  const nextStore = rendererStore('new-session');
  renderer.setStore(nextStore);
  const newBuild = renderer.buildSection('0,0,0');
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(tasks.length, 2);
  worker.onmessage({ data: { taskId: tasks[0].taskId, result: { meshes: [] } } });
  await oldBuild;
  assert.equal(renderer.sectionMeshes.size, 0);
  worker.onmessage({ data: { taskId: tasks[1].taskId, result: { meshes: [] } } });
  await newBuild;
  assert.equal(renderer.sectionMeshes.get('0,0,0')?.name, 'section:0,0,0');
  renderer.dispose();
});

function cubeFaces(texture) {
  return Object.fromEntries(['west', 'east', 'down', 'up', 'north', 'south'].map(direction => [direction, { texture }]));
}

function serializableCube() {
  const model = { textures: { all: 'mineclaw:block/probe' }, elements: [{ from: [0, 0, 0], to: [16, 16, 16], faces: cubeFaces('#all') }] };
  const baked = bakeMinecraftBlockModel(model);
  return {
    positions: Array.from(baked.geometry.getAttribute('position').array),
    normals: Array.from(baked.geometry.getAttribute('normal').array),
    uvs: Array.from(baked.geometry.getAttribute('uv').array),
    indices: Array.from(baked.geometry.index.array),
    groups: baked.geometry.groups.map((group, index) => ({ ...group, direction: baked.geometry.userData.faceDirections[index] })),
    materialKeys: baked.materialKeys,
    transparent: false,
    occluding: true,
  };
}

function rendererStore(sessionId) {
  return {
    status: 'ready', sessionId, gameVersion: '1.21', center: { chunkX: 0, chunkZ: 0 },
    environment: { dimension: 'overworld', timeOfDay: 6000, isRaining: false, thunderState: 0 },
    entities: new Map(), dirtySections: new Set(),
    sections: new Map([['0,0,0', {
      key: '0,0,0', chunkX: 0, sectionY: 0, chunkZ: 0,
      palette: [{ stateId: 0, name: 'air', properties: {} }], indices: new Uint16Array(4096),
    }]]),
    takeRemovedSections: () => [], takeDirtySections: () => [],
  };
}
