/**
 * 评测场景清单工具（FEAT-CROSS-03）· 离线列出全部展开实例，不连服务器。
 * 用法：npm run eval:list
 */
import { allScenarios } from '../body/index.js';

const specs = allScenarios.map(f => f());
const byCat = new Map<string, typeof specs>();
for (const s of specs) {
  const k = s.category ?? 'misc';
  (byCat.get(k) ?? byCat.set(k, []).get(k)!).push(s);
}

console.log(`总实例数：${specs.length}`);
const bySuite = (suite: string) => specs.filter(s => s.suite === suite).length;
console.log(`  quick=${bySuite('quick')} · full=${bySuite('full')} · matrix=${bySuite('matrix')}`);
console.log('');
for (const [cat, arr] of byCat) {
  console.log(`[${cat}] ${arr.length}`);
  for (const s of arr) console.log(`   ${s.id.padEnd(14)} ${s.suite.padEnd(7)} ${s.title}`);
}
