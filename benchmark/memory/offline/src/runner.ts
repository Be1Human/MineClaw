import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { ChatBenchmarkAdapter } from './adapters/chatAdapter.js';
import { ExplicitPlaceBenchmarkAdapter } from './adapters/explicitPlaceAdapter.js';
import { AutoDiscoveryBenchmarkAdapter } from './adapters/autoDiscoveryAdapter.js';
import { EpisodeLocationBenchmarkAdapter } from './adapters/episodeLocationAdapter.js';
import { check } from './checks.js';
import { loadBenchmark } from './loader.js';
import { BenchmarkAdapterRegistry } from './registry.js';
import { writeBenchmarkReport } from './report.js';
import { scoreBenchmark, scoreCase } from './scoring.js';
import type { BenchmarkProfile, BenchmarkReport, CaseExecution, UnifiedBenchmarkCase } from './types.js';

export async function runBenchmark(options: {
  root?: string;
  profile?: BenchmarkProfile;
  reportDir?: string;
} = {}): Promise<{ report: BenchmarkReport; jsonPath: string; markdownPath: string }> {
  const root = options.root ?? dirname(dirname(fileURLToPath(import.meta.url)));
  const profile = options.profile ?? 'quick';
  const loaded = loadBenchmark(root, profile);
  const profileConfig = loaded.config.profiles[profile];
  const registry = new BenchmarkAdapterRegistry()
    .register(new ChatBenchmarkAdapter())
    .register(new ExplicitPlaceBenchmarkAdapter())
    .register(new AutoDiscoveryBenchmarkAdapter())
    .register(new EpisodeLocationBenchmarkAdapter());
  for (const domain of profileConfig.includeDomains) registry.get(domain);

  const startedAt = new Date().toISOString();
  const executions: CaseExecution[] = [];
  for (const testCase of loaded.cases) {
    const workDir = mkdtempSync(join(tmpdir(), `mineclaw-memory-benchmark-${safeName(testCase.id)}-`));
    try {
      executions.push(await registry.get(testCase.domain).execute(testCase, { profile, workDir }));
    } catch (error) {
      executions.push(executionFailure(testCase, error));
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  }
  const cases = executions.map(scoreCase);
  const score = scoreBenchmark(cases, loaded.config, loaded.manifest);
  const runId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const report: BenchmarkReport = {
    schemaVersion: 'mineclaw-memory-benchmark-report/v1',
    benchmarkVersion: loaded.config.benchmarkVersion,
    datasetVersion: loaded.manifest.datasetVersion,
    datasetSha256: loaded.datasetSha256,
    configSha256: loaded.configSha256,
    runId,
    profile,
    gitCommit: gitCommit(root),
    startedAt,
    completedAt: new Date().toISOString(),
    externalLlmRequests: 0,
    score,
    cases,
  };
  const output = writeBenchmarkReport(report, options.reportDir ?? resolve(root, '..', '..', 'reports', 'memory'));
  return { report, ...output };
}

function executionFailure(testCase: UnifiedBenchmarkCase, error: unknown): CaseExecution {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  return {
    caseId: testCase.id,
    domain: testCase.domain,
    split: testCase.split,
    tags: testCase.tags,
    durationMs: 0,
    checks: [check({ id: 'adapter_execution', passed: false, expected: 'completed', actual: message, critical: true, weight: 1, evidence: message })],
    trace: { error: message },
  };
}

function gitCommit(root: string): string {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : 'unknown';
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 50);
}

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const profile = (argValue('--profile') ?? 'quick') as BenchmarkProfile;
  if (!['quick', 'full'].includes(profile)) throw new Error(`unsupported profile: ${profile}`);
  const output = await runBenchmark({ profile, reportDir: argValue('--report-dir') });
  console.log(JSON.stringify({
    passed: output.report.score.passed,
    totalScore: output.report.score.totalScore,
    cases: output.report.cases.length,
    domains: output.report.score.domains,
    gates: output.report.score.gates,
    externalLlmRequests: output.report.externalLlmRequests,
    jsonReport: output.jsonPath,
    markdownReport: output.markdownPath,
  }, null, 2));
  if (!output.report.score.passed && !process.argv.includes('--allow-gate-fail')) process.exitCode = 1;
}
