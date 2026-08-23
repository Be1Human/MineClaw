import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadMemoryAgentBench, type ExternalRunReport } from './external.js';
import { summaryReferences, type SummaryJudgeReport } from './memoryAgentBenchSummaryJudge.js';
import { buildSummaryJudgeBlindReview, SUMMARY_JUDGE_BLIND_REVIEW_SEED } from './summaryJudgeBlindReview.js';
import { EXTERNAL_REPORT_DIR, MEMORY_AGENT_BENCH_DATA_DIR } from './paths.js';

function value(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const sourcePath = value('--report');
const judgePath = value('--judge');
if (!sourcePath || !judgePath) throw new Error('--report and --judge are required');
const resolvedSourcePath = resolve(sourcePath);
const resolvedJudgePath = resolve(judgePath);
const sourceReport = JSON.parse(readFileSync(resolvedSourcePath, 'utf8')) as ExternalRunReport;
const judgeReport = JSON.parse(readFileSync(resolvedJudgePath, 'utf8')) as SummaryJudgeReport;
const dataDir = MEMORY_AGENT_BENCH_DATA_DIR;
const references = summaryReferences(loadMemoryAgentBench(dataDir, 'Long_Range_Understanding'));
const generatedAt = new Date().toISOString();
const built = buildSummaryJudgeBlindReview({
  sourceReportPath: resolvedSourcePath,
  sourceReport,
  judgeReport,
  references,
  seed: value('--seed') ?? SUMMARY_JUDGE_BLIND_REVIEW_SEED,
  generatedAt,
});
const outputDir = resolve(value('--output') ?? join(EXTERNAL_REPORT_DIR, `summary-judge-blind-review-${Date.now()}`));
mkdirSync(outputDir, { recursive: true });
const reviewPackPath = join(outputDir, 'review-pack.json');
const reviewFormPath = join(outputDir, 'review-form.md');
const answerKeyPath = join(outputDir, 'answer-key.json');
writeFileSync(reviewPackPath, JSON.stringify(built.reviewPack, null, 2));
writeFileSync(reviewFormPath, built.reviewForm);
writeFileSync(answerKeyPath, JSON.stringify(built.answerKey, null, 2));
console.log(JSON.stringify({
  schemaVersion: built.reviewPack.schemaVersion,
  generatedAt,
  sampleCount: built.reviewPack.sampleCount,
  sourceReportSha256: built.reviewPack.sourceReportSha256,
  judgeReportSha256: built.reviewPack.judgeReportSha256,
  outputDir,
  reviewPackPath,
  reviewFormPath,
  answerKeyPath,
}, null, 2));
