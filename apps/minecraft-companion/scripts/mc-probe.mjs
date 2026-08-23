#!/usr/bin/env node
/** mc-probe.mjs · 探测 server 版本/brand + 普通chat vs /setblock 权限对比 */
import mineflayer from 'mineflayer';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25565, username: 'MazeBuilder', auth: 'offline' });
bot.on('message', (j) => { const t = j.toString(); if (t.trim()) console.log('  <srv>', t); });
bot.on('kicked', (r) => { console.error('kicked:', JSON.stringify(r)); process.exit(3); });
bot.on('error', (e) => { console.error('error:', e?.message ?? e); process.exit(1); });
bot.once('spawn', async () => {
  await sleep(800);
  console.log('version:', bot.version, '| brand:', bot.game?.serverBrand ?? '?');
  console.log('-- 普通 chat --'); bot.chat('hello-from-builder'); await sleep(1300);
  console.log('-- /list --'); bot.chat('/list'); await sleep(1300);
  console.log('-- /setblock 测试 --'); bot.chat('/setblock 45 -60 45 stone'); await sleep(1300);
  await sleep(300); bot.quit(); process.exit(0);
});
