// [TEMP] 事件循环阻塞 soak 测试。
// 每 100ms 探一次后端 API，测往返延迟。bot 在线时事件循环被同步重活卡住 → 延迟飙高。
// 这等价于"UI 点按钮要等多久"。用法: node scripts/eventloop-soak.mjs [秒]
const URL = 'http://127.0.0.1:3000/api/v2/status';
const DUR_S = Number(process.argv[2]) || 90;
const INTERVAL = 100;

const samples = [];
const spikes = [];
const start = Date.now();
let n = 0;

function pad(x, w) { return String(x).padStart(w); }

while ((Date.now() - start) / 1000 < DUR_S) {
  const t0 = performance.now();
  try {
    await fetch(URL, { cache: 'no-store' });
  } catch { /* 忽略偶发错误 */ }
  const dt = performance.now() - t0;
  samples.push(dt);
  n++;
  if (dt > 300) {
    const at = ((Date.now() - start) / 1000).toFixed(1);
    spikes.push({ at, ms: Math.round(dt) });
    console.log(`  ⚠️ t+${at}s 延迟 ${Math.round(dt)}ms  ← 事件循环被卡住`);
  }
  const elapsed = performance.now() - t0;
  if (elapsed < INTERVAL) await new Promise((r) => setTimeout(r, INTERVAL - elapsed));
}

samples.sort((a, b) => a - b);
const pct = (p) => Math.round(samples[Math.min(samples.length - 1, Math.floor(samples.length * p))]);
const avg = Math.round(samples.reduce((a, b) => a + b, 0) / samples.length);
console.log('\n========== 事件循环 soak 结果 ==========');
console.log(`探测次数: ${n} · 时长: ${DUR_S}s`);
console.log(`延迟  avg=${avg}ms  p50=${pct(0.5)}ms  p95=${pct(0.95)}ms  p99=${pct(0.99)}ms  max=${Math.round(samples[samples.length - 1])}ms`);
console.log(`卡顿尖峰(>300ms): ${spikes.length} 次  (>1000ms: ${spikes.filter((s) => s.ms > 1000).length} 次)`);
const blocked = samples.filter((s) => s > 300).reduce((a, b) => a + b, 0);
console.log(`累计阻塞时间(尖峰部分): ${Math.round(blocked)}ms / ${DUR_S * 1000}ms = ${((blocked / (DUR_S * 1000)) * 100).toFixed(1)}% 时间界面卡顿`);
console.log('判定: ' + (pct(0.95) > 300 ? '❌ 事件循环被 bot 运行时严重阻塞（UI 必卡）' : avg > 50 ? '⚠️ 偏高' : '✅ 流畅'));
