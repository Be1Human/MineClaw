#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const options = parseArgs(process.argv.slice(2));
const suiteRoot = resolve(repoRoot, 'benchmark', 'capability', options.suite);
const catalogPath = resolve(suiteRoot, 'catalog.json');
const fixtureRoot = resolve(suiteRoot, 'fixtures');
const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
const cases = options.profile === 'canary' ? catalog.cases.slice(0, 1) : catalog.cases;
validateCatalog(catalog, cases, fixtureRoot);

if (options.list) {
  for (const item of catalog.cases) console.log(`${item.id}\t${item.fixture}\t${item.instruction}`);
} else if (options.preflight) {
  const report = {
    schemaVersion: 'mineclaw-capability-preflight/v1',
    suite: options.suite,
    profile: options.profile,
    generatedAt: new Date().toISOString(),
    outcome: 'preflight-passed',
    capabilityPassed: null,
    cases: cases.map(item => ({ id: item.id, fixture: item.fixture, ready: true })),
    note: 'This checks catalog and fixture integrity only. It is not capability evidence.',
  };
  const reportDir = resolve(repoRoot, 'benchmark', 'reports', 'capability');
  mkdirSync(reportDir, { recursive: true });
  const reportPath = resolve(reportDir, `${options.suite}-${options.profile}-preflight-${Date.now()}.json`);
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ ...report, reportPath }, null, 2));
} else {
  throw new Error('能力 Benchmark 必须在真服闭环中执行；仅检查配置请显式传入 --preflight，不能把预检当作能力通过');
}

function parseArgs(argv) {
  const values = { suite: '', profile: 'canary', preflight: false, list: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--suite') values.suite = argv[++index];
    else if (token === '--profile') values.profile = argv[++index];
    else if (token === '--preflight') values.preflight = true;
    else if (token === '--list') values.list = true;
    else throw new Error(`Unknown argument: ${token}`);
  }
  if (!['short', 'combat-survival'].includes(values.suite)) throw new Error('--suite must be short or combat-survival');
  if (!['canary', 'full'].includes(values.profile)) throw new Error('--profile must be canary or full');
  return values;
}

function validateCatalog(value, selected, root) {
  if (value.schemaVersion !== 'mineclaw-capability-catalog/v1') throw new Error('Invalid capability catalog schema');
  if (value.suite !== options.suite || !Array.isArray(value.cases) || value.cases.length === 0) throw new Error('Invalid capability catalog');
  const ids = new Set();
  for (const item of selected) {
    if (!item.id || ids.has(item.id) || !item.fixture || !item.instruction || !item.gate) throw new Error(`Invalid capability case: ${item.id ?? 'unknown'}`);
    ids.add(item.id);
    const path = resolve(root, item.fixture);
    if (!path.startsWith(`${root}/`) || !existsSync(path)) throw new Error(`Missing capability fixture: ${item.fixture}`);
    const fixture = JSON.parse(readFileSync(path, 'utf8'));
    if (!fixture.id || (!Array.isArray(fixture.commands) && !Array.isArray(fixture.setupCommands))) throw new Error(`Invalid capability fixture: ${item.fixture}`);
    if (options.suite === 'short' && !String(fixture.description).includes(item.id)) throw new Error(`${item.fixture} does not declare ${item.id}`);
  }
}
