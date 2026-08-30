import * as THREE from 'three';

const DIRECTIONS = {
  west:  { normal: [-1, 0, 0], reverseWinding: true, corners: (f, t) => [[f[0], f[1], t[2]], [f[0], f[1], f[2]], [f[0], t[1], f[2]], [f[0], t[1], t[2]]] },
  east:  { normal: [1, 0, 0], reverseWinding: true, corners: (f, t) => [[t[0], f[1], f[2]], [t[0], f[1], t[2]], [t[0], t[1], t[2]], [t[0], t[1], f[2]]] },
  down:  { normal: [0, -1, 0], corners: (f, t) => [[f[0], f[1], f[2]], [t[0], f[1], f[2]], [t[0], f[1], t[2]], [f[0], f[1], t[2]]] },
  up:    { normal: [0, 1, 0], corners: (f, t) => [[f[0], t[1], t[2]], [t[0], t[1], t[2]], [t[0], t[1], f[2]], [f[0], t[1], f[2]]] },
  north: { normal: [0, 0, -1], corners: (f, t) => [[t[0], f[1], f[2]], [f[0], f[1], f[2]], [f[0], t[1], f[2]], [t[0], t[1], f[2]]] },
  south: { normal: [0, 0, 1], corners: (f, t) => [[f[0], f[1], t[2]], [t[0], f[1], t[2]], [t[0], t[1], t[2]], [f[0], t[1], t[2]]] },
};

/** 根据方块属性解析 vanilla variants / multipart，返回待烘焙的模型应用。 */
export function selectBlockModelApplications(blockState, properties = {}, random = 0) {
  const applications = [];
  if (blockState?.variants && typeof blockState.variants === 'object') {
    const match = Object.entries(blockState.variants).find(([key]) => variantMatches(key, properties));
    if (match) applications.push(pickWeighted(match[1], random));
  }
  if (Array.isArray(blockState?.multipart)) {
    for (const part of blockState.multipart) {
      if (!part?.when || conditionMatches(part.when, properties)) applications.push(pickWeighted(part.apply, random));
    }
  }
  return applications.filter(Boolean);
}

/** 合并模型 parent 链。子模型 textures 会覆盖父模型，elements 存在时整体覆盖。 */
export async function resolveMinecraftModel(modelName, loadModel, stack = []) {
  if (stack.includes(modelName) || stack.length > 32) throw new Error(`cyclic Minecraft model parent: ${[...stack, modelName].join(' -> ')}`);
  const model = await loadModel(modelName);
  if (!model || typeof model !== 'object') throw new Error(`Minecraft model not found: ${modelName}`);
  if (!model.parent) return { ...model, textures: { ...(model.textures ?? {}) } };
  const parent = await resolveMinecraftModel(model.parent, loadModel, [...stack, modelName]);
  return {
    ...parent,
    ...model,
    textures: { ...(parent.textures ?? {}), ...(model.textures ?? {}) },
    elements: model.elements ?? parent.elements,
  };
}

/** 将 Minecraft JSON block model 烘焙为单个 BufferGeometry；材质序号映射在 materialKeys。 */
export function bakeMinecraftBlockModel(model, application = {}, options = {}) {
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];
  const materialKeys = [];
  const materialIndex = new Map();
  const geometry = new THREE.BufferGeometry();
  const faceDirections = [];
  const faceTintIndices = [];
  let transparent = false;

  for (const element of model?.elements ?? []) {
    const from = vector3(element.from, [0, 0, 0]);
    const to = vector3(element.to, [16, 16, 16]);
    for (const [direction, face] of Object.entries(element.faces ?? {})) {
      const definition = DIRECTIONS[direction];
      if (!definition || !face || typeof face !== 'object') continue;
      const texture = resolveTexture(face.texture, model.textures ?? {});
      let slot = materialIndex.get(texture);
      if (slot === undefined) {
        slot = materialKeys.length;
        materialIndex.set(texture, slot);
        materialKeys.push(texture);
        if (options.isTextureTransparent?.(texture)) transparent = true;
      }

      const vertexOffset = positions.length / 3;
      const corners = definition.corners(from, to);
      const transformedCorners = corners.map(corner => transformPoint(corner, element.rotation, application));
      for (const point of transformedCorners) {
        positions.push(point.x, point.y, point.z);
        const normal = transformNormal(definition.normal, element.rotation, application);
        normals.push(normal.x, normal.y, normal.z);
      }
      const rawUv = face.uv ?? defaultFaceUv(direction, from, to);
      uvs.push(...(application.uvlock
        ? lockedFaceUvs(transformedCorners, transformedDirection(direction, application), face.rotation)
        : faceUvs(rawUv, face.rotation)));
      const faceIndices = definition.reverseWinding
        ? [0, 2, 1, 0, 3, 2]
        : [0, 1, 2, 0, 2, 3];
      indices.push(...faceIndices.map(index => vertexOffset + index));
      geometry.addGroup(indices.length - 6, 6, slot);
      faceDirections.push(face.cullface ? transformedDirection(face.cullface, application) : null);
      faceTintIndices.push(Number.isInteger(face.tintindex) ? face.tintindex : null);
    }
  }

  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  geometry.userData.materialKeys = materialKeys;
  geometry.userData.transparent = transparent;
  geometry.userData.faceDirections = faceDirections;
  geometry.userData.faceTintIndices = faceTintIndices;
  return { geometry, materialKeys, transparent };
}

function variantMatches(key, properties) {
  if (!key) return true;
  return key.split(',').every(entry => {
    const [name, expected = ''] = entry.split('=');
    return String(properties[name]) === expected;
  });
}

function conditionMatches(condition, properties) {
  if (Array.isArray(condition.OR)) return condition.OR.some(item => conditionMatches(item, properties));
  return Object.entries(condition).every(([name, expected]) => {
    if (name === 'OR') return true;
    return String(expected).split('|').includes(String(properties[name]));
  });
}

function pickWeighted(value, random) {
  if (!Array.isArray(value)) return value;
  const total = value.reduce((sum, item) => sum + Math.max(1, Number(item?.weight) || 1), 0);
  let cursor = Math.min(Math.max(random, 0), 0.999999) * total;
  for (const item of value) {
    cursor -= Math.max(1, Number(item?.weight) || 1);
    if (cursor < 0) return item;
  }
  return value.at(-1);
}

function resolveTexture(reference, textures) {
  let current = typeof reference === 'string' ? reference : 'minecraft:missingno';
  const seen = new Set();
  while (current.startsWith('#')) {
    const key = current.slice(1);
    if (seen.has(key)) return 'minecraft:missingno';
    seen.add(key);
    current = typeof textures[key] === 'string' ? textures[key] : 'minecraft:missingno';
  }
  return current.includes(':') ? current : `minecraft:${current}`;
}

function vector3(value, fallback) {
  return Array.isArray(value) && value.length === 3 ? value.map(Number) : fallback;
}

function transformPoint(raw, elementRotation, application) {
  const point = new THREE.Vector3(...raw).multiplyScalar(1 / 16).subScalar(0.5);
  if (elementRotation?.axis && Number.isFinite(elementRotation.angle)) {
    const origin = new THREE.Vector3(...vector3(elementRotation.origin, [8, 8, 8])).multiplyScalar(1 / 16).subScalar(0.5);
    point.sub(origin);
    point.applyAxisAngle(axisVector(elementRotation.axis), THREE.MathUtils.degToRad(elementRotation.angle));
    point.add(origin);
  }
  applyApplicationRotation(point, application);
  return point;
}

function transformNormal(raw, elementRotation, application) {
  const normal = new THREE.Vector3(...raw);
  if (elementRotation?.axis && Number.isFinite(elementRotation.angle)) {
    normal.applyAxisAngle(axisVector(elementRotation.axis), THREE.MathUtils.degToRad(elementRotation.angle));
  }
  applyApplicationRotation(normal, application);
  return normal.normalize();
}

function applyApplicationRotation(vector, application) {
  if (application.x) vector.applyAxisAngle(new THREE.Vector3(1, 0, 0), THREE.MathUtils.degToRad(-Number(application.x)));
  if (application.y) vector.applyAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(-Number(application.y)));
  if (application.z) vector.applyAxisAngle(new THREE.Vector3(0, 0, 1), THREE.MathUtils.degToRad(-Number(application.z)));
}

function axisVector(axis) {
  if (axis === 'x') return new THREE.Vector3(1, 0, 0);
  if (axis === 'y') return new THREE.Vector3(0, 1, 0);
  return new THREE.Vector3(0, 0, 1);
}

function faceUvs(rawUv, rotation = 0) {
  const uv = Array.isArray(rawUv) && rawUv.length === 4 ? rawUv.map(Number) : [0, 0, 16, 16];
  const corners = [[uv[0], uv[3]], [uv[2], uv[3]], [uv[2], uv[1]], [uv[0], uv[1]]]
    .map(([u, v]) => [u / 16, 1 - v / 16]);
  const turns = (((Number(rotation) || 0) / 90) % 4 + 4) % 4;
  for (let i = 0; i < turns; i++) corners.unshift(corners.pop());
  return corners.flat();
}

function defaultFaceUv(direction, from, to) {
  switch (direction) {
    case 'down': return [from[0], 16 - to[2], to[0], 16 - from[2]];
    case 'up': return [from[0], from[2], to[0], to[2]];
    case 'north': return [16 - to[0], 16 - to[1], 16 - from[0], 16 - from[1]];
    case 'south': return [from[0], 16 - to[1], to[0], 16 - from[1]];
    case 'west': return [16 - to[2], 16 - to[1], 16 - from[2], 16 - from[1]];
    case 'east': return [from[2], 16 - to[1], to[2], 16 - from[1]];
    default: return [0, 0, 16, 16];
  }
}

function lockedFaceUvs(points, direction, rotation = 0) {
  const radians = THREE.MathUtils.degToRad(Number(rotation) || 0);
  const cos = Math.cos(radians);
  const sin = -Math.sin(radians);
  return points.flatMap(point => {
    const [rawU, rawV] = projectUv(direction, point);
    const centeredU = rawU - 8;
    const centeredV = rawV - 8;
    const u = centeredU * cos - centeredV * sin + 8;
    const v = centeredU * sin + centeredV * cos + 8;
    return [u / 16, 1 - v / 16];
  });
}

function projectUv(direction, centeredPoint) {
  const x = (centeredPoint.x + 0.5) * 16;
  const y = (centeredPoint.y + 0.5) * 16;
  const z = (centeredPoint.z + 0.5) * 16;
  switch (direction) {
    case 'down': return [x, 16 - z];
    case 'up': return [x, z];
    case 'north': return [16 - x, 16 - y];
    case 'south': return [x, 16 - y];
    case 'west': return [16 - z, 16 - y];
    case 'east': return [z, 16 - y];
    default: return [x, 16 - y];
  }
}

function transformedDirection(direction, application) {
  const definition = DIRECTIONS[direction];
  if (!definition) return null;
  const normal = new THREE.Vector3(...definition.normal);
  applyApplicationRotation(normal, application);
  const axes = [
    ['west', -normal.x], ['east', normal.x],
    ['down', -normal.y], ['up', normal.y],
    ['north', -normal.z], ['south', normal.z],
  ];
  axes.sort((left, right) => right[1] - left[1]);
  return axes[0][1] > 0.999 ? axes[0][0] : null;
}
