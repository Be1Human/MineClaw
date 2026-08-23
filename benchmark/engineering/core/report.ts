/**
 * 评测体系 · 报告输出（FEAT-CROSS-02 · 阶段〇）
 *
 * 输出 reports/eval-<ts>.json + .md：场景 × 成功率 × 均时长 × 失败原因 Top3 × watchdog。
 * 支持 --compare baseline.json：与基线逐场景比对（成功率差值）。
 *
 * 注意：脚本内不取系统时间（runner 传入 ISO 时间戳）。
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EvalReport, ScenarioResult, RunResult, Category } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPORTS_DIR = join(__dirname, '..', '..', 'reports', 'engineering', 'body');

/** 由逐次运行结果聚合成场景汇总 */
export function aggregate(
  meta: { id: string; title: string; suite: ScenarioResult['suite']; category?: Category; repeat: number },
  runs: RunResult[],
): ScenarioResult {
  const passed = runs.filter(r => r.ok).length;
  const okRuns = runs.filter(r => r.ok);
  const avgDurationMs = okRuns.length
    ? Math.round(okRuns.reduce((s, r) => s + r.durationMs, 0) / okRuns.length)
    : 0;
  const watchdogHits = runs.reduce((s, r) => s + r.watchdogHits, 0);

  const failCount = new Map<string, number>();
  for (const r of runs) {
    if (!r.ok) {
      const reason = r.reason ?? 'unknown';
      failCount.set(reason, (failCount.get(reason) ?? 0) + 1);
    }
  }
  const topFailReasons = [...failCount.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 3);

  return {
    id: meta.id,
    title: meta.title,
    suite: meta.suite,
    category: meta.category,
    repeat: meta.repeat,
    passed,
    successRate: runs.length ? passed / runs.length : 0,
    avgDurationMs,
    watchdogHits,
    topFailReasons,
    runs,
  };
}

/** 组装整轮报告 */
export function buildReport(
  scenarios: ScenarioResult[],
  meta: { startedAt: string; finishedAt: string; suite: EvalReport['suite']; server: string },
): EvalReport {
  const totalScenarios = scenarios.length;
  const avgSuccessRate = totalScenarios
    ? scenarios.reduce((s, r) => s + r.successRate, 0) / totalScenarios
    : 0;
  const totalWatchdogHits = scenarios.reduce((s, r) => s + r.watchdogHits, 0);
  return {
    ...meta,
    scenarios,
    summary: { totalScenarios, avgSuccessRate, totalWatchdogHits },
  };
}

const pct = (x: number) => `${(x * 100).toFixed(0)}%`;

/** 渲染 Markdown */
export function renderMarkdown(report: EvalReport, baseline?: EvalReport | null): string {
  const lines: string[] = [];
  lines.push(`# 评测报告 · ${report.suite} 套件`);
  lines.push('');
  lines.push(`- 开始：${report.startedAt}`);
  lines.push(`- 结束：${report.finishedAt}`);
  lines.push(`- 服务器：${report.server}`);
  lines.push(`- 场景数：${report.summary.totalScenarios} · 平均成功率：**${pct(report.summary.avgSuccessRate)}** · watchdog 强拆：**${report.summary.totalWatchdogHits}** 次`);
  lines.push('');

  const baseMap = new Map<string, ScenarioResult>();
  if (baseline) for (const s of baseline.scenarios) baseMap.set(s.id, s);

  const header = baseline
    ? '| 场景 | 标题 | 成功率 | 基线 | Δ | 均时长 | watchdog | 失败 Top |'
    : '| 场景 | 标题 | 成功率 | 均时长(ms) | watchdog | 失败原因 Top3 |';
  const sep = baseline
    ? '|---|---|---|---|---|---|---|---|'
    : '|---|---|---|---|---|---|';
  lines.push(header);
  lines.push(sep);

  for (const s of report.scenarios) {
    const fails = s.topFailReasons.map(f => `${f.reason}×${f.count}`).join(', ') || '—';
    if (baseline) {
      const b = baseMap.get(s.id);
      const bRate = b ? pct(b.successRate) : '—';
      const delta = b ? `${((s.successRate - b.successRate) * 100).toFixed(0)}pt` : '—';
      const flag = b && s.successRate < b.successRate ? ' ⚠️' : '';
      lines.push(`| ${s.id} | ${s.title} | ${pct(s.successRate)} | ${bRate} | ${delta}${flag} | ${s.avgDurationMs} | ${s.watchdogHits} | ${fails} |`);
    } else {
      lines.push(`| ${s.id} | ${s.title} | ${pct(s.successRate)} (${s.passed}/${s.repeat}) | ${s.avgDurationMs} | ${s.watchdogHits} | ${fails} |`);
    }
  }
  lines.push('');

  // ── 类目分组小计（FEAT-CROSS-03 · AC5） ──────────────────────────
  const byCat = new Map<string, ScenarioResult[]>();
  for (const s of report.scenarios) {
    const k = s.category ?? 'misc';
    (byCat.get(k) ?? byCat.set(k, []).get(k)!).push(s);
  }
  if (byCat.size > 1) {
    lines.push('## 类目小计');
    lines.push('');
    lines.push('| 类目 | 场景数 | 平均成功率 | watchdog |');
    lines.push('|---|---|---|---|');
    for (const [cat, arr] of byCat) {
      const rate = arr.reduce((a, s) => a + s.successRate, 0) / arr.length;
      const wd = arr.reduce((a, s) => a + s.watchdogHits, 0);
      lines.push(`| ${cat} | ${arr.length} | ${pct(rate)} | ${wd} |`);
    }
    lines.push('');
  }

  if (baseline) {
    const regressions = report.scenarios.filter(s => {
      const b = baseMap.get(s.id);
      return b && s.successRate < b.successRate;
    });
    lines.push(regressions.length
      ? `> ⚠️ **${regressions.length} 个场景成功率低于基线**：${regressions.map(r => r.id).join(', ')} —— 违反 AC5 门禁。`
      : `> ✅ 所有场景成功率 ≥ 基线，满足 AC5 门禁。`);
  }
  return lines.join('\n');
}

/** 落盘 JSON + MD，返回两个文件路径。tsStamp 由 runner 传入（无系统时间依赖）。 */
export function writeReports(report: EvalReport, tsStamp: string): { json: string; md: string } {
  if (!existsSync(REPORTS_DIR)) mkdirSync(REPORTS_DIR, { recursive: true });
  const jsonPath = join(REPORTS_DIR, `eval-${tsStamp}.json`);
  const mdPath = join(REPORTS_DIR, `eval-${tsStamp}.md`);
  const baseline = loadBaseline();
  writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf8');
  writeFileSync(mdPath, renderMarkdown(report, baseline), 'utf8');
  return { json: jsonPath, md: mdPath };
}

/** 读基线（reports/baseline.json）· 不存在返回 null */
export function loadBaseline(): EvalReport | null {
  const p = join(REPORTS_DIR, 'baseline.json');
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')) as EvalReport; }
  catch { return null; }
}

/** 把某份报告写成基线 */
export function saveAsBaseline(report: EvalReport): string {
  if (!existsSync(REPORTS_DIR)) mkdirSync(REPORTS_DIR, { recursive: true });
  const p = join(REPORTS_DIR, 'baseline.json');
  writeFileSync(p, JSON.stringify(report, null, 2), 'utf8');
  return p;
}

export { REPORTS_DIR };
