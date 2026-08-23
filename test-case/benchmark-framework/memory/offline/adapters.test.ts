import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBenchmark } from '../../../../benchmark/memory/offline/src/loader.js';
import { ChatBenchmarkAdapter } from '../../../../benchmark/memory/offline/src/adapters/chatAdapter.js';
import { ExplicitPlaceBenchmarkAdapter } from '../../../../benchmark/memory/offline/src/adapters/explicitPlaceAdapter.js';
import { AutoDiscoveryBenchmarkAdapter } from '../../../../benchmark/memory/offline/src/adapters/autoDiscoveryAdapter.js';
import { EpisodeLocationBenchmarkAdapter } from '../../../../benchmark/memory/offline/src/adapters/episodeLocationAdapter.js';
import type { AutoDiscoveryCase, ChatBenchmarkCase, EpisodeLocationCase, ExplicitPlaceCase } from '../../../../benchmark/memory/offline/src/types.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../benchmark/memory/offline');
const cases = loadBenchmark(root, 'quick').cases;

describe('production memory benchmark adapters', () => {
  test('chat adapter labels answer as context evidence and preserves isolation', () => {
    const result = new ChatBenchmarkAdapter().execute(cases.find(item => item.domain === 'chat') as ChatBenchmarkCase);
    assert.equal(result.trace.metricBoundary, 'context_evidence_only_not_llm_answer');
    assert.equal(result.checks.find(item => item.id === 'profile_isolation')?.passed, true);
  });

  test('explicit place tests production write and exposes restart/unified recall gaps', () => withWorkDir(workDir => {
    const result = new ExplicitPlaceBenchmarkAdapter().execute(cases.find(item => item.domain === 'explicit_place') as ExplicitPlaceCase, { profile: 'quick', workDir });
    assert.equal(result.checks.find(item => item.id === 'tool_write')?.passed, true);
    assert.equal(result.checks.find(item => item.id === 'restart_durability')?.passed, false);
    assert.equal(result.checks.find(item => item.id === 'unified_immediate_recall')?.passed, false);
  }));

  test('automatic discovery uses production scanner and exposes restart gap', () => withWorkDir(workDir => {
    const result = new AutoDiscoveryBenchmarkAdapter().execute(cases.find(item => item.domain === 'auto_discovery') as AutoDiscoveryCase, { profile: 'quick', workDir });
    assert.equal(result.checks.find(item => item.id === 'automatic_capture')?.passed, true);
    assert.equal(result.checks.find(item => item.id === 'restart_durability')?.passed, false);
  }));

  test('episode deep recall works and weather completeness gap is visible', () => withWorkDir(workDir => {
    const result = new EpisodeLocationBenchmarkAdapter().execute(cases.find(item => item.domain === 'episode_location') as EpisodeLocationCase, { profile: 'quick', workDir });
    assert.equal(result.checks.find(item => item.id === 'deep_recall')?.passed, true);
    assert.equal(result.checks.find(item => item.id === 'environment_weather')?.passed, false);
  }));
});

function withWorkDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'memory-benchmark-test-'));
  try { run(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}
