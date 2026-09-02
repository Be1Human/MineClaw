#!/usr/bin/env node
/**
 * FEAT-CROSS-26-001-004-004 · legacy production-symbol deletion gate (P3-4).
 * Scans the v2 source tree for old production symbols that must be gone after
 * the one-shot migration (design §5.8/§5.10). The gate is fail-closed: any hit
 * in a scanned tree fails the process (CI), and generated artifacts must be
 * clean by default.
 *
 * Usage:
 *   node scripts/plugin-legacy-scan.mjs                 # source scan (report)
 *   node scripts/plugin-legacy-scan.mjs --artifacts     # generated artifacts scan
 *   node scripts/plugin-legacy-scan.mjs --fail          # exit non-zero on hits
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const source = join(root, 'src', 'bot', 'v2');

/** Old production identifiers that keep no production presence after migration (§5.8 table). */
export const LEGACY_SYMBOLS = [
  'createAgricultureCapabilityPackage',
  'harvest_mature_crops_to_chest',
  'mineclaw:mature_crops_to_chest',
  'agriculture.harvest_world',
  'agriculture.harvest_action_candidates',
  'agriculture.harvest_to_chest',
  'mineclaw/capability-manifest@1',
  'HarvestRunLedger',
  'createDefaultAtomicContractRegistry',
  'LegacyCandidateProvider',
];

/** Files that may legitimately reference legacy ids (docs/tests/migration fixtures). */
const ALLOWED_SUFFIX = [
  /\.test\.ts$/,
  /\.test\.mjs$/,
  /fixture/,
];

function collect(directory, relative = '') {
  const result = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const child = join(directory, entry.name);
    const rel = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) result.push(...collect(child, rel));
    else if (entry.isFile() && /\.(ts|mjs|js|json|yaml|md)$/.test(entry.name)) result.push(rel);
  }
  return result;
}

export function scanLegacyReferences({ rootDir = source } = {}) {
  const hits = [];
  for (const rel of collect(rootDir)) {
    const path = join(rootDir, rel);
    const content = readFileSync(path, 'utf8');
    for (const symbol of LEGACY_SYMBOLS) {
      if (content.includes(symbol)) hits.push({ file: rel, symbol, line: firstLine(content, symbol) });
    }
  }
  return hits;
}

export function scanGeneratedArtifacts({ artifacts = [join(root, 'src', 'bot', 'v2', 'plugin-kernel', 'builtin-manifest.generated.json')] } = {}) {
  const hits = [];
  for (const artifact of artifacts) {
    if (!existsSync(artifact)) continue;
    const content = readFileSync(artifact, 'utf8');
    for (const symbol of LEGACY_SYMBOLS) {
      if (content.includes(symbol)) hits.push({ file: artifact, symbol, line: 0 });
    }
  }
  return hits;
}

function firstLine(content, symbol) {
  return content.split('\n').findIndex(line => line.includes(symbol)) + 1;
}

function main() {
  const args = new Set(process.argv.slice(2));
  const artifactsOnly = args.has('--artifacts');
  const fail = args.has('--fail');
  const hits = artifactsOnly
    ? scanGeneratedArtifacts()
    : [...scanLegacyReferences(), ...scanGeneratedArtifacts()];
  const productionHits = hits.filter(hit => !ALLOWED_SUFFIX.some(pattern => pattern.test(hit.file)));
  console.log(`[legacy-scan] ${artifactsOnly ? 'generated artifacts' : 'source+artifacts'}: ${productionHits.length} production hit(s)`);
  for (const hit of productionHits) console.log(`  - ${hit.file}:${hit.line}  ${hit.symbol}`);
  if (fail && productionHits.length > 0) process.exitCode = 1;
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('plugin-legacy-scan.mjs')) main();
