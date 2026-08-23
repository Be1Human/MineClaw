#!/usr/bin/env node
/**
 * 在线测试 · 强制实物验证
 *
 * 第一铁律：造物/采集类测试，只有"背包里实际看到目标物品且数量达标"才 PASS。
 * 本脚本：查背包(before) → 经聊天通道下指令(走大脑) → 轮询背包 → 实物达标才 PASS。
 *
 * 用法：
 *   node scripts/online-verify.mjs --bot <botId> --say "做把木镐" --expect wooden_pickaxe --count 1 [--timeout 240] [--host 127.0.0.1:3000] [--sender qxy]
 *
 * 退出码：0=PASS，1=FAIL/超时，2=参数或连接错误。
 */

function parseArgs(argv) {
  const a = {};
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k.startsWith('--')) { a[k.slice(2)] = argv[i + 1]; i++; }
  }
  return a;
}

const args = parseArgs(process.argv);
const host = args.host || '127.0.0.1:3000';
const botId = args.bot;
const say = args.say;
const expect = args.expect;
const count = Number(args.count ?? 1);
const timeoutSec = Number(args.timeout ?? 240);
const sender = args.sender || 'qxy';
const pollSec = Number(args.poll ?? 5);

if (!botId || !say || !expect) {
  console.error('用法: node scripts/online-verify.mjs --bot <botId> --say "<指令>" --expect <item_id> --count <n> [--timeout 240]');
  process.exit(2);
}

const base = `http://${host}`;

async function getInventory() {
  const r = await fetch(`${base}/api/bots/${botId}/v2/status`);
  if (!r.ok) throw new Error(`status ${r.status}`);
  const s = await r.json();
  const items = s?.world?.inventory?.items ?? [];
  return items;
}
function invCount(items, name) {
  return items.filter(i => i.name === name).reduce((n, i) => n + (i.count || 0), 0);
}
function invStr(items) {
  return items.length ? items.map(i => `${i.name}x${i.count}`).join(', ') : '(空)';
}
async function sendChat(message) {
  const r = await fetch(`${base}/api/bots/${botId}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, sender }),
  });
  if (!r.ok) throw new Error(`chat ${r.status}`);
  return r.json().catch(() => ({}));
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  let before;
  try {
    before = await getInventory();
  } catch (e) {
    console.error(`✗ 连接失败（bot 在线了吗？）: ${e.message}`);
    process.exit(2);
  }
  const have0 = invCount(before, expect);
  console.log(`[before] ${expect} x${have0}  | 背包: ${invStr(before)}`);

  await sendChat(say);
  console.log(`[sent]   "${say}"  (经聊天通道 → 大脑决策)`);

  const deadline = Date.now() + timeoutSec * 1000;
  let last = have0;
  while (Date.now() < deadline) {
    await sleep(pollSec * 1000);
    let items;
    try { items = await getInventory(); } catch { continue; }
    const have = invCount(items, expect);
    const t = Math.round((timeoutSec * 1000 - (deadline - Date.now())) / 1000);
    if (have !== last) {
      console.log(`[poll]   t=${t}s  ${expect} x${have}  | ${invStr(items)}`);
      last = have;
    }
    if (have >= count) {
      console.log(`\n✅ PASS  实物到账：${expect} ${have0} → ${have}（达标 ≥${count}）`);
      process.exit(0);
    }
  }

  const finalItems = await getInventory().catch(() => before);
  const finalHave = invCount(finalItems, expect);
  console.log(`\n❌ FAIL  超时 ${timeoutSec}s 仍未见实物：${expect} ${have0} → ${finalHave}（需 ≥${count}）`);
  console.log(`         最终背包: ${invStr(finalItems)}`);
  console.log(`         排查：tail data/logs/runtime-*.log，看 [Provision]/[Gather]/[Craft]/exec FAIL`);
  process.exit(1);
})();
