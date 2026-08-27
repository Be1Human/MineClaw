const FACE_OFFSETS = {
  west: [-1, 0, 0], east: [1, 0, 0], down: [0, -1, 0], up: [0, 1, 0], north: [0, 0, -1], south: [0, 0, 1],
};

export function buildSectionMeshPayload({ section, paletteModels }) {
  const indices = asUint16(section.indices);
  const buckets = new Map();
  let renderedBlocks = 0;
  for (let y = 0; y < 16; y++) for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) {
    const blockIndex = (y * 16 + z) * 16 + x;
    const models = paletteModels[indices[blockIndex]] ?? [];
    if (!models.length) continue;
    renderedBlocks += 1;
    for (const model of models) appendModel(model, x, y, z, section, indices, paletteModels, buckets);
  }
  return {
    key: section.key,
    renderedBlocks,
    meshes: Array.from(buckets, ([materialKey, bucket]) => ({
      materialKey,
      positions: Float32Array.from(bucket.positions),
      normals: Float32Array.from(bucket.normals),
      uvs: Float32Array.from(bucket.uvs),
      indices: Uint32Array.from(bucket.indices),
    })),
  };
}

function appendModel(model, x, y, z, section, sectionIndices, paletteModels, buckets) {
  for (const group of model.groups) {
    if (group.direction && model.occluding && neighborOccludes(x, y, z, group.direction, sectionIndices, paletteModels)) continue;
    const materialKey = model.materialKeys[group.materialIndex] ?? 'mineclaw:missing';
    let bucket = buckets.get(materialKey);
    if (!bucket) {
      bucket = { positions: [], normals: [], uvs: [], indices: [] };
      buckets.set(materialKey, bucket);
    }
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
        const uv = sourceIndex * 2;
        bucket.uvs.push(model.uvs[uv], model.uvs[uv + 1]);
      }
      bucket.indices.push(targetIndex);
    }
  }
}

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
    const transfer = result.meshes.flatMap(mesh => [mesh.positions.buffer, mesh.normals.buffer, mesh.uvs.buffer, mesh.indices.buffer]);
    self.postMessage({ taskId: event.data.taskId, result }, transfer);
  };
}
