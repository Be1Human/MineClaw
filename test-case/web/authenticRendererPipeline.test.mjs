import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PerceptionRendererRegistry } from '../../apps/minecraft-companion/web/src/lib/authentic/rendererRegistry.js';
import { ResourcePackClient } from '../../apps/minecraft-companion/web/src/lib/authentic/resourcePackClient.js';
import { bakeMinecraftBlockModel } from '../../apps/minecraft-companion/web/src/lib/authentic/blockModel.js';
import { buildSectionMeshPayload } from '../../apps/minecraft-companion/web/src/lib/authentic/sectionMeshWorker.js';
import { AuthenticWorldRenderer } from '../../apps/minecraft-companion/web/src/lib/authentic/AuthenticWorldRenderer.js';
import { selectBuiltinResourcePack } from '../../apps/minecraft-companion/web/src/lib/authentic/resourcePackSelection.js';
import {
  MATERIAL_RENDER_LAYER,
  classifyMaterialRenderLayer,
  materialRenderOptions,
} from '../../apps/minecraft-companion/web/src/lib/authentic/materialRenderLayer.js';
import * as THREE from 'three';

test('BUG-WEBUI-29-001 | 植物使用透明裁切，流体与普通方块保持原渲染层', () => {
  const cutouts = [
    'minecraft:block/grass', 'minecraft:block/fern', 'minecraft:block/poppy',
    'minecraft:block/oak_sapling', 'minecraft:block/wheat_stage7',
    'minecraft:block/oak_leaves', 'minecraft:block/cobweb', 'minecraft:block/grass_block_side_overlay',
  ];
  for (const key of cutouts) {
    assert.equal(classifyMaterialRenderLayer(key), MATERIAL_RENDER_LAYER.CUTOUT, key);
  }

  for (const key of ['minecraft:block/water_still', 'minecraft:block/glass', 'minecraft:block/ice', 'minecraft:block/nether_portal']) {
    assert.equal(classifyMaterialRenderLayer(key), MATERIAL_RENDER_LAYER.TRANSLUCENT, key);
  }

  for (const key of ['minecraft:block/stone', 'minecraft:block/spruce_log', 'minecraft:block/grass_block_top']) {
    assert.equal(classifyMaterialRenderLayer(key), MATERIAL_RENDER_LAYER.OPAQUE, key);
  }
});

test('BUG-WEBUI-29-001 | 透明裁切保留深度写入且不启用透明混合', () => {
  assert.deepEqual(materialRenderOptions(MATERIAL_RENDER_LAYER.CUTOUT), {
    transparent: false,
    opacity: 1,
    alphaTest: 0.1,
    depthWrite: true,
    doubleSided: false,
  });
  assert.deepEqual(materialRenderOptions(MATERIAL_RENDER_LAYER.TRANSLUCENT), {
    transparent: true,
    opacity: 0.82,
    alphaTest: 0,
    depthWrite: false,
    doubleSided: true,
  });
});

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

test('BUG-WEBUI-23-004 | 同一 renderer 并发激活不会被过期请求隐藏', async () => {
  let visible = false;
  let activations = 0;
  let deactivations = 0;
  let releaseFirstFrame;
  const firstFrame = new Promise(resolve => { releaseFirstFrame = resolve; });
  const renderer = {
    async activate() {
      activations += 1;
      await firstFrame;
      visible = true;
    },
    deactivate() {
      deactivations += 1;
      visible = false;
    },
  };
  const registry = new PerceptionRendererRegistry();
  registry.register('simple', () => renderer);

  const first = registry.activate('simple');
  const second = registry.activate('simple');
  releaseFirstFrame();
  await Promise.all([first, second]);

  assert.equal(activations, 1, '同一模式的在途激活应合并');
  assert.equal(deactivations, 0, '过期调用不得停用已接管的同一实例');
  assert.equal(registry.activeId, 'simple');
  assert.equal(registry.active, renderer);
  assert.equal(visible, true);
  await registry.dispose();
});

test('BUG-WEBUI-23-004 | 返回当前模式会使旧的异步切换安全失效', async () => {
  let authenticVisible = false;
  let releaseAuthentic;
  const authenticFirstFrame = new Promise(resolve => { releaseAuthentic = resolve; });
  const simple = { visible: false, activate() { this.visible = true; }, deactivate() { this.visible = false; } };
  const authentic = {
    async activate() { await authenticFirstFrame; authenticVisible = true; },
    deactivate() { authenticVisible = false; },
  };
  const registry = new PerceptionRendererRegistry();
  registry.register('simple', () => simple);
  registry.register('authentic', () => authentic);
  await registry.activate('simple');

  const pendingAuthentic = registry.activate('authentic');
  await registry.activate('simple');
  releaseAuthentic();
  await pendingAuthentic;

  assert.equal(registry.activeId, 'simple');
  assert.equal(simple.visible, true);
  assert.equal(authenticVisible, false);
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
  await client.verifySelected('1.21.1');
  const first = await client.resolvePaletteState({ stateId: 7, name: 'mineclaw:probe', properties: { facing: 'north' } });
  const second = await client.resolvePaletteState({ stateId: 7, name: 'mineclaw:probe', properties: { facing: 'north' } });
  assert.equal(first.models[0].positions.length, 72);
  assert.equal(first.models[0].groups.length, 6);
  assert.equal(second, first);
  assert.equal(hits.get('assets/mineclaw/models/block/probe.json'), 1);
});

test('BUG-WEBUI-27-001 | 覆盖层缺失时从 1.21.1 聚合基线解析 blockstate 与 parent', async () => {
  const files = new Map([
    ['pack.mcmeta', { pack: { pack_format: 34 } }],
    ['assets/minecraft/mineclaw-baseline/1.21.1/blocks_states.json', {
      spruce_log: { variants: { 'axis=y': { model: 'minecraft:block/spruce_log' } } },
    }],
    ['assets/minecraft/mineclaw-baseline/1.21.1/blocks_models.json', {
      spruce_log: { parent: 'minecraft:block/cube_column', textures: { side: 'minecraft:block/spruce_log', end: 'minecraft:block/spruce_log_top' } },
      cube_column: { parent: 'minecraft:block/cube', textures: { down: '#end', up: '#end', north: '#side', south: '#side', west: '#side', east: '#side' } },
      cube: { elements: [{ from: [0, 0, 0], to: [16, 16, 16], faces: cubeFaces('#side') }] },
    }],
  ]);
  const client = new ResourcePackClient({
    fetchImpl: async url => {
      const path = String(url).split('/files/')[1];
      return files.has(path)
        ? new Response(JSON.stringify(files.get(path)), { status: 200, headers: { 'Content-Type': 'application/json' } })
        : new Response('missing', { status: 404 });
    },
  });
  client.select({ id: 'pack-1234567890abcdef', minecraftVersion: '1.21', declaredMinecraftVersion: '1.21' });
  await client.verifySelected('1.21.1');
  const resolved = await client.resolvePaletteState({ stateId: 117, name: 'spruce_log', properties: { axis: 'y' } });
  assert.equal(resolved.fallback, false);
  assert.equal(resolved.models[0].blockName, 'spruce_log');
  assert.ok(resolved.models[0].materialKeys.includes('minecraft:block/spruce_log'));
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

test('BUG-WEBUI-27-003 | Worker 按 tintindex 生成固定叶色', () => {
  const indices = new Uint16Array(4096);
  const biomeIndices = new Uint16Array(4096);
  const tintedModel = {
    positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0],
    normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
    uvs: [0, 0, 1, 0, 1, 1, 0, 1],
    indices: [0, 1, 2, 0, 2, 3],
    groups: [{ start: 0, count: 6, materialIndex: 0, direction: null, tintIndex: 0 }],
    materialKeys: ['minecraft:block/spruce_leaves'],
    blockName: 'spruce_leaves', properties: {}, occluding: false,
  };
  const result = buildSectionMeshPayload({
    section: { key: '0,0,0', chunkX: 0, sectionY: 0, chunkZ: 0, indices, biomeIndices, biomePalette: [{ id: 54, name: 'taiga' }] },
    paletteModels: [[tintedModel]],
    tintData: { constant: { data: [{ keys: ['spruce_leaves'], color: -10380959 }] } },
  });
  const color = Array.from(result.meshes[0].colors.slice(0, 3)).map(value => Math.round(value * 255));
  assert.deepEqual(color, [0x61, 0x99, 0x61]);
});

test('BUG-WEBUI-27-003 | Worker 区分 biome、水体和红石状态染色', () => {
  const indices = new Uint16Array(4096);
  indices[0] = 1;
  indices[1] = 2;
  indices[2] = 3;
  const biomeIndices = new Uint16Array(4096);
  const makeTinted = (blockName, materialKey, properties = {}) => ({
    positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0],
    normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
    uvs: [0, 0, 1, 0, 1, 1, 0, 1], indices: [0, 1, 2, 0, 2, 3],
    groups: [{ start: 0, count: 6, materialIndex: 0, direction: null, tintIndex: 0 }],
    materialKeys: [materialKey], blockName, properties, occluding: false,
  });
  const result = buildSectionMeshPayload({
    section: { key: '0,0,0', chunkX: 0, sectionY: 0, chunkZ: 0, indices, biomeIndices, biomePalette: [{ id: 39, name: 'plains' }] },
    paletteModels: [[], [makeTinted('grass_block', 'minecraft:block/grass_block_top')], [makeTinted('water', 'minecraft:block/water_still')], [makeTinted('redstone_wire', 'minecraft:block/redstone_dust_dot', { power: '15' })]],
    tintData: {
      grass: { data: [{ keys: ['plains'], color: 0 }] },
      water: { data: [{ keys: ['plains'], color: 0x3f76e4 }] },
      redstone: { data: [{ keys: [15], color: 0xff0000 }] },
    },
  });
  const colors = Object.fromEntries(result.meshes.map(mesh => [mesh.materialKey, Array.from(mesh.colors.slice(0, 3)).map(value => Math.round(value * 255))]));
  assert.deepEqual(colors['minecraft:block/grass_block_top'], [0x91, 0xbd, 0x59], '动态 colormap 占位 0 不得渲染成黑色');
  assert.deepEqual(colors['minecraft:block/water_still'], [0x3f, 0x76, 0xe4]);
  assert.deepEqual(colors['minecraft:block/redstone_dust_dot'], [0xff, 0x00, 0x00]);
});

test('BUG-WEBUI-23-001 | 真实模式只选择版本匹配的内置包', () => {
  const imported = { id: 'imported', source: 'local-import', minecraftVersion: '1.21' };
  const builtin = { id: 'builtin', source: 'mineclaw-original', minecraftVersion: '1.21' };
  const wrongVersion = { id: 'old', source: 'mineclaw-original', minecraftVersion: '1.20.6' };
  assert.equal(selectBuiltinResourcePack([imported, wrongVersion, builtin], { gameVersion: '1.21' }), builtin);
  assert.equal(selectBuiltinResourcePack([builtin], { gameVersion: '1.21.1' }), builtin);
  assert.equal(selectBuiltinResourcePack([builtin, imported], { gameVersion: '1.21' }), builtin);
  assert.equal(selectBuiltinResourcePack([imported], { gameVersion: '1.21' }), null);
  assert.equal(selectBuiltinResourcePack([wrongVersion], { gameVersion: '1.21' }), null);
});

test('BUG-WEBUI-23-001 | 真实模式不再暴露资源选择、ZIP 导入或 Profile 资源持久化', () => {
  const source = readFileSync(new URL('../../apps/minecraft-companion/web/src/components/PerceptionScene3D.vue', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /选择资源包|导入 ZIP|type="file"|mc\.visualResourcePacks|selectedPackId|importResourcePack/);
  assert.match(source, /selectBuiltinResourcePack/);
});

test('BUG-WEBUI-23-001 | 浏览器原生 fetch 不以 ResourcePackClient 作为 this 调用', async () => {
  let receiver = null;
  const client = new ResourcePackClient({
    fetchImpl: function () {
      receiver = this;
      return Promise.resolve({ ok: true, json: async () => ({ packs: [] }) });
    },
  });
  await client.list();
  assert.equal(receiver, undefined);
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

test('BUG-WEBUI-23-005 | 真实渲染优先玩家所在高度并上报首个可见区段', async () => {
  const tasks = [];
  const progress = [];
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
    scene, packClient, workerFactory: () => worker, onProgress: value => progress.push(value),
    config: {
      maxAuthenticEntities: 2, entityInterpolationMs: 120, weatherParticleCount: 0, weatherRadius: 8,
      weatherFallSpeed: 18, fogDensity: { overworld: 0.004, theNether: 0.018, theEnd: 0.009 }, rainFogMultiplier: 1.45,
      maxResidentSections: 4, maxSectionBuildsPerFrame: 1, sectionBuildBudgetMs: 4,
    },
  });
  renderer.mount();
  renderer.setFocusPosition({ x: 8, y: 118, z: 8 });
  const store = rendererStore('progress-session');
  const surface = { ...store.sections.get('0,0,0'), key: '0,7,0', sectionY: 7 };
  store.sections.set(surface.key, surface);
  renderer.setStore(store);

  const activating = renderer.activate();
  for (let attempt = 0; attempt < 10 && tasks.length === 0; attempt += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(tasks[0].payload.section.key, '0,7,0', '首个区段应靠近玩家所在 sectionY，而不是世界 y=0');
  worker.onmessage({ data: { taskId: tasks[0].taskId, result: triangleSectionResult() } });
  await activating;

  const latest = progress.at(-1);
  assert.equal(latest.sessionId, 'progress-session');
  assert.equal(latest.totalSections, 2);
  assert.equal(latest.completedSections, 1);
  assert.equal(latest.firstVisibleReady, true);
  renderer.dispose();
});

test('BUG-WEBUI-28-002 | 宽视野只准入当前 7×7 区块且同区块移动不重排', () => {
  const renderer = new AuthenticWorldRenderer({
    scene: new THREE.Scene(),
    config: rendererConfig({ viewDistanceChunks: 3, maxPendingSectionBuilds: 4 }),
    packClient: { select() {}, verifySelected: async () => {}, textureUrl: () => '', resolvePaletteState: async () => ({ models: [], missing: [] }) },
    workerFactory: () => ({ postMessage() {}, terminate() {} }),
  });
  renderer.setFocusPosition({ x: 8, y: 64, z: 8 });
  const store = rendererStore('wide-window');
  store.sections.clear();
  for (let chunkX = -30; chunkX <= 30; chunkX += 1) {
    for (let chunkZ = -30; chunkZ <= 30; chunkZ += 1) {
      const key = `${chunkX},4,${chunkZ}`;
      store.sections.set(key, rendererSection(key, chunkX, 4, chunkZ));
    }
  }
  renderer.setStore(store);
  assert.equal(store.sections.size, 3721, '夹具保留大范围历史数据以验证前端防线');
  assert.equal(renderer.queue.length, 49, '3 区块半径应准入 7×7 个当前列');
  assert.equal(renderer.progressSnapshot().totalSections, 49);

  const before = [...renderer.queue];
  renderer.setFocusPosition({ x: 15, y: 64, z: 15 });
  assert.deepEqual(renderer.queue, before, '同一区块内移动不得重排队列');
  renderer.setFocusPosition({ x: 16, y: 64, z: 8 });
  assert.equal(renderer.queue.length, 49, '跨区块后仍保持固定宽视野窗口');
  assert.equal(renderer.progressSnapshot().totalSections, 49);
  renderer.dispose();
});

test('BUG-WEBUI-28-002 | Worker 构建在途数受 4 个上限约束', async () => {
  const tasks = [];
  const worker = {
    onmessage: null, onerror: null,
    postMessage(message) { tasks.push(message); },
    terminate() {},
  };
  const renderer = new AuthenticWorldRenderer({
    scene: new THREE.Scene(), workerFactory: () => worker,
    config: rendererConfig({ viewDistanceChunks: 3, maxPendingSectionBuilds: 4, maxSectionBuildsPerFrame: 20 }),
    packClient: {
      select() {}, verifySelected: async () => {}, textureUrl: () => '',
      resolvePaletteState: async () => ({ models: [], missing: [] }),
    },
  });
  renderer.setFocusPosition({ x: 8, y: 64, z: 8 });
  const store = rendererStore('bounded-worker');
  store.sections.clear();
  for (let chunkX = -3; chunkX <= 3; chunkX += 1) {
    const key = `${chunkX},4,0`;
    store.sections.set(key, rendererSection(key, chunkX, 4, 0));
  }
  renderer.setStore(store);
  renderer.active = true;
  renderer.tick();
  renderer.tick();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(renderer.currentRunningCount(), 4);
  assert.equal(tasks.length, 4, '未返回结果前不得继续塞入单 Worker');
  assert.equal(renderer.progressSnapshot().runningSections, 4);

  for (const task of tasks) worker.onmessage({ data: { taskId: task.taskId, result: { meshes: [] } } });
  await new Promise(resolve => setImmediate(resolve));
  renderer.dispose();
});

test('BUG-WEBUI-23-005 | 真实模式提供准备、接收、渲染进度条且警告独立展示', () => {
  const perception = readFileSync(new URL('../../apps/minecraft-companion/web/src/components/PerceptionScene3D.vue', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../../apps/minecraft-companion/web/src/App.vue', import.meta.url), 'utf8');
  assert.match(perception, /role="progressbar"/);
  assert.match(perception, /world-mode-warning/);
  assert.match(perception, /visual-render-progress/);
  assert.match(app, /phase: 'preparing'/);
  assert.match(app, /phase: 'receiving'/);
  assert.match(app, /phase: 'rendering'/);
  assert.match(app, /handleVisualRenderProgress/);
  assert.match(app, /if \(total === 0\) return/);
});

function cubeFaces(texture) {
  return Object.fromEntries(['west', 'east', 'down', 'up', 'north', 'south'].map(direction => [direction, { texture, cullface: direction }]));
}

function serializableCube() {
  const model = { textures: { all: 'mineclaw:block/probe' }, elements: [{ from: [0, 0, 0], to: [16, 16, 16], faces: cubeFaces('#all') }] };
  const baked = bakeMinecraftBlockModel(model);
  return {
    positions: Array.from(baked.geometry.getAttribute('position').array),
    normals: Array.from(baked.geometry.getAttribute('normal').array),
    uvs: Array.from(baked.geometry.getAttribute('uv').array),
    indices: Array.from(baked.geometry.index.array),
    groups: baked.geometry.groups.map((group, index) => ({
      ...group,
      direction: baked.geometry.userData.faceDirections[index],
      tintIndex: baked.geometry.userData.faceTintIndices[index],
    })),
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

function rendererSection(key, chunkX, sectionY, chunkZ) {
  return {
    key, chunkX, sectionY, chunkZ,
    palette: [{ stateId: 0, name: 'air', properties: {} }], indices: new Uint16Array(4096),
  };
}

function rendererConfig(overrides = {}) {
  return {
    maxAuthenticEntities: 2, entityInterpolationMs: 120, weatherParticleCount: 0, weatherRadius: 8,
    weatherFallSpeed: 18, fogDensity: { overworld: 0.004, theNether: 0.018, theEnd: 0.009 }, rainFogMultiplier: 1.45,
    maxResidentSections: 512, maxSectionBuildsPerFrame: 2, maxPendingSectionBuilds: 4,
    sectionBuildBudgetMs: 6, viewDistanceChunks: 3,
    ...overrides,
  };
}

function triangleSectionResult() {
  return {
    meshes: [{
      materialKey: 'mineclaw:missing',
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
      uvs: new Float32Array([0, 0, 1, 0, 0, 1]),
      indices: new Uint32Array([0, 1, 2]),
    }],
  };
}
