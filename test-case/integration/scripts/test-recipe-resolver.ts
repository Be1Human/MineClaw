/**
 * 离线断言：RecipeResolver 递归材料树 + 工具门槛 + 进阶链
 * 运行：npx tsx scripts/test-recipe-resolver.ts
 *
 * 用 mock 数据源模拟 木→石 进阶，反复 nextStep + 执行，验证：
 *   1. 最终收敛到 done
 *   2. 动作顺序符合依赖（先木后石）
 *   3. progression gate：cobblestone 采集只在拥有镐之后才出现
 */

import { RecipeResolver, type RecipeDataSource } from '../../../apps/minecraft-companion/src/bot/v2/knowledge/recipeResolver.js';
import type { RecipeInfo, ItemSource } from '../../../apps/minecraft-companion/src/bot/adapter/types.js';
import type { InventoryView } from '../../../apps/minecraft-companion/src/bot/v2/types.js';

// ── mock 配方表 ──
const RECIPES: Record<string, RecipeInfo[]> = {
  oak_planks: [{ result: { name: 'oak_planks', count: 4 }, ingredients: [{ name: 'oak_log', count: 1 }], requiresTable: false }],
  stick: [{ result: { name: 'stick', count: 4 }, ingredients: [{ name: 'oak_planks', count: 2 }], requiresTable: false }],
  crafting_table: [{ result: { name: 'crafting_table', count: 1 }, ingredients: [{ name: 'oak_planks', count: 4 }], requiresTable: false }],
  wooden_pickaxe: [{ result: { name: 'wooden_pickaxe', count: 1 }, ingredients: [{ name: 'oak_planks', count: 3 }, { name: 'stick', count: 2 }], requiresTable: true }],
  // 两套配方：cobbled_deepslate 变体在前（模拟 minecraft-data 顺序），应被避开
  stone_pickaxe: [
    { result: { name: 'stone_pickaxe', count: 1 }, ingredients: [{ name: 'cobbled_deepslate', count: 3 }, { name: 'stick', count: 2 }], requiresTable: true },
    { result: { name: 'stone_pickaxe', count: 1 }, ingredients: [{ name: 'cobblestone', count: 3 }, { name: 'stick', count: 2 }], requiresTable: true },
  ],
  chest: [{ result: { name: 'chest', count: 1 }, ingredients: [{ name: 'oak_planks', count: 8 }], requiresTable: true }],
};
const SOURCES: Record<string, ItemSource> = {
  oak_log: { block: 'oak_log', requiredTool: null },
  cobblestone: { block: 'stone', requiredTool: 'wooden_pickaxe' },
  // 深板岩需要"石镐及以上"——木镐不满足（档位门槛）
  cobbled_deepslate: { block: 'deepslate', requiredTool: 'stone_pickaxe' },
};

const data: RecipeDataSource = {
  getCraftRecipes: (name) => RECIPES[name] ?? [],
  getItemSource: (name) => SOURCES[name] ?? null,
  // 模拟"地表能挖到 stone，挖不到 deepslate"
  isMaterialNearby: (mat) => mat === 'oak_log' || mat === 'cobblestone',
};

function makeInv(items: Record<string, number>): InventoryView {
  return {
    items: Object.entries(items).map(([name, count], slot) => ({ name, count, slot })),
    held: null,
    freeSlots: 36,
  };
}

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) { console.error('  ✗ FAIL:', msg); failures++; }
  else console.log('  ✓', msg);
}

/** 模拟执行：反复 nextStep，记录动作序列，直到 done/blocked/超步数 */
function simulate(target: string, count: number, startInv: Record<string, number>): string[] {
  const resolver = new RecipeResolver(data);
  const inv: Record<string, number> = { ...startInv };
  const trace: string[] = [];
  for (let i = 0; i < 200; i++) {
    const step = resolver.nextStep(target, count, makeInv(inv));
    if (step.kind === 'done') { trace.push('done'); return trace; }
    if (step.kind === 'blocked') { trace.push(`blocked:${step.reason}`); return trace; }
    if (step.kind === 'gather') {
      trace.push(`gather:${step.material}`);
      inv[step.material] = (inv[step.material] ?? 0) + step.count;
    } else {
      // craft：消耗材料，产出
      const recipe = RECIPES[step.item][0];
      for (const ing of recipe.ingredients) inv[ing.name] = (inv[ing.name] ?? 0) - ing.count * step.count;
      inv[step.item] = (inv[step.item] ?? 0) + recipe.result.count * step.count;
      trace.push(`craft:${step.item}`);
    }
  }
  trace.push('TIMEOUT');
  return trace;
}

console.log('\n=== T1: craft oak_planks (有 1 原木) ===');
{
  const r = new RecipeResolver(data).nextStep('oak_planks', 4, makeInv({ oak_log: 1 }));
  assert(r.kind === 'craft' && r.item === 'oak_planks', 'materials present → craft oak_planks');
}

console.log('\n=== T2: craft oak_planks (空库存) → 先砍树 ===');
{
  const r = new RecipeResolver(data).nextStep('oak_planks', 4, makeInv({}));
  assert(r.kind === 'gather' && r.material === 'oak_log', 'empty → gather oak_log first');
}

console.log('\n=== T3: craft crafting_table (空库存) 全链 ===');
{
  const t = simulate('crafting_table', 1, {});
  console.log('  trace:', t.join(' → '));
  assert(t[0] === 'gather:oak_log', 'starts by gathering log');
  assert(t.includes('craft:oak_planks'), 'crafts planks');
  assert(t[t.length - 1] === 'done', 'reaches done');
}

console.log('\n=== T4: craft wooden_pickaxe (空库存) 全链 ===');
{
  const t = simulate('wooden_pickaxe', 1, {});
  console.log('  trace:', t.join(' → '));
  assert(t.includes('craft:oak_planks'), 'crafts planks');
  assert(t.includes('craft:stick'), 'crafts sticks');
  assert(t.includes('craft:wooden_pickaxe'), 'crafts pickaxe');
  assert(t[t.length - 1] === 'done', 'reaches done');
}

console.log('\n=== T5: craft stone_pickaxe (空库存) — progression gate ===');
{
  const t = simulate('stone_pickaxe', 1, {});
  console.log('  trace:', t.join(' → '));
  const idxPick = t.indexOf('craft:wooden_pickaxe');
  const idxCobble = t.indexOf('gather:cobblestone');
  assert(idxPick >= 0, 'auto-crafts wooden_pickaxe (tool gate)');
  assert(idxCobble >= 0, 'gathers cobblestone (NOT cobbled_deepslate)');
  assert(!t.includes('gather:cobbled_deepslate'), 'avoids cobbled_deepslate (rarity + tier gate)');
  assert(idxPick < idxCobble, 'wooden_pickaxe crafted BEFORE mining cobblestone (gate respected)');
  assert(t[t.length - 1] === 'done', 'reaches done');
}

console.log('\n=== T6: craft chest (需 8 木板 = 2 原木) ===');
{
  const t = simulate('chest', 1, {});
  console.log('  trace:', t.join(' → '));
  const logGathers = t.filter(x => x === 'gather:oak_log').length;
  assert(logGathers >= 1, 'gathers logs for chest');
  assert(t[t.length - 1] === 'done', 'reaches done');
}

console.log('\n=== T7: 已有成品 → done ===');
{
  const r = new RecipeResolver(data).nextStep('wooden_pickaxe', 1, makeInv({ wooden_pickaxe: 1 }));
  assert(r.kind === 'done', 'already have item → done');
}

console.log(`\n${failures === 0 ? '✅ ALL PASS' : `❌ ${failures} FAILURES`}\n`);
process.exit(failures === 0 ? 0 : 1);
