#!/usr/bin/env node
/**
 * build-maze-rcon.mjs · 迷宫压测摆场（RCON 版 · console 全权限 · 无反刷屏限制）
 *
 * 直连 Paper RCON（默认 127.0.0.1:25575 / pass clawtest）批量发 /fill+/setblock，
 * 建递归回溯迷宫（石墙3格高 + 真木门 + 单出口 + 出口外金块目标），
 * 再 difficulty peaceful + 回血回饱食 + tp agent 到起点。
 *
 * 用法：node scripts/build-maze-rcon.mjs --n 8 --doors 12 --x0 40 --z0 40 --agent LanYi
 */
import net from 'node:net';

const A = Object.fromEntries(process.argv.slice(2).reduce((a, c, i, r) => { if (c.startsWith('--')) a.push([c.slice(2), r[i + 1]]); return a; }, []));
const N = parseInt(A.n ?? '8', 10), DOORS = parseInt(A.doors ?? '12', 10);
const X0 = parseInt(A.x0 ?? '40', 10), Z0 = parseInt(A.z0 ?? '40', 10), Y = parseInt(A.floory ?? '-60', 10);
const AGENT = A.agent ?? 'LanYi', WALL = A.wall ?? 'stone';
const H = Math.max(3, parseInt(A.height ?? '6', 10)); // 墙高（格）· 通道固定 3 格高，墙更高→通道上方自动盖顶=封闭隧道，防翻墙/飞越
const HOST = A.host ?? '127.0.0.1', PORT = parseInt(A.port ?? '25575', 10), PASS = A.pass ?? 'clawtest';
const W = 2 * N + 1;

// ── 迷宫生成（递归回溯 · 确定性种子）──
function genMaze() {
  const g = Array.from({ length: W }, () => new Array(W).fill(1));
  let s = parseInt(A.seed ?? '20260613', 10);
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const sh = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const carve = (cx, cz) => { g[cx][cz] = 0; for (const [dx, dz] of sh([[0,-2],[0,2],[-2,0],[2,0]])) { const nx = cx+dx, nz = cz+dz; if (nx>0&&nx<W-1&&nz>0&&nz<W-1&&g[nx][nz]===1){ g[cx+dx/2][cz+dz/2]=0; carve(nx,nz);} } };
  carve(1, 1);
  return g;
}

// ── 生成命令列表 ──
function buildCommands() {
  const g = genMaze();
  const exitGx = 2 * N - 1, exitGz = W - 1;
  g[exitGx][exitGz] = 0; // 南墙开单一出口
  const cmds = [];
  // 0. 清场：把旧迷宫整片(含外扩 8 格余量)抹成空气，删掉上一座
  const m = 8;
  cmds.push(`fill ${X0 - m} ${Y} ${Z0 - m} ${X0 + W - 1 + m} ${Y + H + 2} ${Z0 + W - 1 + m} air`);
  // 1. 整块填实成墙（高 H 格 · 通道只掏 3 格→上方 H-3 格实心=封顶隧道，飞不出去）
  cmds.push(`fill ${X0} ${Y} ${Z0} ${X0 + W - 1} ${Y + H - 1} ${Z0 + W - 1} ${WALL}`);
  // 2. 逐格掏通路
  let carve = 0;
  for (let gx = 0; gx < W; gx++) for (let gz = 0; gz < W; gz++) {
    if (g[gx][gz] === 0) { cmds.push(`fill ${X0+gx} ${Y} ${Z0+gz} ${X0+gx} ${Y+2} ${Z0+gz} air`); carve++; }
  }
  // 3. 真木门：degree==2 走廊格均匀挑 DOORS 个
  const pass = [];
  for (let gx = 1; gx < W-1; gx++) for (let gz = 1; gz < W-1; gz++) {
    if (g[gx][gz] !== 0) continue;
    const deg = [[0,1],[0,-1],[1,0],[-1,0]].filter(([dx,dz]) => g[gx+dx]?.[gz+dz] === 0).length;
    if (deg === 2) pass.push([gx, gz]);
  }
  const step = Math.max(1, Math.floor(pass.length / DOORS));
  let doors = 0;
  for (let i = 0; i < pass.length && doors < DOORS; i += step) {
    const [gx, gz] = pass[i], dx = X0+gx, dz = Z0+gz;
    // open=false · 全部关闭，逼 bot 每道门都得开
    cmds.push(`setblock ${dx} ${Y} ${dz} oak_door[half=lower,facing=north,open=false]`);
    cmds.push(`setblock ${dx} ${Y+1} ${dz} oak_door[half=upper,facing=north,open=false]`);
    doors++;
  }
  // 4a. 危险：死路尽头(degree==1)埋熔岩 · 避开起点 · 完美迷宫唯一解路径不含死路→不破坏可解性
  const deadends = [];
  for (let gx = 1; gx < W-1; gx++) for (let gz = 1; gz < W-1; gz++) {
    if (g[gx][gz] !== 0) continue;
    const deg = [[0,1],[0,-1],[1,0],[-1,0]].filter(([dx,dz]) => g[gx+dx]?.[gz+dz] === 0).length;
    if (deg === 1 && !(gx === 1 && gz === 1)) deadends.push([gx, gz]);
  }
  const LAVA = parseInt(A.lava ?? '8', 10);
  const lstep = Math.max(1, Math.floor(deadends.length / LAVA));
  let lava = 0;
  for (let i = 0; i < deadends.length && lava < LAVA; i += lstep) {
    const [gx, gz] = deadends[i];
    // ★ 熔岩埋在【地板层 Y-1】做封闭坑：四周/下方都是实心地板 → 不蔓延；
    //   该格 Y(行走层)是空气、脚下即岩浆 → 踩进去就掉进去烧死（pathfinder 会避开无安全地面的格）。
    //   （此前误放在行走层 Y，源块顺走廊蔓延把迷宫淹了——已修正。）
    cmds.push(`setblock ${X0+gx} ${Y - 1} ${Z0+gz} lava`);
    lava++;
  }
  // 4b. 照明：每个通路格顶挂灯笼(-58 吊在 -57 顶上)·不占 1 格走廊地面
  let lit = 0;
  for (let gx = 0; gx < W; gx++) for (let gz = 0; gz < W; gz++) {
    if (g[gx][gz] !== 0) continue;
    cmds.push(`setblock ${X0+gx} ${Y+2} ${Z0+gz} lantern[hanging=true]`);
    lit++;
  }
  // 4c. 出口外金块目标
  const goalX = X0 + exitGx, goalZ = Z0 + W + 1;
  cmds.push(`setblock ${goalX} ${Y} ${goalZ} gold_block`);
  // 5. 稳住 agent：peaceful + 白天 + 回血回饱食 + tp 起点
  const sx = X0 + 1, sz = Z0 + 1;
  cmds.push(`difficulty peaceful`);
  cmds.push(`gamerule doDaylightCycle false`);
  cmds.push(`time set day`);
  cmds.push(`effect give ${AGENT} minecraft:saturation 5 20`);
  cmds.push(`effect give ${AGENT} minecraft:instant_health 1 20`);
  cmds.push(`tp ${AGENT} ${sx + 0.5} ${Y} ${sz + 0.5}`);
  return { cmds, meta: { carve, doors, lava, lit, goal: [goalX, Y, goalZ], start: [sx, Y, sz], exitGx } };
}

// ── RCON 客户端 ──
function pkt(id, type, body) {
  const b = Buffer.from(body, 'ascii'); const len = 10 + b.length;
  const buf = Buffer.alloc(4 + len);
  buf.writeInt32LE(len, 0); buf.writeInt32LE(id, 4); buf.writeInt32LE(type, 8);
  b.copy(buf, 12); buf.writeInt8(0, 12 + b.length); buf.writeInt8(0, 13 + b.length);
  return buf;
}

const { cmds, meta } = buildCommands();
console.log(`[maze-rcon] 迷宫 ${W}x${W} · 墙高 ${H}（通道3格封顶）@ (${X0},${Y},${Z0}) · 掏路 ${meta.carve} · 门 ${meta.doors}(关) · 熔岩 ${meta.lava} · 灯 ${meta.lit} · 共 ${cmds.length} 条命令`);

const sock = net.connect(PORT, HOST, () => sock.write(pkt(1, 3, PASS)));
let stage = 'auth', qi = 0, acc = Buffer.alloc(0), errs = 0;
sock.on('data', (d) => {
  acc = Buffer.concat([acc, d]);
  while (acc.length >= 4) {
    const len = acc.readInt32LE(0); if (acc.length < 4 + len) break;
    const id = acc.readInt32LE(4); const body = acc.slice(12, 4 + len - 2).toString('ascii'); acc = acc.slice(4 + len);
    if (stage === 'auth') {
      if (id === -1) { console.error('❌ RCON 认证失败（密码错）'); process.exit(2); }
      stage = 'cmd'; next();
    } else {
      if (/unknown|incomplete|error|failed|无法|错误/i.test(body)) { errs++; if (errs <= 5) console.error('  ⚠', body.trim().slice(0, 80)); }
      next();
    }
  }
});
function next() {
  if (qi >= cmds.length) {
    console.log(`\n✅ 迷宫就绪（${cmds.length} 条已发 · 错误 ${errs}）`);
    console.log(`   起点(agent)：(${meta.start.join(',')})  · 出口南墙 gx=${meta.exitGx}`);
    console.log(`   出口外目标金块：(${meta.goal.join(',')})`);
    console.log(`   测试：给 agent 下"走到 ${meta.goal[0]} ${meta.goal[1]} ${meta.goal[2]}"，看它穿不穿得出来。`);
    sock.end(); process.exit(errs > cmds.length / 2 ? 1 : 0);
  }
  if (qi % 40 === 0 && qi > 0) console.log(`  …已发 ${qi}/${cmds.length}`);
  sock.write(pkt(2, 2, cmds[qi++]));
}
sock.on('error', (e) => { console.error('RCON 连接错误:', e.message); process.exit(3); });
sock.setTimeout(20000, () => { console.error('RCON 超时'); process.exit(4); });
