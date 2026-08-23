import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { MemoryV2 } from '../../../../../apps/minecraft-companion/src/bot/v2/infra/memory.js';
import { MemoryCatalog } from '../../../../../apps/minecraft-companion/src/bot/v2/memory/catalog.js';
import { EpisodeStore } from '../../../../../apps/minecraft-companion/src/bot/v2/memory/episode/episodeStore.js';
import { MemorySystem } from '../../../../../apps/minecraft-companion/src/bot/v2/memory/retrieval/memorySystem.js';
import { check, positionDistance } from '../checks.js';
import type { BenchmarkAdapter, CaseContext, CaseExecution, ExplicitPlaceCase } from '../types.js';

export class ExplicitPlaceBenchmarkAdapter implements BenchmarkAdapter<ExplicitPlaceCase> {
  readonly domain = 'explicit_place' as const;

  execute(testCase: ExplicitPlaceCase, context: CaseContext): CaseExecution {
    const started = Date.now();
    const dbPath = join(context.workDir, `${testCase.id}.memory.db`);
    const toolResult = executeRememberPlaceTool(dbPath, testCase);
    const immediateRows = toolResult.immediateRows;

    const reopened = new MemoryV2(dbPath);
    const persisted = reopened.query('spatial', { kind: testCase.expected.kind });
    const match = persisted.find(item => item.meta?.name === testCase.expected.name);
    const foreign = new MemoryV2(join(context.workDir, `${testCase.id}.foreign.db`));
    const leaked = foreign.query('spatial').length;
    foreign.close();

    const catalog = new MemoryCatalog(join(context.workDir, `${testCase.id}.catalog.db`));
    const episodes = new EpisodeStore(join(context.workDir, `${testCase.id}.episodes.db`));
    const unified = new MemorySystem('profile-a', catalog, episodes).deepRecall({ query: testCase.input.query, includeEvidence: true });
    const unifiedVisible = unified.records.some(item => item.kind === 'spatial') || unified.episodes.length > 0;
    catalog.close();
    episodes.close();
    reopened.close();

    const distance = match ? positionDistance(match.position, testCase.expected.position) : Number.POSITIVE_INFINITY;
    return {
      caseId: testCase.id,
      domain: this.domain,
      split: testCase.split,
      tags: testCase.tags,
      durationMs: Date.now() - started,
      checks: [
        check({ id: 'tool_write', passed: toolResult.ok === true && immediateRows === 1, expected: { ok: true, rows: 1 }, actual: { ok: toolResult.ok, rows: immediateRows }, weight: 15, critical: true, evidence: `remember_place=${JSON.stringify(toolResult.saved)}` }),
        check({ id: 'semantic_identity', passed: match?.kind === testCase.expected.kind && match?.meta?.name === testCase.expected.name, expected: { kind: testCase.expected.kind, name: testCase.expected.name }, actual: match ? { kind: match.kind, name: match.meta?.name } : null, weight: 15, critical: true, evidence: `spatialRows=${persisted.length}` }),
        check({ id: 'coordinate_accuracy', passed: distance <= testCase.expected.coordinateTolerance, expected: `distance<=${testCase.expected.coordinateTolerance}`, actual: distance, weight: 15, critical: true, evidence: `expected=${JSON.stringify(testCase.expected.position)} actual=${JSON.stringify(match?.position ?? null)}` }),
        check({ id: 'restart_durability', passed: Boolean(match), expected: true, actual: Boolean(match), weight: 15, critical: true, evidence: `reopenedRows=${persisted.length}`, kind: 'restart' }),
        check({ id: 'direct_recall', passed: persisted.length === 1, expected: 1, actual: persisted.length, weight: 10, evidence: `kind=${testCase.expected.kind}` }),
        check({ id: 'profile_isolation', passed: leaked === 0, expected: 0, actual: leaked, weight: 15, critical: true, evidence: `foreignDbRows=${leaked}`, kind: 'profile_isolation' }),
        check({ id: 'unified_immediate_recall', passed: unifiedVisible, expected: true, actual: unifiedVisible, weight: 15, critical: true, evidence: `records=${unified.records.length},episodes=${unified.episodes.length},gaps=${unified.gaps.join(';')}`, kind: 'unified_recall' }),
      ],
      trace: {
        productionPath: 'remember_place -> MemoryV2.spatial -> reopen -> MemorySystem.deepRecall',
        toolResult,
        immediateRows,
        persistedRows: persisted.length,
        unifiedTraceId: unified.traceId,
      },
    };
  }
}

function executeRememberPlaceTool(dbPath: string, testCase: ExplicitPlaceCase): { ok: boolean; saved: unknown; immediateRows: number } {
  const harness = fileURLToPath(new URL('./explicitPlaceToolHarness.mjs', import.meta.url));
  const result = spawnSync(process.execPath, ['--import', 'tsx/esm', harness, JSON.stringify({
    dbPath,
    kind: testCase.input.kind,
    name: testCase.input.name,
    position: testCase.input.position,
  })], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`remember_place harness failed: ${result.stderr.trim() || result.stdout.trim()}`);
  const line = result.stdout.trim().split(/\r?\n/).at(-1);
  if (!line) throw new Error('remember_place harness returned no result');
  return JSON.parse(line) as { ok: boolean; saved: unknown; immediateRows: number };
}
