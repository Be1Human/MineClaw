#!/usr/bin/env node
/**
 * mc-cmd.mjs · 可复用 op 指令发送器（独立 bot 连本地服执行任意 /命令）
 *
 * 用法：node scripts/mc-cmd.mjs "/difficulty peaceful" "/tp LanYi 41 -60 41" ...
 * 每条命令间隔 1100ms（避开 vanilla 反刷屏踢人）。需 MazeBuilder 已 op。
 */
import mineflayer from 'mineflayer';

const cmds = process.argv.slice(2);
if (cmds.length === 0) { console.error('用法: node scripts/mc-cmd.mjs "/cmd" ...'); process.exit(1); }
const HOST = process.env.MC_HOST ?? '127.0.0.1';
const PORT = parseInt(process.env.MC_PORT ?? '25565', 10);
const DELAY = parseInt(process.env.MC_DELAY ?? '1100', 10);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const bot = mineflayer.createBot({ host: HOST, port: PORT, username: 'MazeBuilder', auth: 'offline' });
bot.on('message', (j) => { const t = j.toString(); if (t.trim()) console.log('  <srv>', t); });
bot.on('kicked', (r) => { console.error('kicked:', JSON.stringify(r)); process.exit(3); });
bot.on('error', (e) => { console.error('error:', e?.message ?? e); process.exit(1); });

bot.once('spawn', async () => {
  await sleep(700);
  for (const c of cmds) {
    const cmd = c.startsWith('/') ? c : '/' + c;
    console.log('[mc-cmd]', cmd);
    bot.chat(cmd);
    await sleep(DELAY);
  }
  await sleep(500);
  bot.quit();
  process.exit(0);
});
