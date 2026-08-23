const ITEM_ID_IN_PARENS = /[（(]\s*(?:minecraft:)?[a-z0-9_:-]+\s*[)）]/gi;
const PUNCTUATION = /[\s，。！？、；：,.!?;:'"“”‘’`·（）()\[\]{}<>《》]/g;
const CHINESE_COUNT = /[一二三四五六七八九十]+(?=[个块根组条份])/g;

/**
 * Stable signature for planner learning only. It removes representation noise,
 * while preserving intent, item and quantity so different goals stay isolated.
 */
export function canonicalGoalText(value: string): string {
  const surface = normalizeSurface(value);
  const family = inferPlannerTaskFamilyFromSurface(surface);
  if (family === 'gathering') {
    const item = canonicalGatheredItem(surface);
    if (item) return `采集${goalCount(surface)}个${item}`;
  }
  if (family === 'crafting') {
    const product = finalCraftedProduct(surface);
    if (product) return `制作${productCount(surface, product)}个${product}`;
  }
  return surface;
}

function normalizeSurface(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(ITEM_ID_IN_PARENS, '')
    .replace(/收集/g, '采集')
    .replace(/制作为|制造|合成|做出/g, '制作')
    .replace(CHINESE_COUNT, text => String(parseChineseCount(text)))
    .replace(PUNCTUATION, '')
    .trim();
}

export function inferPlannerTaskFamily(goal: string): string {
  return inferPlannerTaskFamilyFromSurface(normalizeSurface(goal));
}

export function plannerGoalMatches(left: string, right: string): boolean {
  const a = canonicalGoalText(left);
  const b = canonicalGoalText(right);
  return a.length > 0 && a === b;
}

function parseChineseCount(value: string): number {
  const digits: Record<string, number> = { 一:1, 二:2, 三:3, 四:4, 五:5, 六:6, 七:7, 八:8, 九:9 };
  if (value === '十') return 10;
  const [tens, ones] = value.split('十');
  if (value.includes('十')) return (tens ? digits[tens] : 1) * 10 + (ones ? digits[ones] : 0);
  return digits[value] ?? Number(value);
}

function inferPlannerTaskFamilyFromSurface(surface: string): string {
  if (/采集|砍|挖|gather|mine/.test(surface)) return 'gathering';
  if (/制作|craft/.test(surface)) return 'crafting';
  if (/建造|建|搭|build/.test(surface)) return 'building';
  if (/找|探索|explore|洞穴/.test(surface)) return 'exploration';
  if (/生存|食物|危险|surviv/.test(surface)) return 'survival';
  return 'general';
}

function canonicalGatheredItem(surface: string): string | null {
  const aliases: Array<[RegExp, string]> = [
    [/橡木原木|原木|oak_?log/, '原木'],
    [/圆石|石头|cobblestone|stone/, '石头'],
    [/煤炭|煤矿|煤|coal/, '煤'],
    [/铁矿石|铁矿|iron_?ore/, '铁矿石'],
    [/木板|planks?/, '木板'],
  ];
  return aliases.find(([pattern]) => pattern.test(surface))?.[1] ?? null;
}

function finalCraftedProduct(surface: string): string | null {
  const products = ['工作台','铁轨','铁镐','石镐','木镐','铁斧','石斧','木斧','熔炉','火把','木板','木棍'];
  let selected: { product: string; index: number } | null = null;
  for (const product of products) {
    const index = surface.lastIndexOf(product);
    if (index >= 0 && (!selected || index > selected.index)) selected = { product, index };
  }
  return selected?.product ?? null;
}

function goalCount(surface: string): number {
  const match = surface.match(/(?:至少|最少)?(\d+)(?:个|块|根|组|条|份)?/);
  return match ? Number(match[1]) : 1;
}

function productCount(surface: string, product: string): number {
  const escaped = product.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = [...surface.matchAll(new RegExp(`(\\d+)(?:个|组|条|份)?${escaped}`, 'g'))];
  return matches.length > 0 ? Number(matches.at(-1)?.[1]) : 1;
}
