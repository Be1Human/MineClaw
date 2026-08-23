import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BenchmarkReport } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const BENCHMARK_REPORTS_DIR = join(__dirname, '..', 'reports', 'engineering');
export const BENCHMARK_BASELINE_PATH = join(__dirname, '..', 'baselines', 'engineering', 'benchmark-baseline.json');

const score = (value: number | null): string => value === null ? '—' : value.toFixed(1);
const escapeCell = (value: string): string => value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

export function withBaselineDiff(report: BenchmarkReport, baseline: BenchmarkReport | null): BenchmarkReport {
  if (!baseline) return report;
  const before = new Map(baseline.results.map(item => [item.id, item.successRate * 100]));
  return {
    ...report,
    baselineDiff: report.results.map(item => {
      const previous = before.get(item.id) ?? 0;
      const current = item.successRate * 100;
      return { id: item.id, before: previous, after: current, delta: current - previous };
    }),
  };
}

export function renderBenchmarkMarkdown(report: BenchmarkReport): string {
  const lines = [
    `# MineClaw 工程 Benchmark · ${report.environment.profile}`,
    '',
    `- Run：${report.runId}`,
    `- 时间：${report.startedAt} → ${report.finishedAt}`,
    `- Git：${report.environment.commit}${report.environment.dirty ? '（dirty）' : ''}`,
    `- 服务器：${report.environment.server} · 后端：${report.environment.backend}`,
    `- 结果：**${report.passed ? 'PASS' : 'FAIL'}** · 总分：**${report.scores.overall.toFixed(1)}** / 100 · 阈值：${report.threshold}`,
    '',
    '## 分层成绩',
    '',
    '| Body | Experience | Reliability | Overall |',
    '|---:|---:|---:|---:|',
    `| ${score(report.scores.body)} | ${score(report.scores.experience)} | ${score(report.scores.reliability)} | ${score(report.scores.overall)} |`,
    '',
    '## 硬门',
    '',
    '| 假完成 | Crash | Hang | 终态矛盾 | Incomplete | Watchdog |',
    '|---:|---:|---:|---:|---:|---:|',
    `| ${report.gates.falseComplete} | ${report.gates.crash} | ${report.gates.hung} | ${report.gates.terminalMismatch} | ${report.gates.incomplete} | ${report.gates.watchdog} |`,
    '',
    '## Case 明细',
    '',
    '| Case | 层 | 状态 | 成功率 | 用时 | 首次回复 | 原因 | 证据 |',
    '|---|---|---|---:|---:|---:|---|---|',
  ];

  const baseline = new Map((report.baselineDiff ?? []).map(item => [item.id, item]));
  for (const item of report.results) {
    const diff = baseline.get(item.id);
    const rate = `${(item.successRate * 100).toFixed(0)}% (${item.passedAttempts}/${item.attempts})`
      + (diff ? ` · Δ${diff.delta >= 0 ? '+' : ''}${diff.delta.toFixed(0)}pt` : '');
    const evidence = item.evidence.map(path => `\`${path}\``).join('<br>') || '—';
    lines.push(`| ${item.id} ${escapeCell(item.title)} | ${item.layer} | ${item.status.toUpperCase()} | ${rate} | ${(item.durationMs / 1000).toFixed(1)}s | ${item.responseLatencyMs === undefined ? '—' : `${(item.responseLatencyMs / 1000).toFixed(1)}s`} | ${escapeCell(item.reason ?? '—')} | ${evidence} |`);
  }

  const missing = report.expectedCaseIds.filter(id => !report.results.some(item => item.id === id));
  if (missing.length) {
    lines.push('', `> ❌ 缺少 ${missing.length} 个 Case 结果：${missing.join(', ')}`);
  }
  return lines.join('\n');
}

export function loadBenchmarkBaseline(): BenchmarkReport | null {
  if (!existsSync(BENCHMARK_BASELINE_PATH)) return null;
  try {
    const parsed = JSON.parse(readFileSync(BENCHMARK_BASELINE_PATH, 'utf8')) as BenchmarkReport;
    return parsed.schemaVersion === 'mineclaw-benchmark/v1' ? parsed : null;
  } catch {
    return null;
  }
}

export function writeBenchmarkReport(report: BenchmarkReport, stamp: string): { json: string; md: string } {
  mkdirSync(BENCHMARK_REPORTS_DIR, { recursive: true });
  const json = join(BENCHMARK_REPORTS_DIR, `benchmark-${stamp}.json`);
  const md = join(BENCHMARK_REPORTS_DIR, `benchmark-${stamp}.md`);
  writeFileSync(json, JSON.stringify(report, null, 2), 'utf8');
  writeFileSync(md, renderBenchmarkMarkdown(report), 'utf8');
  return { json, md };
}

export function saveBenchmarkBaseline(report: BenchmarkReport): string {
  if (report.gates.incomplete > 0) throw new Error('报告不完整，拒绝保存 Benchmark baseline');
  mkdirSync(dirname(BENCHMARK_BASELINE_PATH), { recursive: true });
  writeFileSync(BENCHMARK_BASELINE_PATH, JSON.stringify(report, null, 2), 'utf8');
  return BENCHMARK_BASELINE_PATH;
}
