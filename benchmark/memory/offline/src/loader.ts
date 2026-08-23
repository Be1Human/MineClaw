import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mineClawZhCases } from '../../shared/datasets.js';
import type { BenchmarkConfig, BenchmarkManifest, BenchmarkProfile, UnifiedBenchmarkCase, BenchmarkDomain, ChatBenchmarkCase } from './types.js';

export interface LoadedBenchmark {
  config: BenchmarkConfig;
  manifest: BenchmarkManifest;
  cases: UnifiedBenchmarkCase[];
  configSha256: string;
  datasetSha256: string;
}

export function loadBenchmark(root: string, profile: BenchmarkProfile): LoadedBenchmark {
  const configPath = join(root, 'benchmark.config.json');
  const manifestPath = join(root, 'datasets', 'manifest.json');
  const locationPath = join(root, 'datasets', 'location-cases.json');
  const configText = readFileSync(configPath, 'utf8');
  const manifestText = readFileSync(manifestPath, 'utf8');
  const locationText = readFileSync(locationPath, 'utf8');
  const config = JSON.parse(configText) as BenchmarkConfig;
  const manifest = JSON.parse(manifestText) as BenchmarkManifest;
  validateConfig(config);
  validateManifest(manifest);
  const profileConfig = config.profiles[profile];
  if (!profileConfig) throw new Error(`unknown benchmark profile: ${profile}`);
  const location = JSON.parse(locationText) as { schemaVersion?: string; cases?: UnifiedBenchmarkCase[] };
  if (location.schemaVersion !== 'mineclaw-location-memory-cases/v1' || !Array.isArray(location.cases)) throw new Error('invalid location dataset schema');
  const chat = selectChatCases(profileConfig.chatCaseLimit).map<ChatBenchmarkCase>(legacyCase => ({
    id: `chat-${legacyCase.id}`,
    domain: 'chat',
    split: legacyCase.split,
    critical: legacyCase.category === 'isolation' || legacyCase.category === 'security',
    tags: [legacyCase.category, legacyCase.questionType ?? 'general'],
    legacyCase,
  }));
  const cases = [...chat, ...location.cases]
    .filter(item => profileConfig.includeDomains.includes(item.domain))
    .filter(item => profileConfig.includeSplits.includes(item.split));
  validateCases(cases, manifest.requiredDomains);
  return {
    config,
    manifest,
    cases,
    configSha256: sha256(configText),
    datasetSha256: sha256(`${manifestText}\n${locationText}\n${mineClawZhCases().map(item => item.id).join('\n')}`),
  };
}

function selectChatCases(limit: number | null) {
  const all = mineClawZhCases();
  if (limit == null) return all;
  const firstPerCategory = [...new Map(all.map(item => [item.category, item])).values()];
  if (limit <= firstPerCategory.length) return firstPerCategory.slice(0, limit);
  const selected = [...firstPerCategory];
  for (const item of all) {
    if (selected.includes(item)) continue;
    selected.push(item);
    if (selected.length >= limit) break;
  }
  return selected;
}

function validateConfig(config: BenchmarkConfig): void {
  if (config.schemaVersion !== 'mineclaw-memory-benchmark-config/v1') throw new Error('invalid benchmark config schema');
  const weight = Object.values(config.domainWeights).reduce((sum, item) => sum + item, 0);
  if (Math.abs(weight - 1) > 1e-9) throw new Error(`domain weights must sum to 1, got ${weight}`);
}

function validateManifest(manifest: BenchmarkManifest): void {
  if (manifest.schemaVersion !== 'mineclaw-memory-benchmark-manifest/v1') throw new Error('invalid benchmark manifest schema');
  if (new Set(manifest.requiredDomains).size !== manifest.requiredDomains.length) throw new Error('duplicate required domain');
  if (new Set(manifest.sources.map(item => item.id)).size !== manifest.sources.length) throw new Error('duplicate dataset source id');
}

function validateCases(cases: UnifiedBenchmarkCase[], requiredDomains: BenchmarkDomain[]): void {
  const ids = new Set<string>();
  for (const item of cases) {
    if (!item.id || ids.has(item.id)) throw new Error(`duplicate or empty case id: ${item.id}`);
    ids.add(item.id);
    if (!requiredDomains.includes(item.domain)) throw new Error(`unknown case domain: ${item.domain}`);
    if (!Array.isArray(item.tags)) throw new Error(`case tags missing: ${item.id}`);
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
