/**
 * 🏷 FEAT-WEBUI-08 · taskLabel — kind+params → 人话意图（中文）
 *
 * LLM 创建任务没传 label 时的兜底。纯函数，仅展示用，不影响执行。
 * "金块"这种语义只有 LLM 知道（goto_position 只剩坐标），所以模板兜底到"走到坐标"；
 * 要显示"去到金块"需 LLM 在 decompose_task 时带 label。
 */

/** 常见物品/方块中文名 · 覆盖采集/合成高频项，生僻项兜底英文 id */
const ZH_ITEM: Record<string, string> = {
  oak_log: '橡木', birch_log: '白桦木', spruce_log: '云杉木', jungle_log: '丛林木',
  acacia_log: '金合欢木', dark_oak_log: '深色橡木', log: '木头', wood: '木头',
  oak_planks: '橡木板', planks: '木板', stick: '木棍',
  cobblestone: '圆石', stone: '石头', dirt: '泥土', sand: '沙子', gravel: '沙砾', clay: '黏土',
  coal: '煤炭', coal_ore: '煤矿', iron_ore: '铁矿', iron_ingot: '铁锭', gold_ore: '金矿',
  gold_ingot: '金锭', gold_block: '金块', diamond_ore: '钻石矿', diamond: '钻石',
  copper_ore: '铜矿', redstone: '红石', lapis_lazuli: '青金石', emerald: '绿宝石',
  wooden_pickaxe: '木镐', stone_pickaxe: '石镐', iron_pickaxe: '铁镐',
  wooden_axe: '木斧', stone_axe: '石斧', iron_axe: '铁斧',
  wooden_sword: '木剑', stone_sword: '石剑', iron_sword: '铁剑',
  wooden_hoe: '木锄', stone_hoe: '石锄',
  crafting_table: '工作台', chest: '箱子', furnace: '熔炉', torch: '火把',
  bed: '床', shield: '盾牌', wheat: '小麦', wheat_seeds: '小麦种子', bread: '面包',
  cooked_beef: '熟牛肉', cooked_porkchop: '熟猪排', white_wool: '白羊毛', wool: '羊毛',
};

export function zhItem(id: string): string {
  return ZH_ITEM[id] ?? id;
}

function fmtPos(tp: unknown): string | null {
  const p = tp as { x?: number; y?: number; z?: number } | undefined;
  if (!p || typeof p.x !== 'number' || typeof p.z !== 'number') return null;
  return `(${Math.round(p.x)},${Math.round(p.y ?? 64)},${Math.round(p.z)})`;
}

/** kind+params → 中文意图。LLM 没传 label 时由 createTask 调用兜底。 */
export function taskLabel(kind: string, params: Record<string, unknown>): string {
  switch (kind) {
    case 'gather_material': {
      const m = zhItem(String(params.material ?? ''));
      const c = params.count ? ` ×${params.count}` : '';
      return m && m !== '' ? `采集 ${m}${c}` : '采集材料';
    }
    case 'craft_item': {
      const it = zhItem(String(params.item ?? ''));
      const c = (params.count as number) > 1 ? ` ×${params.count}` : '';
      return it && it !== '' ? `制作 ${it}${c}` : '合成道具';
    }
    case 'goto_position': {
      const pos = fmtPos(params.targetPosition ?? params.position);
      return pos ? `走到 ${pos}` : '前往坐标';
    }
    case 'follow_owner': return '跟随主人';
    case 'farm': return '耕种农田';
    case 'guard': return '巡逻守卫';
    case 'explore': return '探索周边';
    case 'breed_animals': return '繁殖动物';
    case 'build_shelter': return '搭建庇护所';
    default: return kind;
  }
}
