/**
 * Knowledge · RecipeResolver — 递归材料树 + 工具档位门槛
 *
 * 纯逻辑：给定「要做什么物品 × 多少」+ 当前库存，返回「当下最深的、可立即执行的
 * 一个原始动作」（采集 / 合成）。每 tick 重算，对中途进度幂等、可断点恢复。
 *
 * 数据全部来自 minecraft-data（经 RecipeDataSource 注入），零硬编码配方。
 * 通过依赖注入 RecipeDataSource，本类可脱离 mineflayer 做离线单测。
 *
 * 核心进阶机制（progression gate）：
 *   要采集某方块（如 stone→cobblestone）若需要工具且库存无同类工具，
 *   则先递归"造一把最便宜的该类工具"，从而把"挖石头需木镐"自动串成进阶链。
 */

import type { RecipeInfo, ItemSource } from '../../adapter/types.js';
import type { InventoryView } from '../types.js';

export interface RecipeDataSource {
  getCraftRecipes(itemName: string, withTable: boolean): RecipeInfo[];
  getItemSource(itemName: string): ItemSource | null;
  /**
   * 可选：某原料（item）的采集源方块此刻是否在附近可达。
   * 用于在多套配方里优先选"用周围有的材料"那套（就地取材）。
   * 例如 stone_pickaxe 可用 cobblestone / cobbled_deepslate / blackstone，
   * 应优先选地表能挖到 stone 的 cobblestone 配方，而不是深层 deepslate。
   * 不提供时（如离线测试）视为全部可得。
   */
  isMaterialNearby?(material: string): boolean;
}

export type ResolveStep =
  | { kind: 'gather'; material: string; count: number; requiredTool: string | null }
  | { kind: 'craft'; item: string; count: number; inventoryTargetCount: number; needTable: boolean; ingredients: Array<{ name:string; count:number }>; producedCount: number }
  | { kind: 'smelt'; item: string; input: string; fuel: string; count: number }
  | { kind: 'done' }
  | { kind: 'blocked'; reason: string };

/**
 * FEAT-L3-06 熔炼配方表（成品 → 原料，基本 1:1）。
 * 这些成品多数只能熔炼获得（锭/玻璃/木炭/熟食），crafting 配方会绕成环，故优先走熔炼。
 */
const SMELT_INPUT: Record<string, string> = {
  iron_ingot: 'raw_iron', gold_ingot: 'raw_gold', copper_ingot: 'raw_copper',
  stone: 'cobblestone', smooth_stone: 'stone', glass: 'sand', charcoal: 'oak_log',
  terracotta: 'clay', brick: 'clay_ball', nether_brick: 'netherrack',
  cooked_beef: 'beef', cooked_porkchop: 'porkchop', cooked_chicken: 'chicken',
  cooked_mutton: 'mutton', cooked_rabbit: 'rabbit', cooked_cod: 'cod', cooked_salmon: 'salmon',
  baked_potato: 'potato', dried_kelp: 'kelp', popped_chorus_fruit: 'chorus_fruit',
};

/** 供只读规划层展开熔炼依赖；不暴露可变表本身。 */
export function smeltInputFor(itemName: string): string | null {
  return SMELT_INPUT[itemName] ?? null;
}

/** 燃料优先级（高=优先）· 原木/木板也是合法燃料，bot 通常手头就有 */
export function fuelScore(name: string): number {
  if (name === 'coal_block') return 6;
  if (name === 'coal') return 5;
  if (name === 'charcoal') return 4;
  if (name === 'lava_bucket') return 5.5;
  if (name.endsWith('_planks')) return 2;
  if (name.endsWith('_log') || name.endsWith('_stem')) return 1.5;
  if (name === 'stick' || name === 'bamboo') return 1;
  return 0;
}

/**
 * 单个燃料能烧几件（MC 熔炉：每件耗 200 ticks，煤 1600 ticks = 8 件）。
 * 用于按 needUnits 挑「够量」的燃料——只挑种类不算数量会让适配器空转到 smelt_timeout。
 */
export function fuelBurnUnits(name: string): number {
  if (name === 'lava_bucket') return 100;
  if (name === 'coal_block') return 80;
  if (name === 'coal' || name === 'charcoal') return 8;
  if (name === 'bamboo') return 0.25;
  if (name === 'stick') return 0.5;
  if (name.endsWith('_planks')) return 1.5;
  if (name.endsWith('_log') || name.endsWith('_stem')) return 1.5;
  return 0;
}

export interface PickFuelOptions {
  /** 排除该物品（熔炼原料本身不能当燃料，如烧 charcoal 时的 oak_log） */
  excludeName?: string;
  /** 需要烧的件数；给出时优先挑「库存总燃烧值够」的燃料 */
  needUnits?: number;
}

/**
 * 从库存挑最佳燃料名（煤/木炭优先，其次木板/原木）· 无则 null。
 * BUG-CROSS-02：从 RecipeResolver private 方法提升为模块级导出，供原子层（smelt 自洽）复用。
 * 挑选规则：先在「烧得够」的候选里挑优先级最高的；都不够则退而求其次挑优先级最高的（能烧多少算多少）。
 */
export function pickFuel(inv: InventoryView, opts?: PickFuelOptions): string | null {
  const exclude = opts?.excludeName;
  const need = opts?.needUnits ?? 0;
  let best: string | null = null;
  let bestScore = 0;
  let bestEnough: string | null = null;
  let bestEnoughScore = 0;
  for (const it of inv.items) {
    if (exclude && it.name === exclude) continue;
    const s = fuelScore(it.name);
    if (s <= 0) continue;
    if (s > bestScore) { bestScore = s; best = it.name; }
    // 够量候选：该燃料库存总燃烧值 ≥ 需求
    if (need > 0 && fuelBurnUnits(it.name) * it.count >= need && s > bestEnoughScore) {
      bestEnoughScore = s;
      bestEnough = it.name;
    }
  }
  return bestEnough ?? best;
}

export class RecipeResolver {
  /** 配方由连接版本决定，在单个 Resolver 生命周期内是静态知识。 */
  private readonly recipeCache = new Map<string, RecipeInfo[]>();
  /** 以下判定依赖当前库存快照，每次 nextStep 都会清空。 */
  private derivableMemo = new Map<string, boolean>();
  private rawNearbyMemo = new Map<string, boolean>();
  private obtainableMemo = new Map<string, boolean>();

  constructor(
    private readonly data: RecipeDataSource,
    private readonly maxDepth = 16,
  ) {}

  /**
   * 计算"为了得到 target×count，当下应执行的下一个原始动作"。
   * - done    : 库存已满足
   * - gather  : 去采集某原料（最深的缺料）
   * - craft   : 材料齐了，去合成某物（可能是中间产物）
   * - blocked : 无路可走（无配方无来源 / 成环 / 过深）
   */
  nextStep(target: string, count: number, inv: InventoryView): ResolveStep {
    this.derivableMemo = new Map();
    this.rawNearbyMemo = new Map();
    this.obtainableMemo = new Map();
    return this.resolve(target, count, inv, new Set<string>(), 0);
  }

  private recipes(itemName: string, withTable: boolean): RecipeInfo[] {
    const key = `${itemName}:${withTable ? 1 : 0}`;
    const cached = this.recipeCache.get(key);
    if (cached) return cached;
    const recipes = this.data.getCraftRecipes(itemName, withTable);
    this.recipeCache.set(key, recipes);
    return recipes;
  }

  private resolve(
    target: string,
    count: number,
    inv: InventoryView,
    visited: Set<string>,
    depth: number,
  ): ResolveStep {
    if (depth > this.maxDepth) return { kind: 'blocked', reason: `too_deep:${target}` };

    const have = invCount(inv, target);
    const need = count - have;
    if (need <= 0) return { kind: 'done' };

    if (visited.has(target)) return { kind: 'blocked', reason: `cycle:${target}` };
    visited.add(target);

    // FEAT-L3-06 熔炼优先：成品在熔炼表里 → 走熔炼链（这些成品的 crafting 配方多会绕成环）
    const smeltInput = SMELT_INPUT[target];
    if (smeltInput) {
      // 缺原料 → 先去搞原料（熔炼 1:1）
      if (invCount(inv, smeltInput) < need) {
        return this.resolve(smeltInput, need, inv, visited, depth + 1);
      }
      // 缺燃料 → 先去搞燃料（优先煤/木炭，否则原木/木板；都没有 → 去采原木当燃料）
      // BUG-CROSS-02：排除熔炼原料自身（烧 charcoal 时 input=oak_log，不能把它当燃料烧掉）
      const fuel = this.pickFuel(inv, { excludeName: smeltInput, needUnits: need });
      if (!fuel) {
        return this.resolve('oak_log', 1, inv, visited, depth + 1);
      }
      return { kind: 'smelt', item: target, input: smeltInput, fuel, count: need };
    }

    // 候选配方（排除把自身当材料、空材料的脏配方）
    //   ★ 还要排除"存储方块解压"配方（X ← X_block，如 raw_iron ← raw_iron_block）：
    //     X_block 又需 9 个 X → 成环、resolver 直接 blocked。真服实证 iron_ingot→raw_iron
    //     被这条环卡死（cycle:raw_iron）。这类原料应去【挖】(getItemSource)，不是合成。
    const recipes = this
      .recipes(target, true)
      .filter(r => r.ingredients.length > 0 && !r.ingredients.some(i => i.name === target))
      .filter(r => !(r.ingredients.length === 1 && r.ingredients[0].name === `${target}_block`));

    if (recipes.length === 0) {
      // 没有配方（或只有解压环配方被滤掉）→ 视为原料，走采集
      const src = this.data.getItemSource(target);
      if (!src) return { kind: 'blocked', reason: `no_recipe_no_source:${target}` };
      // progression gate：需要工具且库存无同类工具 → 先造工具
      if (src.requiredTool && !hasToolFor(inv, src.requiredTool)) {
        return this.resolve(src.requiredTool, 1, inv, visited, depth + 1);
      }
      return { kind: 'gather', material: target, count: need, requiredTool: src.requiredTool };
    }

    // 选一个最可推进的配方
    const recipe = this.chooseRecipe(recipes, inv);
    const perCraft = Math.max(1, recipe.result.count);
    const times = Math.ceil(need / perCraft);

    // 逐个材料检查；第一个不足的 → 递归去补
    for (const ing of recipe.ingredients) {
      const needIng = ing.count * times;
      if (invCount(inv, ing.name) < needIng) {
        return this.resolve(ing.name, needIng, inv, visited, depth + 1);
      }
    }

    // 材料齐 → 合成
    return {
      kind: 'craft',
      item: target,
      count: times,
      inventoryTargetCount: count,
      needTable: recipe.requiresTable,
      ingredients: recipe.ingredients.map(ingredient => ({ name:ingredient.name, count:ingredient.count * times })),
      producedCount: recipe.result.count * times,
    };
  }

  /**
   * 从多个配方中选"最该用"的（很多物品有多套配方，如工作台可用任意木板）：
   *   优先级 1：材料"已能从当前库存推导出"的种类最多
   *             —— 关键：手里有 oak_log 时，工作台应选 oak_planks 配方而非 cherry_planks
   *   优先级 2：材料已直接在库存的种类最多
   *   优先级 3：材料"可获得"（库存/可挖/可合成）的种类最多
   *   优先级 4：材料种类最少（更简单）
   */
  private chooseRecipe(recipes: RecipeInfo[], inv: InventoryView): RecipeInfo {
    let best = recipes[0];
    let bestKey: number[] = [-1, -1, -1, -1, -Infinity];
    for (const r of recipes) {
      let derivable = 0;
      let nearbyRaw = 0;
      let inInv = 0;
      let obtainable = 0;
      let rarity = 0;
      for (const ing of r.ingredients) {
        if (this.derivableFromInv(ing.name, inv, 3)) derivable++;
        if (this.rawNearby(ing.name)) nearbyRaw++;
        if (invCount(inv, ing.name) >= ing.count) inInv++;
        if (this.isObtainable(ing.name, inv)) obtainable++;
        rarity += rarityPenalty(ing.name);
      }
      // 优先级：手头可推导 > 周围原料可得 > 已在库存 > 可获得 > 材料越普通越好 > 配方更简单
      const key = [derivable, nearbyRaw, inInv, obtainable, -rarity, -r.ingredients.length];
      if (cmpKey(key, bestKey) > 0) {
        bestKey = key;
        best = r;
      }
    }
    return best;
  }

  /** 从库存挑最佳燃料名（委托模块级 pickFuel · BUG-CROSS-02 提升可见性后此处保持行为不变） */
  private pickFuel(inv: InventoryView, opts?: PickFuelOptions): string | null {
    return pickFuel(inv, opts);
  }

  /**
   * 该物品能否"仅凭当前库存"推导出来（不需要去世界里新采集）：
   *   - 库存里有 → true
   *   - 有某个配方，其全部材料都能从库存推导 → true
   * 用于在多套配方里优先选"用手头材料就能做"的那套（如选 oak 而非 cherry）。
   */
  private derivableFromInv(name: string, inv: InventoryView, depth: number): boolean {
    if (invCount(inv, name) > 0) return true;
    if (depth <= 0) return false;
    const memoKey = `${name}:${depth}`;
    const memo = this.derivableMemo.get(memoKey);
    if (memo !== undefined) return memo;
    const recipes = this
      .recipes(name, true)
      .filter(r => r.ingredients.length > 0 && !r.ingredients.some(i => i.name === name));
    for (const r of recipes) {
      if (r.ingredients.every(ing => this.derivableFromInv(ing.name, inv, depth - 1))) {
        this.derivableMemo.set(memoKey, true);
        return true;
      }
    }
    this.derivableMemo.set(memoKey, false);
    return false;
  }

  /** 该物品是"原料"（无配方）且其源方块此刻在附近可挖 */
  private rawNearby(name: string): boolean {
    if (!this.data.isMaterialNearby) return false;
    const memo = this.rawNearbyMemo.get(name);
    if (memo !== undefined) return memo;
    const recipes = this.recipes(name, true).filter(r => r.ingredients.length > 0);
    const result = recipes.length === 0 && this.data.isMaterialNearby(name);
    this.rawNearbyMemo.set(name, result);
    return result; // 可合成的不算"原料"
  }

  /** 某物品是否可获得：库存有 / 可挖 / 有合成配方 */
  private isObtainable(name: string, inv: InventoryView): boolean {
    if (invCount(inv, name) > 0) return true;
    const memo = this.obtainableMemo.get(name);
    if (memo !== undefined) return memo;
    const result = !!this.data.getItemSource(name) || this.recipes(name, true).length > 0;
    this.obtainableMemo.set(name, result);
    return result;
  }
}

// ───────────────────────── helpers ─────────────────────────

export function invCount(inv: InventoryView, name: string): number {
  return inv.items.filter(i => i.name === name).reduce((s, i) => s + i.count, 0);
}

/** 工具采集档位（harvest tier）· 金镐采集等级等同木镐 */
const TOOL_TIER_RANK: Record<string, number> = {
  wooden: 1, golden: 1, stone: 2, iron: 3, diamond: 4, netherite: 5,
};

/** 取工具名的档位等级（前缀），未知按 1 */
export function toolTierRank(name: string): number {
  const prefix = name.split('_')[0];
  return TOOL_TIER_RANK[prefix] ?? 1;
}

/** 取工具类别（后缀）：pickaxe / axe / shovel / hoe / sword；非工具返回 null */
export function toolCategory(name: string): string | null {
  const suffix = name.split('_').pop();
  if (!suffix) return null;
  return ['pickaxe', 'axe', 'shovel', 'hoe', 'sword'].includes(suffix) ? suffix : null;
}

/**
 * FEAT-L3-10：方块 → 最适合的工具类别（加速采集 / 部分方块必需才掉落）。
 * 砍树用斧、挖矿用镐、挖土沙砾用锹；未知方块返回 null（空手挖）。
 */
export function blockToToolCategory(blockName: string): string | null {
  const n = (blockName || '').toLowerCase();
  if (/log|wood|planks|_stem|hyphae|crafting_table|bookshelf|barrel|chest|ladder|fence|wooden_|bamboo|pumpkin|melon/.test(n)) return 'axe';
  if (/stone|ore|cobble|deepslate|granite|diorite|andesite|basalt|blackstone|obsidian|netherrack|tuff|calcite|sandstone|prismarine|quartz|copper|coal_block|iron_block|gold_block|raw_|furnace|anvil|rail|amethyst|brick|concrete(?!_powder)|terracotta/.test(n)) return 'pickaxe';
  if (/dirt|grass_block|sand|gravel|clay|soul_sand|soul_soil|mud|podzol|mycelium|farmland|dirt_path|snow|coarse_dirt|rooted_dirt/.test(n)) return 'shovel';
  return null;
}

/**
 * FEAT-L3-10：给定目标方块，从库存挑"最佳（最高档）适配工具"名 · 无则 null（空手挖）。
 * 例：挖 stone 且背包有 wooden/iron 镐 → 选 iron_pickaxe；砍 oak_log 有石斧 → 选 stone_axe。
 */
export function bestToolForBlock(blockName: string, inv: InventoryView): string | null {
  const cat = blockToToolCategory(blockName);
  if (!cat) return null;
  let best: string | null = null;
  let bestRank = 0;
  for (const it of inv.items) {
    if (toolCategory(it.name) !== cat) continue;
    const r = toolTierRank(it.name);
    if (r > bestRank) { bestRank = r; best = it.name; }
  }
  return best;
}

/**
 * 库存是否有满足该工具门槛的工具：同类别且档位 ≥ 要求。
 * 关键：要"石镐"时，木镐(档位1)不满足石(档位2)；但铁镐/钻石镐满足。
 */
export function hasToolFor(inv: InventoryView, toolName: string): boolean {
  const cat = toolCategory(toolName);
  if (!cat) return false;
  const reqRank = toolTierRank(toolName);
  return inv.items.some(i => toolCategory(i.name) === cat && toolTierRank(i.name) >= reqRank);
}

/**
 * 材料"稀有/难取"惩罚：深层/危险维度的材料排在后面。
 * 让多套配方里优先选地表常见材料（如 stone_pickaxe 选 cobblestone 而非 cobbled_deepslate/blackstone）。
 */
function rarityPenalty(name: string): number {
  if (/deepslate|blackstone|basalt|nether|end_stone|obsidian/.test(name)) return 5;
  // BUG-L6-05: 木头按生物群系常见度惩罚 —— 避免世界图未热时默认选到环境没有的树种
  //   （实测：背包空时 chooseRecipe 落到 recipes[0]=cherry_planks → 反复去砍不存在的 cherry_log）
  //   oak 最通用(0) < birch/spruce(1) < jungle/acacia/dark_oak(2) < cherry/mangrove/bamboo/crimson/warped/pale_oak(3)
  if (/^(stripped_)?oak_/.test(name)) return 0;
  if (/^(stripped_)?(birch|spruce)_/.test(name)) return 1;
  if (/^(stripped_)?(jungle|acacia|dark_oak)_/.test(name)) return 2;
  if (/^(stripped_)?(cherry|mangrove|bamboo|crimson|warped|pale_oak)_/.test(name)) return 3;
  return 0;
}

function cmpKey(a: number[], b: number[]): number {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}
