#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { strToU8, unzipSync, zipSync } from 'fflate';

const UPSTREAM = 'https://github.com/Love-and-Tolerance/Love-and-Tolerance';
const UPSTREAM_COMMIT = 'f36661473773dde88dcd4f3bc03ea0fbced17d28';
const ARCHIVE_URL = `https://codeload.github.com/Love-and-Tolerance/Love-and-Tolerance/zip/${UPSTREAM_COMMIT}`;
const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputDir = resolve(appRoot, 'builtin-packs');
const outputPath = resolve(outputDir, 'mineclaw-open-blocks.zip');
const manifestPath = resolve(outputDir, 'mineclaw-open-blocks.manifest.json');
const allowedPrefixes = [
  'assets/minecraft/blockstates/',
  'assets/minecraft/models/block/',
  'assets/minecraft/textures/block/',
];

const response = await fetch(ARCHIVE_URL);
if (!response.ok) throw new Error(`upstream download failed: ${response.status}`);
const upstreamArchive = new Uint8Array(await response.arrayBuffer());
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

const provenance = {
  name: 'MineClaw Open Blocks',
  source: UPSTREAM,
  sourceCommit: UPSTREAM_COMMIT,
  license: 'MIT',
  curatedAt: '2026-08-28',
  included: allowedPrefixes,
  excluded: ['music', 'sounds', 'font', 'gui', 'entity', 'item', 'environment'],
};

selected['pack.mcmeta'] = strToU8(JSON.stringify({
  pack: { pack_format: 34, description: 'MineClaw Open Blocks · Love & Tolerance (MIT)' },
  mineclaw: { game_version: '1.21', license: 'MIT' },
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
