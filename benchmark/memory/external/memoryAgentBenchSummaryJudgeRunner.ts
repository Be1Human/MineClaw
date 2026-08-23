import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createOpenAICompatibleClient, loadMemoryAgentBench, type ExternalRunReport } from './external.js';
import { runSummaryJudge, summaryReferences, type SummaryJudgeReport } from './memoryAgentBenchSummaryJudge.js';
import { EXTERNAL_REPORT_DIR, MEMORY_AGENT_BENCH_DATA_DIR } from './paths.js';

const args = process.argv.slice(2);
const readArg = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const sourcePath = readArg('--report');
if (!sourcePath) throw new Error('--report is required');
const sourceReportPath = resolve(sourcePath);
const source = JSON.parse(readFileSync(sourceReportPath, 'utf8')) as ExternalRunReport;
if (source.dataset !== 'memoryagentbench') throw new Error('--report must be a MemoryAgentBench report');
const resumePath = readArg('--resume');
const initial = resumePath ? JSON.parse(readFileSync(resolve(resumePath), 'utf8')) as SummaryJudgeReport : undefined;
if (initial && initial.sourceReport !== sourceReportPath) throw new Error('judge checkpoint sourceReport mismatch');
const dataDir = MEMORY_AGENT_BENCH_DATA_DIR;
const references = summaryReferences(loadMemoryAgentBench(dataDir, 'Long_Range_Understanding'));
const { client, model, endpoint } = createOpenAICompatibleClient();
const concurrency = Math.max(1, Math.min(8, Number.parseInt(process.env.MEMORY_BENCH_CONCURRENCY ?? '2', 10) || 2));
const outputPath = resolve(readArg('--output') ?? join(EXTERNAL_REPORT_DIR, `memoryagentbench-summary-judge-${Date.now()}.json`));
let progressCount = 0;
let latestReport = initial;
const persist = (report: SummaryJudgeReport) => {
  mkdirSync(dirname(outputPath), { recursive: true });
  const temporary = `${outputPath}.tmp`;
  writeFileSync(temporary, JSON.stringify(report, null, 2));
  renameSync(temporary, outputPath);
};
try {
  const report = await runSummaryJudge({
    sourceReport: sourceReportPath,
    sourceTraces: source.traces,
    references,
    client,
    judgeModel: model,
    endpoint,
    concurrency,
    initialTraces: initial?.traces,
    onProgress: progress => {
      latestReport = progress;
      progressCount += 1;
      if (progressCount % 2 === 0 || progress.completed + progress.failed === progress.cases) persist(progress);
      console.log(JSON.stringify({ cases: progress.cases, completed: progress.completed, failed: progress.failed }));
    },
    onFatal: progress => {
      latestReport = progress;
      persist(progress);
    },
  });
  persist(report);
  console.log(JSON.stringify({ ...report, traces: undefined, outputPath }, null, 2));
} catch (error) {
  if (latestReport) persist(latestReport);
  const message = (error instanceof Error ? error.message : String(error)).replace(/sk-[\w-]+/gi, '[redacted]');
  console.error(`[memory-benchmark] judge aborted: ${message}`);
  process.exitCode = 2;
}
