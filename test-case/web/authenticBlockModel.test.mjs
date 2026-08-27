import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bakeMinecraftBlockModel,
  resolveMinecraftModel,
  selectBlockModelApplications,
} from '../../apps/minecraft-companion/web/src/lib/authentic/blockModel.js';

const fullFaces = Object.fromEntries(
  ['west', 'east', 'down', 'up', 'north', 'south'].map(direction => [direction, { texture: direction === 'north' ? '#front' : '#all' }]),
);

test('FEAT-WEBUI-27-001 | variant、multipart 与 parent 模型解析', async () => {
  const applications = selectBlockModelApplications({
    variants: {
      'facing=north,open=false': { model: 'mineclaw:block/closed' },
      'facing=north,open=true': { model: 'mineclaw:block/open', y: 90 },
    },
    multipart: [{ when: { powered: 'true|yes' }, apply: { model: 'mineclaw:block/glow' } }],
  }, { facing: 'north', open: 'true', powered: 'yes' });
  assert.deepEqual(applications.map(item => item.model), ['mineclaw:block/open', 'mineclaw:block/glow']);

  const models = new Map([
    ['mineclaw:block/base', { textures: { all: 'mineclaw:block/stone' }, elements: [{ from: [0, 0, 0], to: [16, 16, 16], faces: fullFaces }] }],
    ['mineclaw:block/child', { parent: 'mineclaw:block/base', textures: { front: 'mineclaw:block/glass' } }],
  ]);
  const resolved = await resolveMinecraftModel('mineclaw:block/child', async name => models.get(name));
  assert.equal(resolved.elements.length, 1);
  assert.equal(resolved.textures.front, 'mineclaw:block/glass');
  assert.equal(resolved.textures.all, 'mineclaw:block/stone');
});

test('FEAT-WEBUI-27-001 | 普通块、逐面材质、旋转、透明与复杂模型烘焙', () => {
  const cube = {
    textures: { all: 'mineclaw:block/stone', front: 'mineclaw:block/glass' },
    elements: [{ from: [0, 0, 0], to: [16, 16, 16], faces: fullFaces }],
  };
  const baked = bakeMinecraftBlockModel(cube, {}, { isTextureTransparent: key => key.endsWith('/glass') });
  assert.equal(baked.geometry.getAttribute('position').count, 24);
  assert.equal(baked.geometry.index.count, 36);
  assert.deepEqual(baked.materialKeys, ['mineclaw:block/stone', 'mineclaw:block/glass']);
  assert.equal(baked.transparent, true);

  const rotated = bakeMinecraftBlockModel(cube, { y: 90 });
  assert.notDeepEqual(
    Array.from(rotated.geometry.getAttribute('position').array.slice(0, 3)),
    Array.from(baked.geometry.getAttribute('position').array.slice(0, 3)),
  );

  const complex = bakeMinecraftBlockModel({
    textures: cube.textures,
    elements: [
      cube.elements[0],
      { from: [3, 0, 3], to: [13, 16, 13], rotation: { origin: [8, 8, 8], axis: 'y', angle: 22.5 }, faces: fullFaces },
    ],
  });
  assert.equal(complex.geometry.getAttribute('position').count, 48);
  assert.equal(complex.geometry.groups.length, 12);
});
