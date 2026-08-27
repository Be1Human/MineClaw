import test from 'node:test';
import assert from 'node:assert/strict';
import { PerceptionRendererRegistry } from '../../apps/minecraft-companion/web/src/lib/authentic/rendererRegistry.js';
import { ResourcePackClient } from '../../apps/minecraft-companion/web/src/lib/authentic/resourcePackClient.js';
import { bakeMinecraftBlockModel } from '../../apps/minecraft-companion/web/src/lib/authentic/blockModel.js';
import { buildSectionMeshPayload } from '../../apps/minecraft-companion/web/src/lib/authentic/sectionMeshWorker.js';

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
