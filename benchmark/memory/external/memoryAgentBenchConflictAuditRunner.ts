import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ChatMemoryService } from '../../../apps/minecraft-companion/src/bot/v2/infra/chatMemory.js';
import { chunkMemoryAgentBenchText, loadMemoryAgentBench, memoryAgentBenchFiles, memoryAgentBenchPromptVersion, sha256 } from './external.js';
import { auditLatestRelationGraph, normalizedAnswerPresent } from './memoryAgentBenchConflictAudit.js';
import { EXTERNAL_REPORT_DIR, MEMORY_AGENT_BENCH_DATA_DIR } from './paths.js';

interface AuditBucket {
  total: number;
  promptCovered: number;
  graphCovered: number;
  retrievalGapCandidates: number;
  protocolLabelConflictCandidates: number;
  unresolved: number;
}

const dataDir = MEMORY_AGENT_BENCH_DATA_DIR;
const entries = loadMemoryAgentBench(dataDir, 'Conflict_Resolution').filter(entry => entry.source === 'Conflict_Resolution');
const totalExpected = entries.reduce((sum, entry) => sum + entry.questions.length, 0);
const totals: AuditBucket = emptyBucket();
const bySubDataset: Record<string, AuditBucket> = {};
const missing: Array<Record<string, unknown>> = [];
let budgetViolations = 0;

for (let sourceIndex = 0; sourceIndex < entries.length; sourceIndex += 1) {
  const entry = entries[sourceIndex]!;
  const dir = mkdtempSync(join(tmpdir(), 'mineclaw-mab-conflict-audit-'));
  const memory = new ChatMemoryService({ dbPath: join(dir, 'memory.db'), profileId: `audit-${sourceIndex}`, autoCapture: false, flushThresholdChars: 0 });
  try {
    const chunks = chunkMemoryAgentBenchText(entry.context, 600, true);
    memory.recordMessages(chunks.map((content, index) => ({ id: `context-${index}`, sessionId: 'context', role: 'bot' as const, content, timestamp: index + 1 })));
    for (let index = 0; index < entry.questions.length; index += 1) {
      const id = entry.qaPairIds[index] ?? `${entry.source}-${sourceIndex}-${index}`;
      const question = entry.questions[index]!;
      const expected = entry.answers[index] ?? [];
      const prompt = memory.buildPromptContext(question, 'hybrid');
      const promptCovered = normalizedAnswerPresent(prompt.text, expected);
      const graph = auditLatestRelationGraph(entry.context, question, expected);
      const bucket = bySubDataset[entry.subDataset] ??= emptyBucket();
      updateBucket(totals, promptCovered, graph.expectedReachable, graph.rawExpectedPresent);
      updateBucket(bucket, promptCovered, graph.expectedReachable, graph.rawExpectedPresent);
      if (prompt.text.length > 6000) budgetViolations += 1;
      if (!promptCovered) {
        missing.push({
          id,
          subDataset: entry.subDataset,
          question,
          expected,
          classification: graph.expectedReachable
            ? 'retrieval_gap_candidate'
            : graph.rawExpectedPresent ? 'protocol_or_label_conflict_candidate' : 'unresolved',
          graph,
          promptChars: prompt.text.length,
          retrievedMessageIds: prompt.retrievedMessageIds,
          rawExpectedLines: entry.context.split(/\r?\n/).filter(line => normalizedAnswerPresent(line, expected)).slice(0, 20),
        });
      }
      if (totals.total % 100 === 0) console.error(`[mab-conflict-audit] ${totals.total}/${totalExpected}`);
    }
  } finally {
    memory.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const report = {
  schemaVersion: 'mineclaw-memoryagentbench-conflict-audit/v2',
  generatedAt: new Date().toISOString(),
  datasetDir: dataDir,
  datasetSha256: datasetDigest(),
  mode: 'hybrid',
  promptVersion: memoryAgentBenchPromptVersion('hybrid'),
  promptBudgetChars: 6000,
  totals,
  rates: {
    promptExpectedCoverage: ratio(totals.promptCovered, totals.total),
    latestGraphExpectedCoverage: ratio(totals.graphCovered, totals.total),
    retrievalGapCandidateRate: ratio(totals.retrievalGapCandidates, totals.total),
    protocolLabelConflictCandidateRate: ratio(totals.protocolLabelConflictCandidates, totals.total),
  },
  budgetViolations,
  bySubDataset,
  missing,
};
const reportDir = EXTERNAL_REPORT_DIR;
mkdirSync(reportDir, { recursive: true });
const reportPath = resolve(value('--output') ?? join(reportDir, `memoryagentbench-conflict-audit-${Date.now()}.json`));
writeFileSync(reportPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ...report, missing: undefined, reportPath }, null, 2));
if (budgetViolations > 0) process.exitCode = 1;

function emptyBucket(): AuditBucket {
  return { total: 0, promptCovered: 0, graphCovered: 0, retrievalGapCandidates: 0, protocolLabelConflictCandidates: 0, unresolved: 0 };
}

function updateBucket(bucket: AuditBucket, promptCovered: boolean, graphCovered: boolean, rawExpectedPresent: boolean): void {
  bucket.total += 1;
  if (promptCovered) bucket.promptCovered += 1;
  if (graphCovered) bucket.graphCovered += 1;
  if (promptCovered) return;
  if (graphCovered) bucket.retrievalGapCandidates += 1;
  else if (rawExpectedPresent) bucket.protocolLabelConflictCandidates += 1;
  else bucket.unresolved += 1;
}

function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

function datasetDigest(): string {
  const hash = createHash('sha256');
  for (const name of memoryAgentBenchFiles()) hash.update(sha256(join(dataDir, name)));
  return hash.digest('hex');
}

function value(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
