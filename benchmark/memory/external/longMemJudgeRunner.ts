import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createOpenAICompatibleClient, datasetFile, loadLongMemEvalJudgeReferences, sha256File } from './external.js';
import { EXTERNAL_REPORT_DIR } from './paths.js';
import {
  assertLongMemEvalJudgeResumeCompatible,
  runLongMemEvalJudge,
  type LongMemEvalHypothesis,
  type LongMemEvalJudgeReport,
} from './longMemEvalJudge.js';

const args = process.argv.slice(2);
const readArg = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const hypothesesArg = readArg('--hypotheses');
const dataset = (readArg('--dataset') ?? 'longmemeval_s') as LongMemEvalJudgeReport['dataset'];
if (!hypothesesArg) throw new Error('--hypotheses is required');
if (!['longmemeval_s', 'longmemeval_m', 'longmemeval_oracle'].includes(dataset)) throw new Error(`unsupported dataset: ${dataset}`);

const hypothesesPath = resolve(hypothesesArg);
const referencePath = datasetFile(dataset);
const hypotheses = readFileSync(hypothesesPath, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line) as LongMemEvalHypothesis);
const references = await loadLongMemEvalJudgeReferences(referencePath, new Set(hypotheses.map(item => item.question_id)));
const { client, model, endpoint } = createOpenAICompatibleClient();
const [referenceSha256, hypothesesSha256] = await Promise.all([sha256File(referencePath), sha256File(hypothesesPath)]);
const resumeArg = readArg('--resume');
const resumePath = resumeArg ? resolve(resumeArg) : undefined;
const initial = resumePath ? JSON.parse(readFileSync(resumePath, 'utf8')) as LongMemEvalJudgeReport : undefined;
if (initial) assertLongMemEvalJudgeResumeCompatible(initial, { dataset, judgeModel: model, endpoint, referenceSha256, hypothesesSha256 });
const reportDir = EXTERNAL_REPORT_DIR;
const outputPath = resolve(readArg('--output') ?? resumePath ?? join(reportDir, `longmemeval-judge-${dataset}-${Date.now()}.json`));
const concurrency = Math.max(1, Math.min(8, Number.parseInt(process.env.MEMORY_BENCH_CONCURRENCY ?? '2', 10) || 2));
let progressCount = 0;
let latestReport = initial;
const persist = (report: LongMemEvalJudgeReport) => {
  mkdirSync(dirname(outputPath), { recursive: true });
  const temporary = `${outputPath}.tmp`;
  writeFileSync(temporary, JSON.stringify(report, null, 2));
  renameSync(temporary, outputPath);
};

try {
  const report = await runLongMemEvalJudge({
    dataset,
    judgeModel: model,
    endpoint,
    referenceFile: referencePath,
    referenceSha256,
    hypothesesFile: hypothesesPath,
    hypothesesSha256,
    hypotheses,
    references,
    client,
    concurrency,
    initialTraces: initial?.traces,
    onProgress: progress => {
      latestReport = progress;
      progressCount += 1;
      if (progressCount % 10 === 0 || progress.completed + progress.failed === progress.cases) persist(progress);
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
