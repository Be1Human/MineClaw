#!/usr/bin/env node
/**
 * build-maze.mjs · 迷宫压测摆场脚本（独立建造 bot）
 *
 * 连本地训练服 127.0.0.1:25565（offline），用 /fill+/setblock 秒建一个
 * 「石墙3格高(跳不过) + 多道真·木门」的递归回溯迷宫，单出口，出口外放金块当目标。
 * 建完把 agent bot（默认 LanYi）回血回饱食 → tp 到迷宫起点 → 退出。
 *
 * 需要建造 bot 有 op：脚本会先探测权限，没 op 会明确提示你在服务器 console
 *   /op MazeBuilder
 * 后重跑，不会留下半截脏建筑。
 *
 * 用法：
 *   node scripts/build-maze.mjs                 # 默认 6x6 cell 迷宫
 *   node scripts/build-maze.mjs --n 8 --doors 10 --agent LanYi
 *   node scripts/build-maze.mjs --x0 40 --z0 40 # 迷宫西北角世界坐标
 */
import mineflayer from 'mineflayer';

// ── 参数 ────────────────────────────────────────────────────────────────────
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => {
    if (cur.startsWith('--')) acc.push([cur.slice(2), arr[i + 1]]);
    return acc;
  }, []),
);
const N      = parseInt(args.n ?? '6', 10);       // cells per side
const DOORS  = parseInt(args.doors ?? '8', 10);   // 真门数量
const X0     = parseInt(args.x0 ?? '40', 10);     // 迷宫西北角 world x
const Z0     = parseInt(args.z0 ?? '40', 10);     // 迷宫西北角 world z
const FLOORY = parseInt(args.floory ?? '-60', 10);// bot 站立面 y（墙占 y..y+2）
const AGENT  = args.agent ?? 'LanYi';             // 要 tp 进迷宫的 agent 名
const HOST   = args.host ?? '127.0.0.1';
const PORT   = parseInt(args.port ?? '25565', 10);
const WALL   = args.wall ?? 'stone';
const DELAY  = parseInt(args.delay ?? '1100', 10); // 指令间隔 ms（vanilla 反刷屏要求持续≤~1条/秒，否则 disconnect.spam）

const W = 2 * N + 1; // 迷宫边长（格）
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── 迷宫生成（递归回溯）────────────────────────────────────────────────────
// grid[gx][gz]: 1=墙 0=通路 · 房间在奇数坐标，墙在偶数坐标
function genMaze() {
  const g = Array.from({ length: W }, () => new Array(W).fill(1));
  // 简易确定性 PRNG（带种子，便于复现）
  let seed = parseInt(args.seed ?? '1337', 10);
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

  const carve = (cx, cz) => {
    g[cx][cz] = 0;
    for (const [dx, dz] of shuffle([[0, -2], [0, 2], [-2, 0], [2, 0]])) {
      const nx = cx + dx, nz = cz + dz;
      if (nx > 0 && nx < W - 1 && nz > 0 && nz < W - 1 && g[nx][nz] === 1) {
        g[cx + dx / 2][cz + dz / 2] = 0; // 打通中间墙
        carve(nx, nz);
      }
    }
  };
  carve(1, 1);
  return g;
}

// ── 主流程 ──────────────────────────────────────────────────────────────────
const bot = mineflayer.createBot({ host: HOST, port: PORT, username: 'MazeBuilder', auth: 'offline' });

let opOk = null;            // null=未知 true/false
const sysLines = [];
bot.on('message', (json) => {
  const t = json.toString();
  sysLines.push(t);
  // vanilla: "no permission" · Paper/Spigot 把无权限命令伪装成 "Unknown or incomplete command"
  if (/you do not have permission|don't have permission|没有权限|无权|unknown or incomplete command/i.test(t)) opOk = false;
});

bot.once('spawn', async () => {
  console.log(`[build-maze] connected as MazeBuilder · 迷宫 ${W}x${W} @ (${X0},${FLOORY},${Z0}) · 门×${DOORS}`);
  await sleep(800);

  // ── op 探测：放一块再查，无权限会收到拒绝消息 ──
  const probeX = X0 - 3, probeZ = Z0 - 3;
  bot.chat(`/setblock ${probeX} ${FLOORY} ${probeZ} ${WALL}`);
  await sleep(700);
  if (opOk === false) {
    console.error('\n❌ MazeBuilder 没有 op 权限，/setblock 被拒。');
    console.error('   请在服务器后台 console 执行：  op MazeBuilder');
    console.error('   然后重跑：  node scripts/build-maze.mjs\n');
    console.error('   最近服务器消息：', sysLines.slice(-4).join(' | '));
    bot.quit();
    process.exit(2);
  }
  // 清掉探测块
  bot.chat(`/setblock ${probeX} ${FLOORY} ${probeZ} air`);
  await sleep(DELAY);
  console.log('[build-maze] op 权限 OK，开建…');

  const g = genMaze();

  // 出口：南边最后一个房间格 (2N-1, 2N) 打通 → 单一出口
  const exitGx = 2 * N - 1, exitGz = W - 1; // 在边界墙上开口
  g[exitGx][exitGz] = 0;

  // ── 1. 整块填实成墙（1 条 /fill · 省指令防刷屏踢人）──
  await cmd(`/fill ${X0} ${FLOORY} ${Z0} ${X0 + W - 1} ${FLOORY + 2} ${Z0 + W - 1} ${WALL}`);

  // ── 2. 逐格掏通路：每个 passage 格 1 条 /fill air 掏 3 格高 ──
  let carveCount = 0;
  for (let gx = 0; gx < W; gx++) {
    for (let gz = 0; gz < W; gz++) {
      if (g[gx][gz] !== 0) continue;
      const wx = X0 + gx, wz = Z0 + gz;
      await cmd(`/fill ${wx} ${FLOORY} ${wz} ${wx} ${FLOORY + 2} ${wz} air`);
      carveCount++;
    }
  }
  console.log(`[build-maze] 通路掏完 · ${carveCount} 格`);

  // ── 3. 真门：在通路格里挑 degree==2 的走廊放 oak_door（2 半块）──
  const passages = [];
  for (let gx = 1; gx < W - 1; gx++) {
    for (let gz = 1; gz < W - 1; gz++) {
      if (g[gx][gz] !== 0) continue;
      const deg = [[0,1],[0,-1],[1,0],[-1,0]].filter(([dx,dz]) => g[gx+dx]?.[gz+dz] === 0).length;
      if (deg === 2) passages.push([gx, gz]);
    }
  }
  // 均匀抽样 DOORS 个
  const step = Math.max(1, Math.floor(passages.length / DOORS));
  let doorCount = 0;
  for (let i = 0; i < passages.length && doorCount < DOORS; i += step) {
    const [gx, gz] = passages[i];
    const dx = X0 + gx, dz = Z0 + gz;
    // 门朝向取决于走廊走向：南北通道门 facing 朝 west/east 都行，这里统一 facing=north
    await cmd(`/setblock ${dx} ${FLOORY} ${dz} oak_door[half=lower,facing=north]`);
    await cmd(`/setblock ${dx} ${FLOORY + 1} ${dz} oak_door[half=upper,facing=north]`);
    doorCount++;
  }
  console.log(`[build-maze] 门装完 · ${doorCount} 道`);

  // ── 4. 出口外放金块当目标灯塔 ──
  const goalX = X0 + exitGx, goalZ = Z0 + W + 1;
  await cmd(`/setblock ${goalX} ${FLOORY} ${goalZ} gold_block`);
  console.log(`[build-maze] 目标金块 @ (${goalX},${FLOORY},${goalZ})`);

  // ── 5. agent 回血回饱食 + tp 到迷宫起点 (1,1) ──
  const startX = X0 + 1, startZ = Z0 + 1;
  await cmd(`/effect give ${AGENT} minecraft:instant_health 1 10`);
  await cmd(`/effect give ${AGENT} minecraft:saturation 3 10`);
  await cmd(`/effect give ${AGENT} minecraft:regeneration 8 3`);
  await cmd(`/tp ${AGENT} ${startX + 0.5} ${FLOORY} ${startZ + 0.5}`);
  console.log(`[build-maze] ${AGENT} 已回血回饱食 + tp 到迷宫起点 (${startX},${FLOORY},${startZ})`);

  console.log('\n✅ 迷宫就绪。');
  console.log(`   起点(agent)：(${startX},${FLOORY},${startZ})  ←迷宫西北角内`);
  console.log(`   出口：南墙 gx=${exitGx}  →  目标金块 (${goalX},${FLOORY},${goalZ})`);
  console.log(`   下一步：经大脑下指令，如 "走出迷宫到金块那里" / "走到金块那里"，然后看它能不能出来。\n`);

  await sleep(500);
  bot.quit();
  process.exit(0);
});

bot.on('kicked', (r) => { console.error('[build-maze] kicked:', r); process.exit(3); });
bot.on('error', (e) => { console.error('[build-maze] error:', e?.message ?? e); process.exit(1); });

// 节流发指令
async function cmd(c) {
  bot.chat(c);
  await sleep(DELAY);
}
