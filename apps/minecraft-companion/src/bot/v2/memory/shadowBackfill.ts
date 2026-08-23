import { join } from 'node:path';
import { BotMemoryStore } from '../infra/botMemory.js';
import {
  BotMemorySourceAdapter,
  ChatMemorySourceAdapter,
  MemoryV2SourceAdapter,
  PlannerEpisodeSourceAdapter,
} from './adapters.js';
import { MemoryBackfill, type BackfillReport } from './backfill.js';
import { MemoryCatalog } from './catalog.js';
import { MemoryRegistry } from './registry.js';

export interface ShadowBackfillOptions {
  dataDir: string;
  profileId: string;
  ownerName?: string;
  batchSize?: number;
  maxBatchesPerSource?: number;
  catalogPath?: string;
  chatMemoryPath?: string;
  memoryV2Path?: string;
  plannerEpisodePath?: string;
  botMemoryDir?: string;
}

export interface ShadowBackfillResult {
  catalogPath: string;
  report: BackfillReport;
}

/**
 * Runs a zero-LLM, read-only authority scan for one Profile.
 * The returned catalog is derived data and can be deleted/rebuilt at any time.
 */
export async function runProfileShadowBackfill(options: ShadowBackfillOptions): Promise<ShadowBackfillResult> {
  const safeId = options.profileId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const catalogPath = options.catalogPath ?? join(options.dataDir, `memory-catalog-${safeId}.db`);
  const registry = new MemoryRegistry()
    .registerSource(new ChatMemorySourceAdapter(
      options.chatMemoryPath ?? join(options.dataDir, `chat-memory-${safeId}.db`),
    ))
    .registerSource(new MemoryV2SourceAdapter(
      options.memoryV2Path ?? join(options.dataDir, `v2-memory-${safeId}.db`),
    ))
    .registerSource(new PlannerEpisodeSourceAdapter(
      options.plannerEpisodePath ?? join(options.dataDir, `planner-evolution-${safeId}.db`),
    ))
    .registerSource(new BotMemorySourceAdapter(
      new BotMemoryStore({ dir: options.botMemoryDir ?? join(options.dataDir, 'memories') }, () => undefined),
      options.ownerName,
    ));
  const catalog = new MemoryCatalog(catalogPath);
  try {
    const report = await new MemoryBackfill(catalog, registry).run({
      profileId: options.profileId,
      batchSize: options.batchSize,
      maxBatchesPerSource: options.maxBatchesPerSource,
    });
    return { catalogPath, report };
  } finally {
    catalog.close();
  }
}
