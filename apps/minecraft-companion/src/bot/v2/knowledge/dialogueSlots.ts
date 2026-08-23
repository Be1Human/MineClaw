/**
 * 🧩 L7 知识 · 自然语言 → minecraft item id 提取（defaultFrom:[dialogue] 的运行时实现）
 *
 * 背景（真服 bug 2026-06-12）：LLM 调 decompose_task 建 gather_material 任务时
 * 漏填 required 槽 material（思考里说"采橡木"却没传），任务带空 material 启动 →
 * gatherStrategy 秒失败 no_resource_found。task.yaml 里 material 本就标了
 * defaultFrom:[dialogue]，意为"从对话提取"，但此前从无运行时实现。这里补上。
 *
 * 设计：这是「'木头'指什么」的**知识/同义词表**，不是阈值/超时/冷却类**行为参数**，
 * 故放知识层定义，不入 tuning.ts（tuning 只收魔法数字）。命中不了返回 null →
 * 上层走 clarify 反问主人，绝不瞎猜。
 */

/**
 * 同义词 → minecraft id。
 * 顺序即优先级：靠前的先匹配（"木头/原木"统一映 oak_log，配合 gatherStrategy 的
 * logMode "任意原木互换"——砍到任何树都算数，不会死找某种树）。
 * 覆盖常见即可，生僻材料命中不了就 clarify，不强求穷举。
 */
import { defaultGoalKnowledge } from './goalTargetKnowledge.js';

/**
 * 从一段自然语言里提取一个 item 槽的 minecraft id。
 * @param text 主人原话（或 LLM 已传的别名值）
 * @returns 命中的 minecraft id；命中不了返回 null（上层据此 clarify）
 */
export function extractItemFromDialogue(text: string | null | undefined): string | null {
  const raw = (text ?? '').trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();

  const candidate = defaultGoalKnowledge.searchTargets({ query: lower, kind: 'item', limit: 1 })[0];
  if (!candidate || !candidate.registryId.startsWith('minecraft:')) return null;
  return candidate.registryId.replace(/^minecraft:/, '');
}

/**
 * 地标块同义词 → minecraft 方块 id（FEAT-L7-12 · locate_block）。
 *
 * 与 GoalTargetKnowledge 的区别：这里映的是世界里【放置的方块】
 * （gold_block / chest / crafting_table…），用于"走到金块那里"这类地标指代；
 * GoalTargetKnowledge 映的是任务可操作目标。地标词表不是物品目标的第二事实源。
 * 顺序即优先级：更具体的词靠前（"金块"先于"金"）。
 */
const BLOCK_SYNONYMS: Array<{ id: string; words: string[] }> = [
  { id: 'gold_block', words: ['金块', '黄金块', 'gold_block', 'gold block'] },
  { id: 'iron_block', words: ['铁块', 'iron_block', 'iron block'] },
  { id: 'diamond_block', words: ['钻石块', 'diamond_block', 'diamond block'] },
  { id: 'emerald_block', words: ['绿宝石块', '祖母绿块', 'emerald_block', 'emerald block'] },
  { id: 'netherite_block', words: ['下界合金块', 'netherite_block', 'netherite block'] },
  { id: 'redstone_block', words: ['红石块', 'redstone_block', 'redstone block'] },
  { id: 'white_wool', words: ['羊毛', '白羊毛', 'white_wool', 'wool'] },
  { id: 'pumpkin', words: ['南瓜', 'pumpkin'] },
  { id: 'melon', words: ['西瓜', 'melon'] },
  { id: 'hay_block', words: ['草垛', '干草块', 'hay_block', 'haystack'] },
  { id: 'chest', words: ['箱子', '储物箱', '宝箱', 'chest'] },
  { id: 'furnace', words: ['熔炉', '炉子', 'furnace'] },
  { id: 'crafting_table', words: ['工作台', '合成台', '制作台', 'crafting_table', 'crafting table'] },
  { id: 'bed', words: ['床', 'bed'] },
  { id: 'beacon', words: ['信标', 'beacon'] },
];

/**
 * 从主人原话提取坐标（BUG-CROSS-01 热修 · LLM 丢参兜底）。
 * 背景：LLM 思考里有坐标、decompose_task 入参却经常不带（真服多次复现），
 * 合并修复救不了"根本没传"。这里直接从原话抠："0,0,0" / "我在 520 -60 520" /
 * "(430, -60, 0)" / "x=10 y=64 z=-3" 等三数模式。
 * @returns {x,y,z} 或 null（原话里没有三个连续数字）
 */
export function extractPositionFromDialogue(
  text: string | null | undefined,
): { x: number; y: number; z: number } | null {
  const raw = (text ?? '').trim();
  if (!raw) return null;
  // 三个整数/小数，以逗号/空格/顿号分隔，可被括号包裹
  const m = raw.match(/(-?\d+(?:\.\d+)?)\s*[,，、\s]\s*(-?\d+(?:\.\d+)?)\s*[,，、\s]\s*(-?\d+(?:\.\d+)?)/);
  if (!m) return null;
  const x = Number(m[1]), y = Number(m[2]), z = Number(m[3]);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  // 合法性粗筛：y 在世界高度范围内（MC: -64~320），防把"3 件 5 个 10 块"误当坐标
  if (y < -64 || y > 320) return null;
  return { x, y, z };
}

/**
 * 把"地标块名指代"解析成 minecraft 方块 id（FEAT-L7-12）。
 * @param text 主人原话里的块名指代（"金块"/"gold block"/"chest"）
 * @returns 命中的方块 id；命中不了返回 null（dispatcher 再尝试当原 id 用，仍不行才反问）
 */
export function resolveBlockId(text: string | null | undefined): string | null {
  const raw = (text ?? '').trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();

  // 1) 整段本身就是合法 id（LLM 直接传了 "gold_block"），直接采信
  if (/^[a-z][a-z0-9_]*$/.test(lower) && lower.includes('_')) return lower;

  // 2) 地标块同义词表匹配
  for (const { id, words } of BLOCK_SYNONYMS) {
    for (const w of words) {
      if (lower.includes(w.toLowerCase())) return id;
    }
  }
  return null;
}
