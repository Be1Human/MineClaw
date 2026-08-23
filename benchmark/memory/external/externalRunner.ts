import { createCheckpointWriter, createOpenAICompatibleClient, readExternalCheckpoint, runLongMemEval, runMemoryAgentBench, writeExternalArtifacts, writeExternalCheckpoint, type ExternalDataset } from './external.js';
import type { MemoryBenchMode } from '../shared/types.js';

const args = process.argv.slice(2);
const readArg = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const dataset = (readArg('--dataset') ?? 'longmemeval_s') as ExternalDataset;
const parsedLimit = readArg('--limit');
const limit = parsedLimit ? Number.parseInt(parsedLimit, 10) : undefined;
const category = readArg('--category');
const resumePath = readArg('--resume');
if (!['longmemeval_s', 'longmemeval_m', 'longmemeval_oracle', 'memoryagentbench'].includes(dataset)) throw new Error(`unsupported dataset: ${dataset}`);
if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) throw new Error('--limit must be a positive integer');
const mode: MemoryBenchMode = args.includes('--recent-only') ? 'recent_only' : args.includes('--full-context') ? 'full_context' : args.includes('--fts5-only') ? 'fts5_only' : 'hybrid';
const { client, model, endpoint } = createOpenAICompatibleClient();
const runId = Date.now();
const resumeReport = resumePath ? readExternalCheckpoint(resumePath) : undefined;
if (resumeReport && dataset !== 'memoryagentbench') throw new Error('--resume currently supports memoryagentbench only');
const checkpointWriter = createCheckpointWriter({
  initialCases: resumeReport?.cases,
  write: report => writeExternalCheckpoint(report, runId),
});
let latestReport = resumeReport;
const checkpoint = (item: Parameters<NonNullable<Parameters<typeof runMemoryAgentBench>[0]['onProgress']>>[0]) => {
  latestReport = item;
  checkpointWriter.update(item);
  console.log(JSON.stringify({ cases: item.cases, completed: item.completed, failed: item.failed }));
};
const fatalCheckpoint = (item: Parameters<NonNullable<Parameters<typeof runMemoryAgentBench>[0]['onFatal']>>[0]) => {
  latestReport = item;
  checkpointWriter.flush(item);
};

try {
  if (dataset === 'memoryagentbench') {
    const report = await runMemoryAgentBench({ mode, client, answerModel: model, endpoint, limit, category, resumeReport, onProgress: checkpoint, onFatal: fatalCheckpoint });
    checkpointWriter.flush(report);
    console.log(JSON.stringify({ ...report, traces: undefined, ...writeExternalArtifacts(report) }, null, 2));
  } else {
    const { report, hypotheses } = await runLongMemEval({ dataset, mode, client, answerModel: model, endpoint, limit, onProgress: checkpoint, onFatal: fatalCheckpoint });
    checkpointWriter.flush(report);
    console.log(JSON.stringify({ ...report, traces: undefined, ...writeExternalArtifacts(report, hypotheses) }, null, 2));
  }
} catch (error) {
  if (latestReport) checkpointWriter.flush(latestReport);
  const message = (error instanceof Error ? error.message : String(error))
    .replace(/sk-[\w-]+/gi, '[redacted]');
  console.error(`[memory-benchmark] aborted: ${message}`);
  process.exitCode = 2;
}
