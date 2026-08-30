const FACE_OFFSETS = {
  west: [-1, 0, 0], east: [1, 0, 0], down: [0, -1, 0], up: [0, 1, 0], north: [0, 0, -1], south: [0, 0, 1],
};

export function buildSectionMeshPayload({ section, paletteModels, tintData = {} }) {
  const indices = asUint16(section.indices);
  const biomeIndices = asUint16(section.biomeIndices);
  const tintLookup = prepareTintLookup(tintData);
  const buckets = new Map();
  let renderedBlocks = 0;
  for (let y = 0; y < 16; y++) for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) {
    const blockIndex = (y * 16 + z) * 16 + x;
    const models = paletteModels[indices[blockIndex]] ?? [];
    if (!models.length) continue;
    renderedBlocks += 1;
    for (const model of models) appendModel(model, x, y, z, blockIndex, section, indices, biomeIndices, paletteModels, tintLookup, buckets);
  }
  return {
    key: section.key,
    renderedBlocks,
    meshes: Array.from(buckets, ([materialKey, bucket]) => ({
      materialKey,
      positions: Float32Array.from(bucket.positions),
      normals: Float32Array.from(bucket.normals),
      colors: Float32Array.from(bucket.colors),
      uvs: Float32Array.from(bucket.uvs),
      indices: Uint32Array.from(bucket.indices),
    })),
  };
}

function appendModel(model, x, y, z, blockIndex, section, sectionIndices, biomeIndices, paletteModels, tintLookup, buckets) {
  for (const group of model.groups) {
    if (group.direction && model.occluding && neighborOccludes(x, y, z, group.direction, sectionIndices, paletteModels)) continue;
    const materialKey = model.materialKeys[group.materialIndex] ?? 'mineclaw:missing';
    let bucket = buckets.get(materialKey);
    if (!bucket) {
      bucket = { positions: [], normals: [], colors: [], uvs: [], indices: [] };
      buckets.set(materialKey, bucket);
    }
    const tint = tintFor(model, group, section, biomeIndices, blockIndex, tintLookup);
    const remap = new Map();
    for (let offset = group.start; offset < group.start + group.count; offset++) {
      const sourceIndex = model.indices[offset];
      let targetIndex = remap.get(sourceIndex);
      if (targetIndex === undefined) {
        targetIndex = bucket.positions.length / 3;
        remap.set(sourceIndex, targetIndex);
        const p = sourceIndex * 3;
        bucket.positions.push(
          model.positions[p] + section.chunkX * 16 + x + 0.5,
          model.positions[p + 1] + section.sectionY * 16 + y + 0.5,
          model.positions[p + 2] + section.chunkZ * 16 + z + 0.5,
        );
        bucket.normals.push(model.normals[p], model.normals[p + 1], model.normals[p + 2]);
        bucket.colors.push(tint[0], tint[1], tint[2]);
        const uv = sourceIndex * 2;
        bucket.uvs.push(model.uvs[uv], model.uvs[uv + 1]);
      }
      bucket.indices.push(targetIndex);
    }
  }
}

function prepareTintLookup(tintData) {
  return Object.fromEntries(Object.entries(tintData ?? {}).map(([kind, definition]) => {
    const values = new Map();
    for (const entry of definition?.data ?? []) {
      const color = Number(entry.color);
      for (const key of entry.keys ?? []) values.set(String(key), color);
    }
    return [kind, values];
  }));
}

function tintFor(model, group, section, biomeIndices, blockIndex, lookup) {
  if (group.tintIndex === null || group.tintIndex === undefined) return [1, 1, 1];
  const name = String(model.blockName ?? '').replace(/^minecraft:/, '');
  const constant = lookup.constant?.get(name);
  if (Number.isFinite(constant)) return colorToRgb(constant);
  if (name === 'redstone_wire') return lookupColor(lookup.redstone, model.properties?.power, DEFAULT_TINT.redstone);
  const biomeIndex = biomeIndices[blockIndex] ?? 0;
  const biomeName = section.biomePalette?.[biomeIndex]?.name ?? 'plains';
  if (name === 'water') return lookupColor(lookup.water, biomeName, DEFAULT_TINT.water);
  if (name.includes('leaves') || name === 'vine') return lookupColor(lookup.foliage, biomeName, DEFAULT_TINT.foliage);
  return lookupColor(lookup.grass, biomeName, DEFAULT_TINT.grass);
}

function lookupColor(map, key, fallback) {
  const color = map?.get(String(key));
  return colorToRgb(Number.isFinite(color) && color !== 0 ? color : fallback);
}

function colorToRgb(color) {
  const value = Number(color) >>> 0;
  return [((value >> 16) & 0xff) / 255, ((value >> 8) & 0xff) / 255, (value & 0xff) / 255];
}

const DEFAULT_TINT = {
  grass: 0x91bd59,
  foliage: 0x77ab2f,
  water: 0x3f76e4,
  redstone: 0xff0000,
};

function neighborOccludes(x, y, z, direction, indices, paletteModels) {
  const offset = FACE_OFFSETS[direction];
  const nx = x + offset[0], ny = y + offset[1], nz = z + offset[2];
  if (nx < 0 || nx > 15 || ny < 0 || ny > 15 || nz < 0 || nz > 15) return false;
  const paletteIndex = indices[(ny * 16 + nz) * 16 + nx];
  return (paletteModels[paletteIndex] ?? []).some(model => model.occluding);
}

function asUint16(value) {
  if (value instanceof Uint16Array) return value;
  if (value instanceof ArrayBuffer) return new Uint16Array(value);
  if (ArrayBuffer.isView(value)) return new Uint16Array(value.buffer, value.byteOffset, value.byteLength / 2);
  return Uint16Array.from(value ?? []);
}

if (typeof self !== 'undefined' && typeof self.postMessage === 'function') {
  self.onmessage = event => {
    const result = buildSectionMeshPayload(event.data.payload);
    const transfer = result.meshes.flatMap(mesh => [mesh.positions.buffer, mesh.normals.buffer, mesh.colors.buffer, mesh.uvs.buffer, mesh.indices.buffer]);
    self.postMessage({ taskId: event.data.taskId, result }, transfer);
  };
}
