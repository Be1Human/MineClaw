import type { MemorySourceAdapter } from './contracts.js';
import { MemoryCatalog, type BackfillWatermark } from './catalog.js';
import { MemoryRegistry } from './registry.js';

export interface SourceBackfillReport {
  adapterId: string;
  batches: number;
  scannedThisRun: number;
  watermark: BackfillWatermark;
  reconciled: boolean;
}

export interface BackfillReport {
  profileId: string;
  sources: SourceBackfillReport[];
  externalLlmRequests: 0;
}

/** Checkpointed shadow backfill. Authority stores are read-only; each catalog batch is atomic. */
export class MemoryBackfill {
  constructor(
    private readonly catalog: MemoryCatalog,
    private readonly registry: MemoryRegistry,
  ) {}

  async run(input: { profileId: string; batchSize?: number; maxBatchesPerSource?: number }): Promise<BackfillReport> {
    const batchSize = Math.max(1, input.batchSize ?? 250);
    const maxBatches = Math.max(1, input.maxBatchesPerSource ?? Number.MAX_SAFE_INTEGER);
    const sources: SourceBackfillReport[] = [];
    for (const adapter of this.registry.listSources()) {
      sources.push(await this.backfillSource(adapter, input.profileId, batchSize, maxBatches));
    }
    return { profileId: input.profileId, sources, externalLlmRequests: 0 };
  }

  private async backfillSource(
    adapter: MemorySourceAdapter,
    profileId: string,
    batchSize: number,
    maxBatches: number,
  ): Promise<SourceBackfillReport> {
    let watermark = this.catalog.getWatermark(adapter.id, profileId);
    let cursor = watermark?.completed ? null : watermark?.cursor ?? null;
    if (watermark?.completed) {
      return {
        adapterId: adapter.id,
        batches: 0,
        scannedThisRun: 0,
        watermark,
        reconciled: watermark.sourceCount == null || watermark.indexed === watermark.sourceCount,
      };
    }

    let batches = 0;
    let scannedThisRun = 0;
    while (batches < maxBatches) {
      const batch = await adapter.scan(profileId, cursor, batchSize);
      if (!batch.exhausted && batch.records.length === 0) {
        throw new Error(`[MemoryBackfill] ${adapter.id} returned an empty non-terminal batch`);
      }
      watermark = this.catalog.applySourceBatch(adapter.id, profileId, batch);
      batches += 1;
      scannedThisRun += batch.records.length;
      cursor = batch.nextCursor;
      if (batch.exhausted) break;
    }
    if (!watermark) throw new Error(`[MemoryBackfill] ${adapter.id} produced no watermark`);
    return {
      adapterId: adapter.id,
      batches,
      scannedThisRun,
      watermark,
      reconciled: watermark.completed
        && (watermark.sourceCount == null || watermark.indexed === watermark.sourceCount),
    };
  }
}
