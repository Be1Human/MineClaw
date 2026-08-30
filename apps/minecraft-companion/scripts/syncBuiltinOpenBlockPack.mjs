#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { strToU8, unzipSync, zipSync } from 'fflate';

const UPSTREAM = 'https://github.com/Love-and-Tolerance/Love-and-Tolerance';
const UPSTREAM_COMMIT = 'f36661473773dde88dcd4f3bc03ea0fbced17d28';
const ARCHIVE_URL = `https://codeload.github.com/Love-and-Tolerance/Love-and-Tolerance/zip/${UPSTREAM_COMMIT}`;
const MODEL_UPSTREAM = 'https://github.com/PrismarineJS/minecraft-assets';
const MODEL_UPSTREAM_COMMIT = '67c9b138b00a6b67c29ba68dae74c41faef4889d';
const MODEL_PACKAGE = 'https://github.com/PrismarineJS/node-minecraft-assets';
const MODEL_PACKAGE_COMMIT = '14b5ad06b8f2508168958bc72a3efb7962c9a89f';
const GAME_VERSION = '1.21.1';
const MODEL_DATA_BASE = `https://raw.githubusercontent.com/PrismarineJS/minecraft-assets/${MODEL_UPSTREAM_COMMIT}/data/${GAME_VERSION}`;
const MODEL_PACKAGE_URL = `https://raw.githubusercontent.com/PrismarineJS/node-minecraft-assets/${MODEL_PACKAGE_COMMIT}/package.json`;
const require = createRequire(import.meta.url);
const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputDir = resolve(appRoot, 'builtin-packs');
const outputPath = resolve(outputDir, 'mineclaw-open-blocks.zip');
const manifestPath = resolve(outputDir, 'mineclaw-open-blocks.manifest.json');
const allowedPrefixes = [
  'assets/minecraft/blockstates/',
  'assets/minecraft/models/block/',
  'assets/minecraft/textures/block/',
  'assets/minecraft/textures/item/',
];

const response = await fetch(ARCHIVE_URL);
if (!response.ok) throw new Error(`upstream download failed: ${response.status}`);
const upstreamArchive = new Uint8Array(await response.arrayBuffer());
const [blockStatesBytes, blockModelsBytes, modelPackageBytes] = await Promise.all([
  fetchBytes(`${MODEL_DATA_BASE}/blocks_states.json`),
  fetchBytes(`${MODEL_DATA_BASE}/blocks_models.json`),
  fetchBytes(MODEL_PACKAGE_URL),
]);
const upstreamFiles = unzipSync(upstreamArchive);
const selected = {};
let upstreamLicense = null;

for (const [rawPath, bytes] of Object.entries(upstreamFiles)) {
  const slash = rawPath.indexOf('/');
  if (slash < 0) continue;
  const relativePath = rawPath.slice(slash + 1);
  if (relativePath === 'LICENSE') upstreamLicense = bytes;
  if (allowedPrefixes.some(prefix => relativePath.startsWith(prefix)) && !relativePath.endsWith('/')) {
    selected[relativePath] = bytes;
  }
}

if (!upstreamLicense) throw new Error('upstream LICENSE is missing');
if (!selected['assets/minecraft/textures/block/stone.png']) {
  throw new Error('curated pack is missing the stone texture smoke-test asset');
}

const blockStates = JSON.parse(new TextDecoder().decode(blockStatesBytes));
const blockModels = JSON.parse(new TextDecoder().decode(blockModelsBytes));
const modelPackage = JSON.parse(new TextDecoder().decode(modelPackageBytes));
if (!blockStates.spruce_door || !blockStates.spruce_log || !blockModels.cube_all || !blockModels.leaves) {
  throw new Error('versioned model baseline is incomplete');
}
if (modelPackage.license !== 'MIT') throw new Error(`unexpected minecraft-assets package license: ${modelPackage.license}`);

const minecraftDataPackage = require('minecraft-data/package.json');
const minecraftData = require('minecraft-data')(GAME_VERSION);
if (!minecraftData?.tints?.grass || !minecraftData?.tints?.foliage || !minecraftData?.tints?.constant) {
  throw new Error(`minecraft-data ${GAME_VERSION} tint tables are missing`);
}

const baselineRoot = `assets/minecraft/mineclaw-baseline/${GAME_VERSION}`;
selected[`${baselineRoot}/blocks_states.json`] = blockStatesBytes;
selected[`${baselineRoot}/blocks_models.json`] = blockModelsBytes;
selected[`${baselineRoot}/tints.json`] = strToU8(JSON.stringify(minecraftData.tints));
selected['MINECRAFT-ASSETS-NOTICE.json'] = strToU8(JSON.stringify({
  package: modelPackage.name,
  packageVersion: modelPackage.version,
  declaredLicense: modelPackage.license,
  packageSource: MODEL_PACKAGE,
  packageCommit: MODEL_PACKAGE_COMMIT,
  dataSource: MODEL_UPSTREAM,
  dataCommit: MODEL_UPSTREAM_COMMIT,
  included: [`data/${GAME_VERSION}/blocks_states.json`, `data/${GAME_VERSION}/blocks_models.json`],
  excluded: ['textures', 'sounds', 'fonts', 'gui', 'entities', 'world data'],
}, null, 2));

const provenance = {
  name: 'MineClaw Open Blocks',
  source: UPSTREAM,
  sourceCommit: UPSTREAM_COMMIT,
  license: 'MIT',
  curatedAt: '2026-08-28',
  included: allowedPrefixes,
  excluded: ['music', 'sounds', 'font', 'gui', 'entity', 'item models', 'environment', 'Mojang textures'],
  modelBaseline: {
    source: MODEL_UPSTREAM,
    sourceCommit: MODEL_UPSTREAM_COMMIT,
    gameVersion: GAME_VERSION,
    files: ['blocks_states.json', 'blocks_models.json'],
    package: modelPackage.name,
    packageVersion: modelPackage.version,
    declaredLicense: modelPackage.license,
    packageSource: MODEL_PACKAGE,
    packageCommit: MODEL_PACKAGE_COMMIT,
  },
  tintBaseline: {
    package: 'minecraft-data',
    packageVersion: minecraftDataPackage.version,
    gameVersion: GAME_VERSION,
  },
};

selected['pack.mcmeta'] = strToU8(JSON.stringify({
  pack: { pack_format: 34, description: 'MineClaw Open Blocks · Love & Tolerance (MIT)' },
  mineclaw: { game_version: '1.21', model_game_version: GAME_VERSION, license: 'MIT' },
}, null, 2));
selected['LICENSE.txt'] = upstreamLicense;
selected['MINECLAW-PROVENANCE.json'] = strToU8(JSON.stringify(provenance, null, 2));

const stableEntries = Object.fromEntries(
  Object.entries(selected)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, bytes]) => [path, bytes]),
);
const builtArchive = zipSync(stableEntries, { level: 9, mtime: new Date('2026-01-01T00:00:00Z') });
const sha256 = createHash('sha256').update(builtArchive).digest('hex');
const manifest = {
  ...provenance,
  file: 'mineclaw-open-blocks.zip',
  sha256,
  archiveBytes: builtArchive.byteLength,
  entryCount: Object.keys(stableEntries).length,
};

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, builtArchive);
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(`wrote ${outputPath} (${builtArchive.byteLength} bytes, ${manifest.entryCount} entries, ${sha256})`);

async function fetchBytes(url) {
  const result = await fetch(url);
  if (!result.ok) throw new Error(`metadata download failed (${result.status}): ${url}`);
  return new Uint8Array(await result.arrayBuffer());
}
