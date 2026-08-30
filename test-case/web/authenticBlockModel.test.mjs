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

test('BUG-WEBUI-27-002 | application 旋转使用原版符号并同步 cullface', () => {
  const model = {
    textures: { all: 'mineclaw:block/probe' },
    elements: [{
      from: [0, 0, 0], to: [16, 16, 16],
      faces: {
        north: { texture: '#all', cullface: 'north' },
        up: { texture: '#all', cullface: 'up' },
        south: { texture: '#all' },
      },
    }],
  };
  const y90 = bakeMinecraftBlockModel(model, { y: 90 });
  assert.equal(y90.geometry.userData.faceDirections[0], 'east');
  assert.deepEqual(
    Array.from(y90.geometry.getAttribute('normal').array.slice(0, 3)).map(roundAxis),
    [1, 0, 0],
  );
  assert.equal(y90.geometry.userData.faceDirections[2], null, '没有 cullface 的可见面不得参与整面邻接剔除');

  const x90 = bakeMinecraftBlockModel(model, { x: 90 });
  assert.equal(x90.geometry.userData.faceDirections[1], 'north');
});

test('BUG-WEBUI-27-002 | 六面三角形绕序在原木三轴旋转后仍与法线同向', () => {
  const model = {
    textures: { all: 'mineclaw:block/probe' },
    elements: [{ from: [0, 0, 0], to: [16, 16, 16], faces: fullFaces }],
  };
  for (const application of [{}, { x: 90 }, { y: 90 }, { x: 90, y: 90 }]) {
    const baked = bakeMinecraftBlockModel(model, application);
    assertGeometryWindingMatchesNormals(baked.geometry, JSON.stringify(application));
  }
});

test('BUG-WEBUI-27-002 | uvlock 对 application 旋转后的世界投影做补偿', () => {
  const model = {
    textures: { all: 'mineclaw:block/probe' },
    elements: [{ from: [0, 0, 0], to: [16, 16, 16], faces: { up: { texture: '#all' } } }],
  };
  const unlocked = bakeMinecraftBlockModel(model, { y: 90 });
  const locked = bakeMinecraftBlockModel(model, { y: 90, uvlock: true });
  assert.deepEqual(Array.from(unlocked.geometry.getAttribute('uv').array), [0, 0, 1, 0, 1, 1, 0, 1]);
  assert.deepEqual(
    Array.from(locked.geometry.getAttribute('uv').array).map(value => Math.abs(value) < 1e-6 ? 0 : Math.round(value)),
    [0, 1, 0, 0, 1, 0, 1, 1],
  );
});

function roundAxis(value) {
  return Math.abs(value) < 1e-6 ? 0 : Math.round(value);
}

function assertGeometryWindingMatchesNormals(geometry, label) {
  const positions = geometry.getAttribute('position');
  const normals = geometry.getAttribute('normal');
  for (const [groupIndex, group] of geometry.groups.entries()) {
    const [a, b, c] = Array.from(geometry.index.array.slice(group.start, group.start + 3));
    const ab = [
      positions.getX(b) - positions.getX(a),
      positions.getY(b) - positions.getY(a),
      positions.getZ(b) - positions.getZ(a),
    ];
    const ac = [
      positions.getX(c) - positions.getX(a),
      positions.getY(c) - positions.getY(a),
      positions.getZ(c) - positions.getZ(a),
    ];
    const cross = [
      ab[1] * ac[2] - ab[2] * ac[1],
      ab[2] * ac[0] - ab[0] * ac[2],
      ab[0] * ac[1] - ab[1] * ac[0],
    ];
    const dot = cross[0] * normals.getX(a) + cross[1] * normals.getY(a) + cross[2] * normals.getZ(a);
    assert.ok(dot > 0, `${label} group ${groupIndex} 的三角形绕序必须与法线同向`);
  }
}
