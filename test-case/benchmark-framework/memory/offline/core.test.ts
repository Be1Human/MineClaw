import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BenchmarkAdapterRegistry } from '../../../../benchmark/memory/offline/src/registry.js';
import { loadBenchmark } from '../../../../benchmark/memory/offline/src/loader.js';
import { scoreBenchmark, scoreCase } from '../../../../benchmark/memory/offline/src/scoring.js';
import { check } from '../../../../benchmark/memory/offline/src/checks.js';
import type { BenchmarkConfig, BenchmarkManifest, CaseExecution } from '../../../../benchmark/memory/offline/src/types.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../benchmark/memory/offline');

describe('memory benchmark core', () => {
  test('loads versioned quick/full suites with every required domain', () => {
    const quick = loadBenchmark(root, 'quick');
    const full = loadBenchmark(root, 'full');
    assert.equal(quick.cases.length, 20);
    assert.equal(full.cases.length, 141);
    assert.deepEqual(new Set(quick.cases.map(item => item.domain)), new Set(quick.manifest.requiredDomains));
    assert.equal(quick.configSha256.length, 64);
    assert.equal(quick.datasetSha256.length, 64);
  });

  test('registry rejects accidental adapter replacement', () => {
    const adapter = { domain: 'chat' as const, execute: () => execution(true) };
    const registry = new BenchmarkAdapterRegistry().register(adapter);
    assert.equal(registry.get('chat'), adapter);
    assert.throws(() => registry.register(adapter), /duplicate benchmark adapter/);
  });

  test('critical failure cannot be hidden by a high weighted score', () => {
    const scored = scoreCase({
      ...execution(true),
      checks: [
        check({ id: 'large', passed: true, expected: true, actual: true, weight: 99, evidence: 'ok' }),
        check({ id: 'critical', passed: false, expected: true, actual: false, weight: 1, critical: true, evidence: 'failed' }),
      ],
    });
    const score = scoreBenchmark([scored], config(), manifest(['chat']));
    assert.equal(scored.score, 0.99);
    assert.equal(score.passed, false);
    assert.equal(score.gates.find(item => item.id === 'critical_checks')?.passed, false);
  });

  test('profile leak is an independent hard gate', () => {
    const scored = scoreCase({
      ...execution(true),
      checks: [check({ id: 'profile_isolation', kind: 'profile_isolation', passed: false, expected: 0, actual: 1, weight: 1, evidence: 'foreign row' })],
    });
    const score = scoreBenchmark([scored], config(), manifest(['chat']));
    assert.equal(score.profileLeakRate, 1);
    assert.equal(score.gates.find(item => item.id === 'profile_isolation')?.passed, false);
  });
});

function execution(passed: boolean): CaseExecution {
  return {
    caseId: 'fixture', domain: 'chat', split: 'test', tags: [], durationMs: 1, trace: {},
    checks: [check({ id: 'fixture', passed, expected: true, actual: passed, weight: 1, evidence: 'fixture' })],
  };
}

function config(): BenchmarkConfig {
  const loaded = loadBenchmark(root, 'quick').config;
  return { ...loaded, domainWeights: { chat: 1, explicit_place: 0, auto_discovery: 0, episode_location: 0 }, gates: { ...loaded.gates, minimumRestartPassRate: 0, requireAllDomains: false } };
}

function manifest(requiredDomains: BenchmarkManifest['requiredDomains']): BenchmarkManifest {
  return { schemaVersion: 'mineclaw-memory-benchmark-manifest/v1', datasetVersion: 'test', name: 'test', requiredDomains, sources: [] };
}
