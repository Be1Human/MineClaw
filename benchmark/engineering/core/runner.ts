/**
 * 评测体系 · 入口编排（FEAT-CROSS-02 · 阶段〇）
 *
 * 流程：连导演+被测 → op 自检 → 稳定环境 → 逐场景(每场景重建竞技场) × repeat：
 *   reset → setup(摆场) → settle → inject → 轮询 sample/success 直到成功或超时 → 记录
 * 汇总 → 写 reports/eval-<ts>.json+.md（自动与 baseline 比对）。
 *
 * CLI：
 *   npm run eval                               完整套件
 *   npm run eval:quick                         快跑（repeat 3）
 *   npm run eval -- --scenario NAV-02          单场景
 *   npm run eval -- --suite full --save-baseline
 *
 * 环境变量：EVAL_HOST(localhost) EVAL_PORT(25565) EVAL_VERSION(1.20.4)
 *           EVAL_ANCHOR_X/Y/Z  导演/被测用户名 EVAL_DIRECTOR / EVAL_SUBJECT
 *           EVAL_AUTH(优先) / MC_AUTH（offline 或 microsoft）
 */

import 'dotenv/config';
import { Director, sleep } from './director.js';
import { Subject } from './subject.js';
import { selectScenarios } from '../body/index.js';
import { aggregate, buildReport, writeReports, saveAsBaseline } from './report.js';
import type { RunResult, ScenarioResult, ScenarioSpec, Suite } from './types.js';

// ─────────────── 全局兜底 ────────────────
// 评测异常必须以非零退出码暴露给 CI/验收，不能只打印后被误判为通过。
process.on('uncaughtException', (e) => {
  console.error('[eval] uncaughtException:', e);
  process.exitCode = 1;
});
process.on('unhandledRejection', (e) => {
  console.error('[eval] unhandledRejection:', e);
  process.exitCode = 1;
});

interface Args { suite: Suite; only?: string; saveBaseline: boolean }

function parseArgs(argv: string[]): Args {
  const a: Args = { suite: 'full', saveBaseline: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--suite') a.suite = (argv[++i] as Suite) ?? 'full';
    else if (k === '--scenario') a.only = argv[++i];
    else if (k === '--save-baseline') a.saveBaseline = true;
  }
  return a;
}

const log = (msg: string) => console.log(`[eval] ${msg}`);

function nowIso(): string { return new Date().toISOString(); }
function tsStamp(): string { return new Date().toISOString().replace(/[:.]/g, '-'); }

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // 默认回退到 .env 的 MC_HOST/MC_PORT（项目线上服），再回退 localhost
  const host = process.env.EVAL_HOST ?? process.env.MC_HOST ?? 'localhost';
  const port = parseInt(process.env.EVAL_PORT ?? process.env.MC_PORT ?? '25565', 10);
  // 不写死版本：缺省 undefined → mineflayer 自动协商（线上服当前为 1.21.x）
  const version = process.env.EVAL_VERSION || undefined;
  const authRaw = process.env.EVAL_AUTH ?? process.env.MC_AUTH ?? 'offline';
  const auth = authRaw === 'microsoft' ? 'microsoft' : 'offline';
  const directorName = process.env.EVAL_DIRECTOR ?? 'EvalDirector';
  const subjectName = process.env.EVAL_SUBJECT ?? 'EvalSubject';
  const anchor = {
    x: parseInt(process.env.EVAL_ANCHOR_X ?? '1000', 10),
    y: parseInt(process.env.EVAL_ANCHOR_Y ?? '120', 10),
    z: parseInt(process.env.EVAL_ANCHOR_Z ?? '1000', 10),
  };
  const server = `${host}:${port}`;

  log(`server=${server} anchor=(${anchor.x},${anchor.y},${anchor.z}) suite=${args.suite}${args.only ? ` only=${args.only}` : ''}`);

  // watchdog 计数（被测 bus 透传）
  let wdCount = 0;

  const director = new Director({ host, port, username: directorName, auth, version, anchor, onLog: log });
  const subject = new Subject({
    host, port, username: subjectName, auth, version, anchor,
    ownerName: directorName,   // 跟随场景：owner = 导演
    onLog: (m) => { if (process.env.EVAL_VERBOSE) log(`[subj] ${m}`); },
    onEvent: (type) => { if (type === 'heartbeat.executing_watchdog') wdCount++; },
  });

  log('连接导演...');
  await director.connect();
  log('连接被测...');
  await subject.connect();
  // 等被测感知预热
  await sleep(2000);

  const op = await director.checkOp();
  log(`op 自检：${op ? '✅ 有权限' : '⚠️ 疑似无 op（命令可能被拒）'}`);
  await director.stabilizeEnv();

  // ── 启动自检：tp subject 到 anchor 再读回坐标，验证 op→tp→位置 整链 ──
  await director.prepareArena(96, 6);
  const tpAt = Date.now();
  await director.tp(subjectName, 0, 0, 0);
  await sleep(1500);
  const serverReplies = director.messagesSince(tpAt).filter(t => t.trim()).slice(-8);
  if (serverReplies.length) log(`自检·服务器对命令的回复：\n   ${serverReplies.join('\n   ')}`);
  const probePos = subject.pos();
  const expect = subject.world(0, 0, 0);
  const probeDist = Math.sqrt(
    (probePos.x - expect.x) ** 2 + (probePos.y - expect.y) ** 2 + (probePos.z - expect.z) ** 2,
  );
  log(`自检：subject 实际位置 (${probePos.x.toFixed(1)},${probePos.y.toFixed(1)},${probePos.z.toFixed(1)}) · 期望 anchor (${expect.x},${expect.y},${expect.z}) · 偏差 ${probeDist.toFixed(1)} 格`);
  if (probeDist > 5) {
    log('❌ 自检失败：subject 未被传送到竞技场（op/tp 未生效）。中止评测——请确认 EvalDirector 有 op。');
    await teardown(director, subject);
    return;
  }
  log('✅ 自检通过：摆场链路正常');

  const factories = selectScenarios({ suite: args.suite, only: args.only });
  if (factories.length === 0) { log('没有匹配的场景，退出'); await teardown(director, subject); return; }

  const startedAt = nowIso();
  const results: ScenarioResult[] = [];

  for (const factory of factories) {
    const probe = factory();
    // matrix 默认 repeat=2（时长可控）；quick 降到 ≤3；full 用模板 repeat
    const repeat = args.suite === 'matrix' ? 2
      : args.suite === 'quick' ? Math.min(3, probe.repeat)
        : probe.repeat;
    log(`▶ ${probe.id} ${probe.title} · repeat=${repeat} · ${probe.category ?? '?'}`);

    // 每场景重建竞技场，抹掉上一场景遗留结构
    await director.prepareArena(96, 6);

    const runs: RunResult[] = [];
    for (let i = 0; i < repeat; i++) {
      const spec = factory();   // 全新闭包，采样状态不串场
      const r = await runOnce(spec, director, subject, () => wdCount);
      runs.push(r);
      log(`   #${i + 1}/${repeat} → ${r.ok ? '✅' : '❌'} ${(r.durationMs / 1000).toFixed(1)}s${r.reason ? ` (${r.reason})` : ''}${r.watchdogHits ? ` wd=${r.watchdogHits}` : ''}`);
    }
    results.push(aggregate({ id: probe.id, title: probe.title, suite: probe.suite, category: probe.category, repeat }, runs));
  }

  const finishedAt = nowIso();
  const report = buildReport(results, { startedAt, finishedAt, suite: args.suite, server });
  const { json, md } = writeReports(report, tsStamp());
  log(`报告已写：\n  ${json}\n  ${md}`);
  log(`平均成功率 ${(report.summary.avgSuccessRate * 100).toFixed(0)}% · watchdog 强拆 ${report.summary.totalWatchdogHits} 次`);

  if (args.saveBaseline) {
    const bp = saveAsBaseline(report);
    log(`✅ 已存为基线：${bp}`);
  }

  await teardown(director, subject);
}

/** 跑一次场景，返回结果 */
async function runOnce(
  spec: ScenarioSpec,
  director: Director,
  subject: Subject,
  wd: () => number,
): Promise<RunResult> {
  await subject.reset();
  subject.clearMoveResult();
  const wdStart = wd();
  try {
    await spec.setup(director, subject);
    await sleep(1200); // 摆场生效 + 感知刷新
    const t0 = Date.now();
    await spec.inject(subject);

    const pollMs = 500;
    while (true) {
      await sleep(pollMs);
      try { spec.sample?.(subject); } catch { /* 采样失败忽略 */ }
      const elapsed = Date.now() - t0;
      // 提前判负（死亡等）
      let dead = false;
      try { dead = spec.failFast?.(subject) ?? false; } catch { dead = false; }
      if (dead) return { ok: false, durationMs: elapsed, reason: 'failfast', watchdogHits: wd() - wdStart };
      // 成功
      let ok = false;
      try { ok = spec.success(subject); } catch { ok = false; }
      if (ok) return { ok: true, durationMs: elapsed, watchdogHits: wd() - wdStart };
      // 超时：存活类场景用 endCheck 判定"撑到时间=胜"
      if (elapsed > spec.timeoutMs) {
        let survived = false;
        try { survived = spec.endCheck?.(subject) ?? false; } catch { survived = false; }
        return survived
          ? { ok: true, durationMs: elapsed, watchdogHits: wd() - wdStart }
          : { ok: false, durationMs: elapsed, reason: 'timeout', watchdogHits: wd() - wdStart };
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, durationMs: 0, reason: `error:${msg}`, watchdogHits: wd() - wdStart };
  } finally {
    try { await spec.teardown?.(director, subject); } catch { /* 清场失败忽略 */ }
    await subject.reset();
  }
}

async function teardown(director: Director, subject: Subject): Promise<void> {
  log('收尾断开...');
  try { await subject.disconnect(); } catch { /* ignore */ }
  try { await director.disconnect(); } catch { /* ignore */ }
  await sleep(500);
}

async function runCli(): Promise<void> {
  try {
    await main();
    process.exitCode = 0;
  } catch (e: unknown) {
    console.error('[eval] 运行失败:', e);
    process.exitCode = 1;
  } finally {
    // BUG-CROSS-05 · harness 的终态必须有界；资源由 main/teardown 先行关闭，
    // 短延迟只用于冲刷 stdout。若第三方库仍留 handle，也不能让父 Benchmark 永久等待。
    const code = process.exitCode ?? 0;
    setTimeout(() => process.exit(code), 100).unref();
  }
}

void runCli();
