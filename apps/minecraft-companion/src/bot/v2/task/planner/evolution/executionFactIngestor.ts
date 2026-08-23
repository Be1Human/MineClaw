/**
 * FEAT-CROSS-12 · execution facts 游标消费者。
 *
 * EventBus 只作为 wakeup；事实由 ExecutionFactSource 按 cursor 重放。
 */

import { parseExecutionFactV1, type ExecutionFactEnvelopeV1 } from './contracts/executionFactsV1.js';
import { EpisodeLedger, type AppendFactResult } from './episodeLedger.js';

export interface ExecutionFactSourcePage {
  facts: unknown[];
  nextCursor: string | null;
}

export interface ExecutionFactSource {
  readAfter(cursor: string | null, limit: number): Promise<ExecutionFactSourcePage>;
  subscribeWakeup?(handler: () => void): () => void;
}

export type IngestResult =
  | (AppendFactResult & { knownEventType?: boolean })
  | { kind: 'quarantined'; reason: string };

export interface CatchUpSummary {
  batches: number;
  seen: number;
  accepted: number;
  duplicates: number;
  quarantined: number;
  finalized: number;
  cursor: string | null;
}

export class ExecutionFactIngestor {
  constructor(private readonly ledger: EpisodeLedger) {}

  accept(input: unknown): IngestResult {
    const parsed = parseExecutionFactV1(input);
    if (parsed.kind === 'unsupported_schema') {
      return this.ledger.quarantine(input, `unsupported_schema:${parsed.schema}`);
    }
    if (parsed.kind === 'invalid') {
      return this.ledger.quarantine(input, `invalid:${parsed.reason}`);
    }

    const result = this.ledger.appendFact(parsed.fact);
    return result.kind === 'accepted'
      ? { ...result, knownEventType: parsed.knownEventType }
      : result;
  }

  async catchUp(
    source: ExecutionFactSource,
    options: { consumerId?: string; batchSize?: number; maxBatches?: number } = {},
  ): Promise<CatchUpSummary> {
    const consumerId = options.consumerId ?? 'planner-evolution-v1';
    const batchSize = positiveInteger(options.batchSize, 100);
    const maxBatches = positiveInteger(options.maxBatches, 1000);
    let cursor = this.ledger.getCursor(consumerId);
    const summary: CatchUpSummary = {
      batches: 0,
      seen: 0,
      accepted: 0,
      duplicates: 0,
      quarantined: 0,
      finalized: 0,
      cursor,
    };

    for (let batch = 0; batch < maxBatches; batch += 1) {
      const page = await source.readAfter(cursor, batchSize);
      summary.batches += 1;
      for (const raw of page.facts) {
        summary.seen += 1;
        const result = this.accept(raw);
        if (result.kind === 'accepted') {
          summary.accepted += 1;
          if (result.finalizedNow) summary.finalized += 1;
        } else if (result.kind === 'duplicate') {
          summary.duplicates += 1;
        } else {
          summary.quarantined += 1;
        }
      }

      if (page.nextCursor != null && page.nextCursor !== cursor) {
        this.ledger.setCursor(consumerId, page.nextCursor);
        cursor = page.nextCursor;
        summary.cursor = cursor;
      }

      if (page.facts.length === 0 || page.nextCursor == null) break;
    }

    return summary;
  }

  /**
   * 可选实时驱动：收到 wakeup 后执行 catch-up。并发 wakeup 会合并，避免同一 consumer 多路写游标。
   */
  attach(source: ExecutionFactSource, options: { consumerId?: string; batchSize?: number } = {}): () => void {
    if (!source.subscribeWakeup) return () => undefined;
    let stopped = false;
    let running = false;
    let pending = false;

    const drain = async (): Promise<void> => {
      if (running || stopped) {
        pending = !stopped;
        return;
      }
      running = true;
      try {
        do {
          pending = false;
          await this.catchUp(source, options);
        } while (pending && !stopped);
      } finally {
        running = false;
      }
    };

    const unsubscribe = source.subscribeWakeup(() => {
      void drain();
    });
    void drain();

    return () => {
      stopped = true;
      unsubscribe();
    };
  }
}

export function asExecutionFactV1(input: ExecutionFactEnvelopeV1): ExecutionFactEnvelopeV1 {
  return input;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}
