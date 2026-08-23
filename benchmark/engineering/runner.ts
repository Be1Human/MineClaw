import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { allBenchmarkCases, caseById, casesForProfile } from './catalog.js';
import { normalizeBodyReport, normalizeGymAttempts } from './normalize.js';
import { calculateScores, passesBenchmark } from './score.js';
import {
  loadBenchmarkBaseline,
  saveBenchmarkBaseline,
  withBaselineDiff,
  writeBenchmarkReport,
} from './report.js';
import type {
  BenchmarkCaseDefinition,
  BenchmarkCaseResult,
  BenchmarkProfile,
  BenchmarkReport,
  BodyEvalReport,
  GymTaskResult,
} from './types.js';
import { resolveBodyEvalEnvironment } from './runtimeEnv.js';
import { runChildProcess, type ChildRunResult } from './childProcess.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_DIR = resolve(__dirname, '..', '..');
const APP_DIR = resolve(REPO_DIR, 'apps', 'minecraft-companion');
const BODY_REPORT_DIR = resolve(REPO_DIR, 'benchmark', 'reports', 'engineering', 'body');
const GYM_RUN_DIR = resolve(REPO_DIR, 'benchmark', 'reports', 'engineering', 'gym');

interface Args {
  profile: BenchmarkProfile;
  only?: string;
  repeat: number;
  list: boolean;
  saveBaseline: boolean;
  bodyOnly: boolean;
  experienceOnly: boolean;
  threshold: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    profile: 'release',
    repeat: 1,
    list: false,
    saveBaseline: false,
    bodyOnly: false,
    experienceOnly: false,
    threshold: Number(process.env.BENCHMARK_PASS_SCORE ?? 80),
  };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--profile') {
      const value = argv[++i];
      if (!['smoke', 'release', 'full'].includes(value)) throw new Error(`未知 Profile：${value}`);
      args.profile = value as BenchmarkProfile;
    } else if (token === '--case') args.only = argv[++i];
    else if (token === '--repeat') args.repeat = Number(argv[++i]);
    else if (token === '--list') args.list = true;
    else if (token === '--save-baseline') args.saveBaseline = true;
    else if (token === '--body-only') args.bodyOnly = true;
    else if (token === '--experience-only') args.experienceOnly = true;
    else if (token === '--threshold') args.threshold = Number(argv[++i]);
    else throw new Error(`未知参数：${token}`);
  }
  if (!Number.isInteger(args.repeat) || args.repeat < 1 || args.repeat > 10) throw new Error('--repeat 必须是 1..10 的整数');
  if (!Number.isFinite(args.threshold) || args.threshold < 0 || args.threshold > 100) throw new Error('--threshold 必须在 0..100');
  if (args.bodyOnly && args.experienceOnly) throw new Error('--body-only 与 --experience-only 不能同时使用');
  return args;
}

function selectCases(args: Args): BenchmarkCaseDefinition[] {
  let selected: BenchmarkCaseDefinition[];
  if (args.only) {
    const found = caseById(args.only);
    if (!found) throw new Error(`未知 Benchmark Case：${args.only}`);
    selected = [found];
  } else {
    selected = casesForProfile(args.profile);
  }
  if (args.bodyOnly) selected = selected.filter(item => item.layer === 'body');
  if (args.experienceOnly) selected = selected.filter(item => item.layer !== 'body');
  if (!selected.length) throw new Error('筛选后没有 Benchmark Case');
  return selected;
}

function printList(profile: BenchmarkProfile): void {
  const selected = casesForProfile(profile);
  console.log(`MineClaw Benchmark · ${profile} · ${selected.length} Cases`);
  for (const layer of ['body', 'experience', 'reliability'] as const) {
    const items = selected.filter(item => item.layer === layer);
    console.log(`\n[${layer}] ${items.length}`);
    for (const item of items) console.log(`  ${item.id.padEnd(16)} ${item.title}`);
  }
}

function positiveEnvMs(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function runChild(
  script: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeouts: { idleTimeoutMs: number; hardTimeoutMs: number },
): Promise<ChildRunResult> {
  return runChildProcess(process.execPath, ['--import', 'tsx/esm', script, ...args], {
    cwd: APP_DIR,
    env,
    ...timeouts,
  });
}

function bodyReportFiles(): Set<string> {
  if (!existsSync(BODY_REPORT_DIR)) return new Set();
  return new Set(readdirSync(BODY_REPORT_DIR)
    .filter(name => /^eval-.*\.json$/.test(name))
    .map(name => join(BODY_REPORT_DIR, name)));
}

function newestNewBodyReport(before: Set<string>, startedMs: number): string | null {
  if (!existsSync(BODY_REPORT_DIR)) return null;
  const candidates = readdirSync(BODY_REPORT_DIR)
    .filter(name => /^eval-.*\.json$/.test(name))
    .map(name => join(BODY_REPORT_DIR, name))
    .filter(path => !before.has(path) && statSync(path).mtimeMs >= startedMs - 1000)
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return candidates[0] ?? null;
}

function incomplete(definition: BenchmarkCaseDefinition, reason: string, evidence: string[] = []): BenchmarkCaseResult {
  return {
    id: definition.id,
    title: definition.title,
    layer: definition.layer,
    status: 'incomplete',
    successRate: 0,
    durationMs: 0,
    failureKind: 'harness_error',
    reason,
    evidence,
    attempts: 0,
    passedAttempts: 0,
  };
}

async function runBodyInvocation(definitions: BenchmarkCaseDefinition[], cliArgs: string[]): Promise<BenchmarkCaseResult[]> {
  const before = bodyReportFiles();
  const startedMs = Date.now();
  let childResult: ChildRunResult;
  try {
    childResult = await runChild(
      resolve(__dirname, 'core', 'runner.ts'),
      cliArgs,
      resolveBodyEvalEnvironment(process.env).childEnv,
      {
        idleTimeoutMs: positiveEnvMs('BENCHMARK_BODY_IDLE_TIMEOUT_MS', 180_000),
        hardTimeoutMs: positiveEnvMs('BENCHMARK_BODY_HARD_TIMEOUT_MS', 7_200_000),
      },
    );
  } catch (error) {
    const reason = `Body Runner 启动失败：${error instanceof Error ? error.message : String(error)}`;
    return definitions.map(item => incomplete(item, reason));
  }
  if (childResult.timedOut) {
    const reason = `Body Runner ${childResult.timeoutKind} timeout（${childResult.elapsedMs}ms）`;
    return definitions.map(item => incomplete(item, reason));
  }
  const exitCode = childResult.exitCode;
  const reportPath = newestNewBodyReport(before, startedMs);
  if (!reportPath) return definitions.map(item => incomplete(item, `Body Runner exit=${exitCode}，但未生成新报告`));
  try {
    const report = JSON.parse(readFileSync(reportPath, 'utf8')) as BodyEvalReport;
    const normalized = normalizeBodyReport(report, definitions, reportPath);
    const found = new Set(normalized.map(item => item.id));
    return [...normalized, ...definitions.filter(item => !found.has(item.id)).map(item => incomplete(item, 'Body 报告缺少 Case', [reportPath]))];
  } catch (error) {
    const reason = `Body 报告解析失败：${error instanceof Error ? error.message : String(error)}`;
    return definitions.map(item => incomplete(item, reason, [reportPath]));
  }
}

async function runBody(definitions: BenchmarkCaseDefinition[]): Promise<BenchmarkCaseResult[]> {
  const results: BenchmarkCaseResult[] = [];
  for (const source of ['body-full', 'body-matrix'] as const) {
    const group = definitions.filter(item => item.source === source);
    if (!group.length) continue;
    const allInSource = allBenchmarkCases().filter(item => item.source === source);
    if (group.length === allInSource.length) {
      results.push(...await runBodyInvocation(group, ['--suite', source === 'body-full' ? 'full' : 'matrix']));
    } else {
      for (const item of group) results.push(...await runBodyInvocation([item], ['--scenario', item.id]));
    }
  }
  return results;
}

async function runGym(definitions: BenchmarkCaseDefinition[], runId: string, repeat: number): Promise<BenchmarkCaseResult[]> {
  const attempts = new Map<string, Array<{ result: GymTaskResult; evidencePath: string }>>();
  for (const definition of definitions) attempts.set(definition.id, []);
  for (let index = 1; index <= repeat; index++) {
    const runName = `${runId}-r${index}`.replace(/[^A-Za-z0-9_-]/g, '-');
    const taskIds = definitions.map(item => item.id).join(',');
    let childResult: ChildRunResult | null = null;
    try {
      childResult = await runChild(
        resolve(__dirname, 'experience', 'runner.ts'),
        ['--run', runName, '--tasks', taskIds],
        process.env,
        {
          idleTimeoutMs: positiveEnvMs('BENCHMARK_GYM_IDLE_TIMEOUT_MS', 1_800_000),
          hardTimeoutMs: positiveEnvMs('BENCHMARK_GYM_HARD_TIMEOUT_MS', 14_400_000),
        },
      );
    } catch (error) {
      console.error(`[benchmark] Gym Runner 启动失败：${error instanceof Error ? error.message : String(error)}`);
    }
    const exitCode = childResult?.exitCode ?? 1;
    if (childResult?.timedOut) {
      console.error(`[benchmark] Gym Runner ${childResult.timeoutKind} timeout（${childResult.elapsedMs}ms）`);
    }
    for (const definition of definitions) {
      const taskDir = join(GYM_RUN_DIR, runName, definition.id);
      const resultPath = join(taskDir, 'result.json');
      if (!existsSync(resultPath)) {
        if (exitCode !== 0) console.error(`[benchmark] ${definition.id} 缺结果，Gym exit=${exitCode}`);
        continue;
      }
      try {
        const result = JSON.parse(readFileSync(resultPath, 'utf8')) as GymTaskResult;
        attempts.get(definition.id)!.push({ result, evidencePath: taskDir });
      } catch (error) {
        console.error(`[benchmark] ${definition.id} 结果解析失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  return definitions.map(definition => normalizeGymAttempts(definition, attempts.get(definition.id) ?? []));
}

function gitValue(args: string[], fallback: string): string {
  try { return execFileSync('git', args, { cwd: REPO_DIR, encoding: 'utf8' }).trim() || fallback; }
  catch { return fallback; }
}

function stamp(): string { return new Date().toISOString().replace(/[:.]/g, '-'); }

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.list) { printList(args.profile); return; }
  const selected = selectCases(args);
  const runStamp = stamp();
  const runId = `BENCH-${runStamp}`;
  const startedAt = new Date().toISOString();
  console.log(`[benchmark] ${runId} · profile=${args.profile} · cases=${selected.length} · repeat=${args.repeat}`);

  const body = selected.filter(item => item.layer === 'body');
  const gym = selected.filter(item => item.source === 'gym');
  const results: BenchmarkCaseResult[] = [];
  if (body.length) results.push(...await runBody(body));
  if (gym.length) results.push(...await runGym(gym, runId, args.repeat));

  const { scores, gates } = calculateScores(results, selected);
  const bodyEnv = resolveBodyEvalEnvironment(process.env);
  const environment = {
    commit: gitValue(['rev-parse', '--short', 'HEAD'], 'unknown'),
    dirty: gitValue(['status', '--porcelain'], '') !== '',
    server: `body=${bodyEnv.host}:${bodyEnv.port}; gym=${process.env.GYM_HOST ?? '127.0.0.1'}:${process.env.GYM_PORT ?? '25565'}`,
    backend: process.env.BENCHMARK_BACKEND_URL ?? 'http://localhost:3000',
    profile: args.profile,
    targetedCase: args.only,
  };
  let report: BenchmarkReport = {
    schemaVersion: 'mineclaw-benchmark/v1',
    runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    environment,
    expectedCaseIds: selected.map(item => item.id),
    results,
    scores,
    gates,
    threshold: args.threshold,
    passed: passesBenchmark(scores, gates, args.threshold),
  };
  report = withBaselineDiff(report, loadBenchmarkBaseline());
  const paths = writeBenchmarkReport(report, runStamp);
  console.log(`[benchmark] ${report.passed ? 'PASS' : 'FAIL'} · overall=${scores.overall} · JSON=${paths.json} · MD=${paths.md}`);

  if (args.saveBaseline) {
    try { console.log(`[benchmark] baseline=${saveBenchmarkBaseline(report)}`); }
    catch (error) { console.error(`[benchmark] baseline 保存失败：${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; return; }
  }
  process.exitCode = report.passed ? 0 : 1;
}

void main().catch(error => {
  console.error(`[benchmark] 运行失败：${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exitCode = 1;
});
