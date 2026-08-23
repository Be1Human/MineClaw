import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildCaptureBlindReview, CAPTURE_BLIND_REVIEW_SEED, selectCaptureBlindCases } from './captureBlindReview.js';
import { mineClawZhCases } from '../shared/datasets.js';
import { MemoryBenchmarkHarness } from '../shared/harness.js';
import { EXTERNAL_REPORT_DIR } from './paths.js';

function value(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const seed = value('--seed') ?? CAPTURE_BLIND_REVIEW_SEED;
const allCases = mineClawZhCases();
const selectedCases = selectCaptureBlindCases(allCases, seed);
const harness = new MemoryBenchmarkHarness();
const results = selectedCases.map(testCase => harness.runCase(testCase, 'hybrid'));
const generatedAt = new Date().toISOString();
const output = buildCaptureBlindReview(allCases, selectedCases, results, { seed, generatedAt });
const outputDir = resolve(value('--output') ?? join(EXTERNAL_REPORT_DIR, `capture-blind-review-${Date.now()}`));
mkdirSync(outputDir, { recursive: true });
const reviewPackPath = join(outputDir, 'review-pack.json');
const reviewFormPath = join(outputDir, 'review-form.md');
const answerKeyPath = join(outputDir, 'answer-key.json');
writeFileSync(reviewPackPath, JSON.stringify(output.reviewPack, null, 2));
writeFileSync(reviewFormPath, output.reviewForm);
writeFileSync(answerKeyPath, JSON.stringify(output.answerKey, null, 2));
console.log(JSON.stringify({
  schemaVersion: output.reviewPack.schemaVersion,
  generatedAt,
  seed,
  datasetSha256: output.reviewPack.datasetSha256,
  sampleCount: output.reviewPack.sampleCount,
  outputDir,
  reviewPackPath,
  reviewFormPath,
  answerKeyPath,
}, null, 2));
