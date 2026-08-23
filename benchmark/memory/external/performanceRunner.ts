import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { ChatMemoryService, LocalTokenEmbeddingProvider } from '../../../apps/minecraft-companion/src/bot/v2/infra/chatMemory.js';
import { EXTERNAL_REPORT_DIR } from './paths.js';

const MESSAGE_COUNT = 10_000;
const QUERY_COUNT = 120;
const dir = mkdtempSync(join(tmpdir(), 'mineclaw-memory-performance-'));
const dbPath = join(dir, 'memory.db');
const service = new ChatMemoryService({
  dbPath,
  profileId: 'performance',
  autoCapture: false,
  flushThresholdChars: 0,
  embeddingProvider: new LocalTokenEmbeddingProvider(),
});

try {
  const ingestStarted = performance.now();
  service.recordMessages(Array.from({ length: MESSAGE_COUNT }, (_, index) => ({
      id: `message-${index}`,
      sessionId: `session-${Math.floor(index / 100)}`,
      role: index % 2 === 0 ? 'owner' as const : 'bot' as const,
      content: `topic${index % 200} durable memory detail number ${index} project${index % 17}`,
      timestamp: index + 1,
  })));
  const ingestMs = performance.now() - ingestStarted;

  // 先热身，避免首次模块/JIT 成本污染 P95。
  for (let index = 0; index < 10; index += 1) service.searchMessages(`topic${index}`, 5);
  const ftsLatencies = measure(QUERY_COUNT, index => service.searchMessages(`topic${index % 200}`, 5));
  const hybridLatencies = measure(QUERY_COUNT, index => service.searchMessagesMultiHop(`What is topic${index % 200} project${index % 17}?`, 5, 0));
  const rebuilt = service.rebuildSearchIndex();
  const promptChars = service.buildPromptContext('What is topic42 project8?', 'hybrid').text.length;
  const metrics = service.inspectMetrics();
  const report = {
    generatedAt: new Date().toISOString(),
    messages: MESSAGE_COUNT,
    queriesPerMode: QUERY_COUNT,
    provider: 'local-token-hash-v1',
    ingestMs,
    fts5: summarize(ftsLatencies),
    hybrid: summarize(hybridLatencies),
    rebuilt,
    promptChars,
    embeddingFailures: metrics.embeddingFailures,
    gates: {
      fts5P95Under50Ms: percentile(ftsLatencies, 0.95) <= 50,
      hybridP95Under300Ms: percentile(hybridLatencies, 0.95) <= 300,
      rebuildPreservedAllMessages: rebuilt.indexed === MESSAGE_COUNT,
      promptWithin6000Chars: promptChars <= 6000,
      embeddingIndexSucceeded: metrics.embeddingFailures === 0,
    },
  };
  const reportDir = EXTERNAL_REPORT_DIR;
  mkdirSync(reportDir, { recursive: true });
  const reportPath = join(reportDir, `memory-performance-${Date.now()}.json`);
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, reportPath }, null, 2));
} finally {
  service.close();
  rmSync(dir, { recursive: true, force: true });
}

function measure(count: number, run: (index: number) => unknown): number[] {
  const result: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const started = performance.now();
    run(index);
    result.push(performance.now() - started);
  }
  return result;
}

function summarize(values: number[]): { p50Ms: number; p95Ms: number; maxMs: number } {
  return { p50Ms: percentile(values, 0.5), p95Ms: percentile(values, 0.95), maxMs: Math.max(...values) };
}

function percentile(values: number[], quantile: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * quantile))] ?? 0;
}
