import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mineClawZhCases } from '../shared/datasets.js';
import { MemoryBenchmarkHarness } from '../shared/harness.js';
import { summarizeMemoryResults } from './metrics.js';
import type { MemoryBenchMode } from '../shared/types.js';
import { EXTERNAL_REPORT_DIR } from './paths.js';

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function percent(value: number | null): string {
  return value === null ? 'N/A' : `${(value * 100).toFixed(2)}%`;
}

function markdownReport(output: ReturnType<typeof summarizeMemoryResults> & { results: ReturnType<MemoryBenchmarkHarness['runCase']>[] }): string {
  const { summary, gates, byCategory, results } = output;
  const lines = [
    '# MineClaw-MemoryBench-ZH 报告',
    '',
    `- Mode：${summary.mode}`,
    `- Split：${summary.split}`,
    `- Cases：${summary.cases}`,
    `- Generated：${summary.generatedAt}`,
    `- Gate 1～3：${gates.passed === null ? 'N/A' : gates.passed ? 'PASS' : 'FAIL'}`,
    '',
    '## 核心指标',
    '',
    '| 指标 | 结果 |',
    '|---|---:|',
    `| Capture Precision | ${percent(summary.capturePrecision)} |`,
    `| Capture Recall | ${percent(summary.captureRecall)} |`,
    `| Retrieval Recall@5 | ${percent(summary.retrievalRecallAt5)} |`,
    `| Retrieval Precision@5 | ${percent(summary.retrievalPrecisionAt5)} |`,
    `| MRR | ${percent(summary.mrr)} |`,
    `| Source Coverage | ${percent(summary.sourceCoverage)} |`,
    `| Irrelevant Injection | ${percent(summary.irrelevantInjectionRate)} |`,
    `| Answer Accuracy | ${percent(summary.answerAccuracy)} |`,
    `| Memory Success | ${percent(summary.memorySuccess)} |`,
    `| Profile Leak | ${percent(summary.profileLeakRate)} |`,
    '',
    '## 分类',
    '',
    '| Category | Cases | Answer | Memory Success | Operation |',
    '|---|---:|---:|---:|---:|',
    ...Object.entries(byCategory).map(([category, item]) => `| ${category} | ${item.cases} | ${percent(item.answerAccuracy)} | ${percent(item.memorySuccess)} | ${percent(item.operationAccuracy)} |`),
    '',
    '## 失败 Case',
    '',
  ];
  const failures = results.filter(result => !result.answerCorrect || !result.operationCorrect || !result.memorySuccess || result.profileLeak || !result.promptBudgetRespected);
  if (failures.length === 0) lines.push('无。');
  else for (const failure of failures) lines.push(`- ${failure.caseId}：answer=${failure.answerCorrect}，operation=${failure.operationCorrect}，memorySuccess=${failure.memorySuccess}，profileLeak=${failure.profileLeak}`);
  lines.push('');
  return `${lines.join('\n')}\n`;
}

const args = new Set(process.argv.slice(2));
const mode: MemoryBenchMode = args.has('--recent-only')
  ? 'recent_only'
  : args.has('--full-context')
    ? 'full_context'
    : args.has('--fts5-only')
      ? 'fts5_only'
      : 'hybrid';
const requestedSplit = argValue('--split') ?? 'all';
if (!['dev', 'test', 'all'].includes(requestedSplit)) throw new Error(`Unsupported split: ${requestedSplit}`);
const split = requestedSplit as 'dev' | 'test' | 'all';
const harness = new MemoryBenchmarkHarness();
const selectedCases = mineClawZhCases().filter(item => split === 'all' || item.split === split);
const results = selectedCases.map(item => harness.runCase(item, mode));
const scored = summarizeMemoryResults(results, mode, split);
const output = { ...scored, results };
const dir = EXTERNAL_REPORT_DIR;
mkdirSync(dir, { recursive: true });
const stem = `mineclaw-zh-${mode}-${split}-${Date.now()}`;
const jsonPath = join(dir, `${stem}.json`);
const markdownPath = join(dir, `${stem}.md`);
writeFileSync(jsonPath, JSON.stringify(output, null, 2));
writeFileSync(markdownPath, markdownReport(output));
console.log(JSON.stringify({ ...scored.summary, gates: scored.gates, report: jsonPath, markdownReport: markdownPath }, null, 2));
