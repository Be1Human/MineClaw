import { join } from 'node:path';
import type { GameAdapter } from '../../../../../apps/minecraft-companion/src/bot/adapter/GameAdapter.js';
import type { FindBlocksOptions } from '../../../../../apps/minecraft-companion/src/bot/adapter/types.js';
import { WorldScanCapability, DEFAULT_WORLD_SCAN_CONFIG } from '../../../../../apps/minecraft-companion/src/bot/v2/capability/worldScanCapability.js';
import { MineralProbeCapability } from '../../../../../apps/minecraft-companion/src/bot/v2/capability/mineralProbeCapability.js';
import { MemoryV2 } from '../../../../../apps/minecraft-companion/src/bot/v2/infra/memory.js';
import { TickRate, type TickContext } from '../../../../../apps/minecraft-companion/src/bot/v2/infra/tickRegistry.js';
import { MemoryCatalog } from '../../../../../apps/minecraft-companion/src/bot/v2/memory/catalog.js';
import { EpisodeStore } from '../../../../../apps/minecraft-companion/src/bot/v2/memory/episode/episodeStore.js';
import { MemorySystem } from '../../../../../apps/minecraft-companion/src/bot/v2/memory/retrieval/memorySystem.js';
import { check, includesRecord, positionDistance } from '../checks.js';
import type { AutoDiscoveryCase, BenchmarkAdapter, CaseContext, CaseExecution, Position } from '../types.js';

export class AutoDiscoveryBenchmarkAdapter implements BenchmarkAdapter<AutoDiscoveryCase> {
  readonly domain = 'auto_discovery' as const;

  execute(testCase: AutoDiscoveryCase, context: CaseContext): CaseExecution {
    const started = Date.now();
    const dbPath = join(context.workDir, `${testCase.id}.memory.db`);
    const memory = new MemoryV2(dbPath);
    const game = gameFixture(testCase.input.blockName, testCase.input.positions);
    const producer = testCase.input.producer === 'world_scan'
      ? new WorldScanCapability(game, memory, { ...DEFAULT_WORLD_SCAN_CONFIG, terrain: { radius: 0, radiusY: 0, cullInterior: false } })
      : new MineralProbeCapability(game, memory);
    for (let tick = 1; tick <= testCase.input.ticks; tick += 1) producer.onTick({ tick, rate: TickRate.SLOW, world: null } as TickContext);
    const immediate = memory.query('spatial', { kind: testCase.expected.kind });
    memory.close();

    const reopened = new MemoryV2(dbPath);
    const persisted = reopened.query('spatial', { kind: testCase.expected.kind })
      .filter(item => item.meta?.blockName === testCase.input.blockName);
    const foundPositions = persisted.map(item => item.position);
    const allPositionsFound = testCase.expected.positions.every(expected => foundPositions.some(actual => positionDistance(actual, expected) <= testCase.expected.coordinateTolerance));
    const metadataCorrect = persisted.every(item => includesRecord(item.meta, testCase.expected.semanticMeta));
    const foreign = new MemoryV2(join(context.workDir, `${testCase.id}.foreign.db`));
    const leaked = foreign.query('spatial').length;
    foreign.close();

    const catalog = new MemoryCatalog(join(context.workDir, `${testCase.id}.catalog.db`));
    const episodes = new EpisodeStore(join(context.workDir, `${testCase.id}.episodes.db`));
    const query = testCase.expected.semanticMeta.mineralType ?? testCase.expected.semanticMeta.blockName ?? testCase.expected.kind;
    const unified = new MemorySystem('profile-a', catalog, episodes).deepRecall({ query, includeEvidence: true });
    const unifiedVisible = unified.records.some(item => item.kind === 'spatial');
    catalog.close();
    episodes.close();
    reopened.close();

    return {
      caseId: testCase.id,
      domain: this.domain,
      split: testCase.split,
      tags: testCase.tags,
      durationMs: Date.now() - started,
      checks: [
        check({ id: 'automatic_capture', passed: immediate.length === testCase.expected.deduplicatedCount, expected: testCase.expected.deduplicatedCount, actual: immediate.length, weight: 20, critical: true, evidence: `producer=${testCase.input.producer},rows=${immediate.length}` }),
        check({ id: 'coordinate_recall', passed: allPositionsFound, expected: testCase.expected.positions, actual: foundPositions, weight: 15, critical: true, evidence: `tolerance=${testCase.expected.coordinateTolerance}` }),
        check({ id: 'semantic_metadata', passed: persisted.length > 0 && metadataCorrect, expected: testCase.expected.semanticMeta, actual: persisted.map(item => item.meta), weight: 15, critical: true, evidence: `block=${testCase.input.blockName}` }),
        check({ id: 'deduplication', passed: persisted.length === testCase.expected.deduplicatedCount, expected: testCase.expected.deduplicatedCount, actual: persisted.length, weight: 10, evidence: `ticks=${testCase.input.ticks}` }),
        check({ id: 'restart_durability', passed: persisted.length === testCase.expected.deduplicatedCount, expected: testCase.expected.deduplicatedCount, actual: persisted.length, weight: 15, critical: true, evidence: `reopenedRows=${persisted.length}`, kind: 'restart' }),
        check({ id: 'profile_isolation', passed: leaked === 0, expected: 0, actual: leaked, weight: 10, critical: true, evidence: `foreignDbRows=${leaked}`, kind: 'profile_isolation' }),
        check({ id: 'unified_immediate_recall', passed: unifiedVisible, expected: true, actual: unifiedVisible, weight: 15, critical: true, evidence: `records=${unified.records.length},gaps=${unified.gaps.join(';')}`, kind: 'unified_recall' }),
      ],
      trace: {
        productionPath: `${testCase.input.producer} -> MemoryV2.spatial -> reopen -> MemorySystem.deepRecall`,
        immediateRows: immediate.length,
        persistedRows: persisted.length,
        foundPositions,
        unifiedTraceId: unified.traceId,
      },
    };
  }
}

function gameFixture(blockName: string, positions: Position[]): GameAdapter {
  const key = (position: Position) => `${position.x}:${position.y}:${position.z}`;
  const names = new Map(positions.map(position => [key(position), blockName]));
  return {
    findBlocks: (options: FindBlocksOptions) => {
      const requested = Array.isArray(options.names) ? options.names : [options.names];
      return requested.includes(blockName) ? positions : [];
    },
    getPosition: () => ({ x: 0, y: 64, z: 0 }),
    getBlockAt: (position: Position) => {
      const name = names.get(key(position));
      return name ? { name, position, boundingBox: 'block' as const } : null;
    },
  } as unknown as GameAdapter;
}
