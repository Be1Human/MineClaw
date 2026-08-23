import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { ExternalRunReport } from './external.js';
import { finalizeMemoryAgentBench } from './memoryAgentBenchFinalize.js';
import type { LongMemJudgeReport } from './memoryAgentBenchLongMemJudge.js';
import type { SummaryJudgeReport } from './memoryAgentBenchSummaryJudge.js';
import { EXTERNAL_REPORT_DIR } from './paths.js';

const args = process.argv.slice(2);
const readArg = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const sourcePath = readArg('--report');
const summaryPath = readArg('--summary-judge');
const longMemPath = readArg('--longmem-judge');
if (!sourcePath || !summaryPath || !longMemPath) throw new Error('--report, --summary-judge and --longmem-judge are required');
const sourceReportPath = resolve(sourcePath);
const summaryReportPath = resolve(summaryPath);
const longMemReportPath = resolve(longMemPath);
const source = JSON.parse(readFileSync(sourceReportPath, 'utf8')) as ExternalRunReport;
const summaryJudge = JSON.parse(readFileSync(summaryReportPath, 'utf8')) as SummaryJudgeReport;
const longMemJudge = JSON.parse(readFileSync(longMemReportPath, 'utf8')) as LongMemJudgeReport;
const outputPath = resolve(readArg('--output') ?? join(EXTERNAL_REPORT_DIR, `external-memoryagentbench-finalized-${Date.now()}.json`));
const report = finalizeMemoryAgentBench({
  source,
  sourceReportPath,
  summaryJudge,
  summaryJudgeReportPath: summaryReportPath,
  longMemJudge,
  longMemJudgeReportPath: longMemReportPath,
});
mkdirSync(dirname(outputPath), { recursive: true });
const temporary = `${outputPath}.tmp`;
writeFileSync(temporary, JSON.stringify(report, null, 2));
renameSync(temporary, outputPath);
console.log(JSON.stringify({ ...report, traces: undefined, outputPath }, null, 2));
