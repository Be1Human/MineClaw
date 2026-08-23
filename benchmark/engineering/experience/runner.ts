/**
 * Engineering Experience / Reliability 行为结果测试 · 编排器
 * 契约说明：benchmark/engineering/experience/README.md
 *
 * 用法（在 apps/minecraft-companion 下）：
 *   node --import tsx/esm ../../benchmark/engineering/experience/runner.ts --run RUN-20260612-0300 --tasks T01,T02,T03
 *   node --import tsx/esm ../../benchmark/engineering/experience/runner.ts --run RUN-20260612-0300
 *
 * 流程（每任务）：基线环境 → tp/清背包 → 快照(前) → setup → qxy 聊天下指令
 *   → 轮询机判 → 快照(后) → 落档(result.json/runtime.log切片/snapshot.md/chat.log) → 清场
 */
import fs from 'fs';
import path from 'path';
import http from 'http';
import { fileURLToPath } from 'url';
import mineflayer from 'mineflayer';
import { Vec3 } from 'vec3';
import { Rcon } from './rcon.js';
import { TASKS, type Ctx, type TaskDef, type JudgeResult } from './tasks.js';
import { ensureEmbodiedOnline } from './backendLifecycle.js';
import { filterRuntimeLogForProfile, resolveRuntimeLogDir } from './runtimeEvidence.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BOT = process.env.GYM_BOT ?? process.env.BENCHMARK_BOT ?? 'LanYi';
const OWNER = process.env.GYM_OWNER ?? process.env.BENCHMARK_OWNER ?? 'qxy';
// Gym 契约固定使用本地训练服；不得继承线上 MC_HOST，避免 RCON/摆场误打远程服。
const MC_HOST = process.env.GYM_HOST ?? '127.0.0.1';
const MC_PORT = Number(process.env.GYM_PORT ?? 25565);
const MC_AUTH = process.env.GYM_AUTH === 'microsoft' ? 'microsoft' : 'offline';
const BACKEND_URL = new URL(process.env.BENCHMARK_BACKEND_URL ?? 'http://localhost:3000');
const REPO = path.resolve(__dirname, '../../..');
const APP_DIR = path.resolve(__dirname, '../../../apps/minecraft-companion');
const LOG_DIR = resolveRuntimeLogDir(APP_DIR);
const RUN_BASE = path.join(REPO, 'benchmark', 'reports', 'engineering', 'gym');

// ───────────────────────── CLI ─────────────────────────
const args = process.argv.slice(2);
function argOf(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}
const runName = argOf('run');
if (!runName) { console.error('需要 --run RUN-YYYYMMDD-HHMM'); process.exit(1); }
if (!/^[A-Za-z0-9_-]+$/.test(runName)) { console.error('--run 只能包含字母、数字、下划线和连字符'); process.exit(1); }
const taskFilter = argOf('tasks')?.split(',').map(s => s.trim());
const RUN_DIR = path.join(RUN_BASE, runName);
fs.mkdirSync(RUN_DIR, { recursive: true });

// ───────────────────────── 基础设施 ─────────────────────────
const rcon = new Rcon(
  process.env.GYM_RCON_HOST ?? MC_HOST,
  Number(process.env.GYM_RCON_PORT ?? 25575),
  process.env.GYM_RCON_PASSWORD ?? 'clawtest',
);
// connectOwner 在所有使用点前完成；definite assignment 让离线类型检查
// 正确表达这个初始化顺序，而不把整条控制链退化为可空类型。
let owner!: mineflayer.Bot;
let ownerMsgs: Array<{ at: number; text: string }> = [];
let botDeathSeen = false;
let targetProfileId: string | null = process.env.GYM_PROFILE_ID ?? null;

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
const nowIso = () => new Date().toISOString();

function httpJson(method: string, p: string, body?: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: BACKEND_URL.hostname,
      port: Number(BACKEND_URL.port || (BACKEND_URL.protocol === 'https:' ? 443 : 80)),
      path: p,
      method,
      headers: { 'Content-Type': 'application/json' },
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function backendBotStatus(): Promise<string> {
  try {
    const bots = await httpJson('GET', '/api/bots');
    const b = Array.isArray(bots)
      ? bots.find((x: any) => targetProfileId ? x.profileId === targetProfileId : x.fullStatus?.personality === BOT)
      : null;
    return b?.status ?? 'unknown';
  } catch { return 'backend-down'; }
}

function sameHost(left: string, right: string): boolean {
  const normalize = (value: string) => value === 'localhost' ? '127.0.0.1' : value;
  return normalize(left) === normalize(right);
}

async function resolveTargetProfileId(): Promise<string> {
  if (targetProfileId) return targetProfileId;
  const profiles = await httpJson('GET', '/api/profiles');
  const list = Array.isArray(profiles) ? profiles : [];
  const profile = list.find((item: any) => item.name === BOT
    && sameHost(String(item.server?.host ?? ''), MC_HOST)
    && Number(item.server?.port) === MC_PORT);
  if (!profile?.id) throw new Error(`找不到被测 Profile：name=${BOT} server=${MC_HOST}:${MC_PORT}`);
  targetProfileId = String(profile.id);
  return targetProfileId;
}

async function ensureBotOnline(): Promise<void> {
  const profileId = await resolveTargetProfileId();
  console.log(`[backend] 确保被测 Profile ${profileId} 已挂载游戏身体`);
  await ensureEmbodiedOnline({
    profileId,
    getStatus: backendBotStatus,
    post: p => httpJson('POST', p),
    sleep,
  });
  console.log(`[backend] ${BOT} 已上线`);
  await sleep(5000);
}

async function cancelActiveBotTasks(reason: string): Promise<void> {
  const profileId = await resolveTargetProfileId();
  await httpJson('POST', `/api/bots/${profileId}/tasks/cancel-active`, { reason });
}

function latestLogFile(): string | null {
  if (!fs.existsSync(LOG_DIR)) return null;
  const files = fs.readdirSync(LOG_DIR).filter(f => /^runtime-\d+\.log$/.test(f)).sort();
  return files.length ? path.join(LOG_DIR, files[files.length - 1]) : null;
}

// ───────────────────────── RCON 解析助手 ─────────────────────────
async function cmd(c: string): Promise<string> {
  const out = await rcon.send(c);
  return out;
}

async function getPos(name: string): Promise<{ x: number; y: number; z: number }> {
  const out = await cmd(`data get entity ${name} Pos`);
  const m = out.match(/\[([-\d.]+)d?,\s*([-\d.]+)d?,\s*([-\d.]+)d?\]/);
  if (!m) throw new Error(`Pos 解析失败: ${out}`);
  return { x: +m[1], y: +m[2], z: +m[3] };
}

async function getNum(name: string, pathExpr: string): Promise<number> {
  const out = await cmd(`data get entity ${name} ${pathExpr}`);
  const m = out.match(/data:\s*([-\d.]+)/);
  return m ? +m[1] : NaN;
}

function parseItems(out: string): Record<string, number> {
  // 1.21 NBT 物品项可能带嵌套 components:{...}，必须按括号深度切顶层段
  const items: Record<string, number> = {};
  const start = out.indexOf('[');
  if (start < 0) return items;
  let depth = 0, segStart = -1;
  for (let i = start; i < out.length; i++) {
    const ch = out[i];
    if (ch === '{') { if (depth === 0) segStart = i; depth++; }
    else if (ch === '}') {
      depth--;
      if (depth === 0 && segStart >= 0) {
        const seg = out.slice(segStart, i + 1);
        const id = seg.match(/id:\s*"minecraft:([a-z_0-9]+)"/)?.[1];
        if (id) {
          const count = +(seg.match(/count:\s*(\d+)/i)?.[1] ?? 1);
          items[id] = (items[id] ?? 0) + count;
        }
        segStart = -1;
      }
    }
  }
  return items;
}

/**
 * 服务器把 RCON 长回显截断在 ~121 字符（结尾省略号），整读 Inventory/Items 不可用。
 * 改为按索引逐项读（NBT 列表只含被占用槽位，索引连续），每条回显都很短。
 */
async function readItemList(prefix: string): Promise<Record<string, number>> {
  const items: Record<string, number> = {};
  for (let i = 0; i < 54; i++) {
    const idOut = await cmd(`data get ${prefix}[${i}].id`);
    const id = idOut.match(/"minecraft:([a-z_0-9]+)"/)?.[1];
    if (!id) break; // Found no elements → 列表结束
    const cntOut = await cmd(`data get ${prefix}[${i}].count`);
    const count = +(cntOut.match(/data:\s*(\d+)/)?.[1] ?? 1);
    items[id] = (items[id] ?? 0) + count;
  }
  return items;
}

async function getInv(name: string): Promise<Record<string, number>> {
  return readItemList(`entity ${name} Inventory`);
}

async function getChest(x: number, y: number, z: number): Promise<Record<string, number>> {
  return readItemList(`block ${x} ${y} ${z} Items`);
}

async function isBlock(x: number, y: number, z: number, block: string): Promise<boolean> {
  const out = await cmd(`execute if block ${x} ${y} ${z} ${block}`);
  return /passed/i.test(out);
}

async function countEntities(type: string, x: number, y: number, z: number, r: number): Promise<number> {
  const out = await cmd(`execute if entity @e[type=minecraft:${type},x=${x},y=${y},z=${z},distance=..${r}]`);
  const m = out.match(/count:\s*(\d+)/i);
  if (m) return +m[1];
  return /passed/i.test(out) ? 1 : 0;
}

async function daytime(): Promise<number> {
  const out = await cmd('time query daytime');
  return +(out.match(/(\d+)/)?.[1] ?? NaN);
}

// ───────────────────────── owner bot（带自动重连：服务器崩溃重启后必须回来） ─────────────────────────
let ownerReady = false;

async function connectOwner(): Promise<void> {
  ownerReady = false;
  await new Promise<void>((resolve, reject) => {
    owner = mineflayer.createBot({ host: MC_HOST, port: MC_PORT, username: OWNER, auth: MC_AUTH });
    const t = setTimeout(() => reject(new Error('owner bot 连接超时')), 30_000);
    owner.once('spawn', () => { clearTimeout(t); ownerReady = true; resolve(); });
    owner.once('error', e => { clearTimeout(t); reject(e); });
    owner.on('message', m => {
      const text = m.toString();
      ownerMsgs.push({ at: Date.now(), text });
      if (ownerMsgs.length > 3000) ownerMsgs.shift();
      // 死亡消息检测（英文服死亡播报以 bot 名开头）
      if (new RegExp(`^${BOT} (was |died|drowned|fell|burned|tried |starved|suffocated|blew |hit |went |walked |discovered|froze|left the game)`).test(text)
        && !/left the game/.test(text)) {
        botDeathSeen = true;
      }
    });
    owner.on('kicked', r => console.log(`[owner] kicked: ${JSON.stringify(r)}`));
    owner.on('end', r => {
      console.log(`[owner] end: ${r} · 5s 后自动重连`);
      ownerReady = false;
      setTimeout(async () => {
        for (let i = 0; i < 30 && !ownerReady; i++) {
          try { await connectOwner(); console.log('[owner] 已自动重连'); break; }
          catch (e) { console.log(`[owner] 重连失败(${i + 1}/30): ${(e as Error).message}`); await sleep(10_000); }
        }
      }, 5000);
    });
  });
  await cmd(`gamemode creative ${OWNER}`);
}

/** 等 owner 在线（崩溃重连窗口内阻塞，最多 120s） */
async function ownerOnline(): Promise<void> {
  for (let i = 0; i < 60 && !ownerReady; i++) await sleep(2000);
  if (!ownerReady) throw new Error('owner bot 离线且重连超时');
}

async function findBlocksViaOwner(names: string[], center: { x: number; y: number; z: number }, maxDistance: number, count = 64): Promise<Array<{ x: number; y: number; z: number }>> {
  try {
    const ids = names
      .map(n => (owner.registry as any).blocksByName?.[n]?.id)
      .filter((v: unknown) => typeof v === 'number');
    if (!ids.length) return [];
    const vecs = owner.findBlocks({
      matching: ids,
      point: new Vec3(center.x, center.y, center.z),
      maxDistance,
      count,
    });
    return vecs.map((v: any) => ({ x: v.x, y: v.y, z: v.z }));
  } catch (e) {
    console.log(`[owner] findBlocks 失败: ${(e as Error).message}`);
    return [];
  }
}

// ───────────────────────── 快照与落档 ─────────────────────────
interface Snapshot { at: string; pos: any; health: number; food: number; inv: Record<string, number>; daytime: number }

async function takeSnapshot(): Promise<Snapshot> {
  return {
    at: nowIso(),
    pos: await getPos(BOT).catch(() => null),
    health: await getNum(BOT, 'Health').catch(() => NaN),
    food: await getNum(BOT, 'foodLevel').catch(() => NaN),
    inv: await getInv(BOT).catch(() => ({})),
    daytime: await daytime().catch(() => NaN),
  };
}

function fmtSnapshot(label: string, s: Snapshot): string {
  return [
    `## ${label}（${s.at}）`,
    '',
    `| 项 | 值 |`,
    `|---|---|`,
    `| 坐标 | ${s.pos ? `(${s.pos.x.toFixed(1)}, ${s.pos.y.toFixed(1)}, ${s.pos.z.toFixed(1)})` : 'N/A'} |`,
    `| 血量 | ${s.health} |`,
    `| 饥饿 | ${s.food} |`,
    `| daytime | ${s.daytime} |`,
    `| 背包 | ${Object.entries(s.inv).map(([k, v]) => `${k}×${v}`).join(' · ') || '（空）'} |`,
    '',
  ].join('\n');
}

// ───────────────────────── 单任务执行 ─────────────────────────
interface TaskResult {
  task: string; name: string; verdict: 'PASS' | 'FAIL' | 'CRASH';
  durationMs: number; startedAt: string; endedAt: string;
  instructionDurationMs?: number;
  responseLatencyMs?: number;
  failureKind?: 'task_failure' | 'false_complete' | 'hung' | 'terminal_mismatch' | 'crash' | 'harness_error';
  checks: JudgeResult['checks']; died: boolean; notes: string[];
}

const SUCCESS_FEEDBACK_RE = /完成|搞定|做好|已经.*(?:到达|收集|制作|放好)|done|finished|completed/i;
const FAILURE_FEEDBACK_RE = /无法|不能|失败|做不到|进不去|到不了|需要.*帮|帮忙|blocked|cannot|can't|failed/i;
const TERMINAL_GRACE_MS = 12_000;

async function baselineEnv(): Promise<void> {
  await cmd('time set day');
  await cmd('gamerule doMobSpawning false');
  await cmd('gamerule doDaylightCycle false');
  await cmd('gamerule doWeatherCycle false');
  await cmd('weather clear');
  await cmd('difficulty normal');
  await cmd(`gamemode survival ${BOT}`);
  // BUG-CROSS-18 · 每个 case 恢复生命/饥饿，避免 T10 等状态泄漏到后续用例。
  await cmd(`effect clear ${BOT}`);
  await cmd(`effect give ${BOT} minecraft:instant_health 1 255 true`);
  await cmd(`effect give ${BOT} minecraft:saturation 1 255 true`);
  await sleep(500);
  await cmd(`effect clear ${BOT}`);
}

async function clearArena(X: number): Promise<void> {
  // 清地表建筑（y -60..-45），分层避免超 32768
  for (let y = -60; y <= -46; y += 2) {
    await cmd(`fill ${X - 30} ${y} -45 ${X + 59} ${Math.min(y + 1, -46)} 45 minecraft:air`);
  }
  // 清掉落物与遗留怪
  await cmd(`kill @e[type=minecraft:item,x=${X},y=-60,z=0,distance=..100]`);
  for (const t of ['zombie', 'skeleton', 'cow', 'creeper', 'spider', 'drowned']) {
    await cmd(`kill @e[type=minecraft:${t},x=${X},y=-60,z=0,distance=..100]`);
  }
}

async function runTask(def: TaskDef, idx: number): Promise<TaskResult> {
  const X = (idx + 1) * 200;
  const dir = path.join(RUN_DIR, def.id);
  fs.mkdirSync(dir, { recursive: true });
  const notes: string[] = [];
  botDeathSeen = false;
  const chatStart = ownerMsgs.length;
  let observationStart = Date.now();
  const evidenceProfileId = await resolveTargetProfileId();

  const logFile = latestLogFile();
  const logOffset = logFile ? fs.statSync(logFile).size : 0;
  const startedAt = nowIso();
  const t0 = Date.now();
  console.log(`\n━━━ ${def.id} ${def.name} ━━━ X=${X}`);

  const ctx: Ctx = {
    cmd, say: async (text) => { await ownerOnline(); owner.chat(text); console.log(`[qxy说] ${text}`); },
    botName: BOT, X,
    botPos: () => getPos(BOT),
    botFood: () => getNum(BOT, 'foodLevel'),
    botHealth: () => getNum(BOT, 'Health'),
    botInv: () => getInv(BOT),
    chestItems: getChest,
    isBlock,
    countEntities,
    findBlocks: findBlocksViaOwner,
    daytime,
    botDied: () => botDeathSeen,
    elapsed: () => Date.now() - t0,
    botMessages: () => ownerMsgs
      .filter(message => message.at >= observationStart && message.text.includes(`<${BOT}>`))
      .map(message => ({ ...message })),
    botSaid: (pattern) => {
      const safeFlags = pattern.flags.replace(/g/g, '');
      const matcher = new RegExp(pattern.source, safeFlags);
      return ownerMsgs.some(message => message.at >= observationStart
        && message.text.includes(`<${BOT}>`)
        && matcher.test(message.text));
    },
    log: (m) => console.log(m),
    state: {},
  };

  let verdict: TaskResult['verdict'] = 'FAIL';
  let judge: JudgeResult = { pass: false, checks: [] };
  let snapBefore: Snapshot | null = null;
  let snapAfter: Snapshot | null = null;
  let instrAt: number | undefined;
  let harnessError: string | undefined;

  try {
    // 1. 基线 + 就位
    await cancelActiveBotTasks(`gym_case_start:${def.id}`);
    await baselineEnv();
    await clearArena(X);
    await cmd(`effect clear ${BOT}`);
    await cmd(`clear ${BOT}`);
    // 主人先就位（加载区块），再传被测 bot
    const op = def.ownerPos ?? { dx: -14, dz: 0 };
    await cmd(`tp ${OWNER} ${X + op.dx} -58 ${op.dz}`);
    await sleep(3000);
    await cmd(`tp ${BOT} ${X + def.start.dx} -60 ${def.start.dz}`);
    await sleep(2000);
    // 让 bot 收手待命（上一任务残留任务收口）
    await ctx.say('先停下手头所有事，原地待命，听我下一个指令');
    await sleep(8000);

    // 2. 搭场
    await def.setup(ctx);
    await sleep(1500);
    snapBefore = await takeSnapshot();

    // 3. 下发任务指令
    const instructionStartedAt = Date.now();
    instrAt = instructionStartedAt;
    observationStart = instructionStartedAt;
    await ctx.say(def.instruction);
    const deadline = t0 + def.timeoutMs + 60_000; // 含就位耗时余量
    let clarified = false;

    if (def.afterInstruction) await def.afterInstruction(ctx);

    // 4. 轮询机判
    while (Date.now() < deadline && Date.now() - instructionStartedAt < def.timeoutMs) {
      await sleep(def.pollMs);
      // bot 反问 → 主人一次性答疑（模拟真实对话）
      if (!clarified && def.clarification) {
        const asked = ownerMsgs.some(m => m.at > instructionStartedAt && m.text.includes(`<${BOT}>`) && /[?？]|坐标|哪里|哪儿|在哪/.test(m.text));
        if (asked) {
          clarified = true;
          const ans = def.clarification(ctx);
          await ctx.say(ans);
          notes.push(`bot 反问 → 主人答疑: ${ans}`);
        }
      }
      const status = await backendBotStatus();
      if (status !== 'online') {
        verdict = 'CRASH';
        notes.push(`后端 bot 状态=${status}（疑似崩溃/掉线）@ ${nowIso()}`);
        break;
      }
      try {
        judge = await def.judge(ctx);
      } catch (e) {
        notes.push(`judge 异常: ${(e as Error).message}`);
        continue;
      }
      if (judge.pass) {
        verdict = 'PASS';
        // BUG-CROSS-18 · 物理完成与异步任务终态有时间差；给成功反馈一个有界宽限期。
        if ((def.expectedTerminal ?? 'success') === 'success') {
          const graceDeadline = Date.now() + TERMINAL_GRACE_MS;
          while (Date.now() < graceDeadline) {
            if (ctx.botSaid(SUCCESS_FEEDBACK_RE) || ctx.botSaid(FAILURE_FEEDBACK_RE)) break;
            await sleep(1000);
          }
          const stableJudge = await def.judge(ctx);
          judge = stableJudge;
          if (!stableJudge.pass) verdict = 'FAIL';
        }
        break;
      }
    }
    if (verdict === 'FAIL') {
      // 终判一次（拿到最终 checks 值）
      try { judge = await def.judge(ctx); if (judge.pass) verdict = 'PASS'; } catch { /* keep */ }
    }
  } catch (e) {
    harnessError = (e as Error).message;
    notes.push(`harness 异常: ${harnessError}`);
  }

  snapAfter = await takeSnapshot().catch(() => null as any);
  const endedAt = nowIso();
  const durationMs = Date.now() - t0;

  // 5. 落档
  const instructionDurationMs = instrAt === undefined ? undefined : Date.now() - instrAt;
  const taskMessages = instrAt === undefined
    ? []
    : ownerMsgs.filter(message => message.at >= instrAt && message.text.includes(`<${BOT}>`));
  const responseLatencyMs = instrAt === undefined || !taskMessages.length ? undefined : taskMessages[0].at - instrAt;
  const allBotText = taskMessages.map(message => message.text).join('\n');
  const saidSuccess = SUCCESS_FEEDBACK_RE.test(allBotText);
  const saidFailure = FAILURE_FEEDBACK_RE.test(allBotText);
  const expectedTerminal = def.expectedTerminal ?? 'success';
  let failureKind: TaskResult['failureKind'];
  if (verdict === 'CRASH') failureKind = 'crash';
  else if (harnessError) failureKind = 'harness_error';
  else if (verdict === 'FAIL' && expectedTerminal === 'success' && saidSuccess) failureKind = 'false_complete';
  else if (verdict === 'PASS' && expectedTerminal === 'success' && saidFailure && !saidSuccess) failureKind = 'terminal_mismatch';
  else if (verdict === 'FAIL' && instructionDurationMs !== undefined
    && instructionDurationMs >= def.timeoutMs - def.pollMs * 2 && !saidFailure) failureKind = 'hung';
  else if (verdict === 'FAIL') failureKind = 'task_failure';

  const result: TaskResult = {
    task: def.id, name: def.name, verdict, durationMs, startedAt, endedAt,
    instructionDurationMs, responseLatencyMs, failureKind,
    checks: judge.checks, died: botDeathSeen, notes,
  };
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2), 'utf8');

  // runtime.log 切片（按偏移量）
  try {
    const lf = latestLogFile();
    if (lf && lf === logFile) {
      const fd = fs.openSync(lf, 'r');
      const size = fs.statSync(lf).size;
      const buf = Buffer.alloc(size - logOffset);
      fs.readSync(fd, buf, 0, buf.length, logOffset);
      fs.closeSync(fd);
      fs.writeFileSync(
        path.join(dir, 'runtime.log'),
        filterRuntimeLogForProfile(buf.toString('utf8'), evidenceProfileId),
        'utf8',
      );
    } else if (lf) {
      fs.writeFileSync(
        path.join(dir, 'runtime.log'),
        filterRuntimeLogForProfile(fs.readFileSync(lf, 'utf8'), evidenceProfileId),
        'utf8',
      );
    }
  } catch (e) { notes.push(`日志切片失败: ${(e as Error).message}`); }

  // 聊天记录（owner 视角全量服务器消息）
  const chatLines = ownerMsgs.slice(chatStart).map(m => `${new Date(m.at).toISOString()} ${m.text}`);
  fs.writeFileSync(path.join(dir, 'chat.log'), chatLines.join('\n'), 'utf8');

  // 快照
  const snapMd = [
    `# ${def.id} ${def.name} · 快照`, '',
    snapBefore ? fmtSnapshot('指令下发前', snapBefore) : '（前快照缺失）',
    snapAfter ? fmtSnapshot('判定结束后', snapAfter) : '（后快照缺失）',
    `## 判定明细`, '',
    `| 检查项 | 期望 | 实测 | 结果 |`, `|---|---|---|---|`,
    ...result.checks.map(c => `| ${c.name} | ${c.expect} | ${c.actual} | ${c.ok ? '✅' : '❌'} |`),
    '', `**判定**：${verdict} · 用时 ${(durationMs / 1000).toFixed(0)}s${result.died ? ' · 💀 期间死亡' : ''}`,
    notes.length ? `\n**备注**：\n${notes.map(n => `- ${n}`).join('\n')}` : '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'snapshot.md'), snapMd, 'utf8');

  // 6. 清场
  try {
    await cancelActiveBotTasks(`gym_case_end:${def.id}`);
    await def.cleanup?.(ctx);
    await clearArena(X);
    await cmd(`clear ${BOT}`);
    await baselineEnv();
  } catch (e) { console.log(`[cleanup] ${(e as Error).message}`); }

  // CRASH 自愈：尝试拉起
  if (verdict === 'CRASH') {
    try {
      const pid = await resolveTargetProfileId();
      if (pid) {
        await ensureEmbodiedOnline({
          profileId: pid,
          getStatus: backendBotStatus,
          post: p => httpJson('POST', p),
          sleep,
        });
        console.log('[heal] bot 已重新上线');
      }
    } catch (e) { console.log(`[heal] 失败: ${(e as Error).message}`); }
  }

  console.log(`━━━ ${def.id} ${verdict} (${(durationMs / 1000).toFixed(0)}s) ${result.checks.map(c => `${c.name}=${c.actual}${c.ok ? '✓' : '✗'}`).join(' · ')}`);
  return result;
}

// ───────────────────────── 主流程 ─────────────────────────
(async () => {
  console.log(`健身房 RUN: ${runName} → ${RUN_DIR}`);
  await rcon.connect();
  console.log('[rcon] 已连接');
  await ensureBotOnline();
  await connectOwner();
  console.log(`[owner] ${OWNER} 已上线（creative）`);

  const list = taskFilter ? TASKS.filter(t => taskFilter.includes(t.id)) : TASKS;
  const results: TaskResult[] = [];
  for (const def of list) {
    const idx = TASKS.indexOf(def);
    const r = await runTask(def, idx);
    results.push(r);
    // 增量更新汇总
    const sumPath = path.join(RUN_DIR, '汇总.md');
    const existing: TaskResult[] = [];
    for (const t of TASKS) {
      const f = path.join(RUN_DIR, t.id, 'result.json');
      if (fs.existsSync(f)) existing.push(JSON.parse(fs.readFileSync(f, 'utf8')));
    }
    const lines = [
      `# 健身房全量测试 · ${runName} · 汇总`, '',
      `| # | 任务 | 结果 | 耗时 | 死亡 | 关键实测 |`, `|---|---|---|---|---|---|`,
      ...existing.map(r2 => `| ${r2.task} | ${r2.name} | ${r2.verdict === 'PASS' ? '✅ PASS' : r2.verdict === 'CRASH' ? '💥 CRASH' : '❌ FAIL'} | ${(r2.durationMs / 1000).toFixed(0)}s | ${r2.died ? '💀' : '—'} | ${r2.checks.map(c => `${c.name}=${c.actual}`).join(' · ')} |`),
      '', `更新于 ${nowIso()}`,
    ];
    fs.writeFileSync(sumPath, lines.join('\n'), 'utf8');
  }

  console.log('\n══════ 本批完成 ══════');
  for (const r of results) console.log(`${r.task} ${r.verdict}`);
  owner?.end();
  rcon.close();
  process.exit(0);
})().catch(e => { console.error('runner 失败:', e); process.exit(1); });
