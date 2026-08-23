import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BenchmarkReport } from './types.js';

export function writeBenchmarkReport(report: BenchmarkReport, outputDir: string): { jsonPath: string; markdownPath: string } {
  mkdirSync(outputDir, { recursive: true });
  const stem = `memory-benchmark-${report.profile}-${report.runId}`;
  const jsonPath = join(outputDir, `${stem}.json`);
  const markdownPath = join(outputDir, `${stem}.md`);
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(markdownPath, markdown(report));
  return { jsonPath, markdownPath };
}

export function markdown(report: BenchmarkReport): string {
  const failed = report.cases.filter(item => !item.passed);
  const lines = [
    '# MineClaw Unified Memory Benchmark 报告',
    '',
    `> 结论：${report.score.passed ? '✅ PASS' : '❌ FAIL'}　｜　Profile：${report.profile}　｜　总分：${percent(report.score.totalScore)}`,
    '',
    `- Benchmark：${report.benchmarkVersion}`,
    `- Dataset：${report.datasetVersion} / ${report.datasetSha256}`,
    `- Config：${report.configSha256}`,
    `- Git：${report.gitCommit}`,
    `- Run：${report.runId}`,
    `- Cases：${report.cases.length}`,
    `- External LLM requests：${report.externalLlmRequests}`,
    '',
    '## 域分',
    '',
    '| 域 | Case | 通过 | 分数 |',
    '|---|---:|---:|---:|',
    ...report.score.domains.map(item => `| ${item.domain} | ${item.cases} | ${item.passedCases} | ${percent(item.score)} |`),
    '',
    '## 硬门',
    '',
    '| Gate | 结果 | 期望 | 实际 |',
    '|---|---|---|---|',
    ...report.score.gates.map(item => `| ${item.id} | ${item.passed ? '✅' : '❌'} | ${escapeCell(item.expected)} | ${escapeCell(JSON.stringify(item.actual))} |`),
    '',
    '## 失败 Case',
    '',
  ];
  if (failed.length === 0) lines.push('无。');
  for (const item of failed) {
    lines.push(`### ${item.caseId}`,'',`- 域：${item.domain}` ,`- 分数：${percent(item.score)}`, `- Critical：${item.failedCriticalChecks.join(', ') || '无'}`,'','| Check | 结果 | 预期 | 实际 |','|---|---|---|---|');
    for (const check of item.checks.filter(check => !check.passed)) lines.push(`| ${check.id} | ❌ | ${escapeCell(JSON.stringify(check.expected))} | ${escapeCell(JSON.stringify(check.actual))} |`);
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

function percent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function escapeCell(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('\n', ' ');
}
