import type { GoalIntentKindV2 } from './contracts.js';
import { isTaskCancellationRequest } from '../ownerControlIntent.js';

export type OwnerTurnIntentKind = 'chat' | 'game_query' | 'game_action' | 'game_cancel';

const ACTION_ZH = /(?:交给|递给|送给|拿给|扔给|合成|制造|采集|跟随|攻击|建造|放置|使用|装备|让背包|使背包|背包达到|创建.{0,8}任务|跟着我|跟我来|来我这|过来|给|做|造|采|挖|砍|种|去|走|移动|打|盖|搭|找|守|护|杀|捡|拿|放|存|搬|烧|钓|喂|驯|丢)/;
const ACTION_EN = /\b(?:deliver|give|bring|craft|make|mine|collect|go|move|follow|attack|build|place|drop)\b/i;
const GAME_QUERY_ZH = /(?:背包|物品栏|库存|坐标|位置|附近|世界|方块|矿物|箱子|任务进度|做到哪|做完|还在做)/;
const GAME_QUERY_EN = /\b(?:status|inventory|position|coordinate|nearby|progress)\b/i;
const DISCUSSION = /(?:想想|聊聊|讨论|建议|看法|为什么|为啥|怎么做比较好|如何设计|故事|笑话)/i;
const INTERNAL_TURN = /^\[(?:idle|内部状态触发|内部任务续接|goalagent\s*任务续接|task_feedback)\]/i;

const isCancel = (text: string): boolean => isTaskCancellationRequest(text);
const isAction = (text: string): boolean => ACTION_ZH.test(text) || ACTION_EN.test(text);
const isGameQuery = (text: string): boolean => GAME_QUERY_ZH.test(text) || GAME_QUERY_EN.test(text);

/**
 * Owner turn 的游戏边界分类归 GoalAgent ingress 所有。
 * MainBrain/LoopCritic 只消费分类结果，不维护 Minecraft 动词白名单。
 */
export function classifyOwnerTurn(rawText: string): OwnerTurnIntentKind {
  const text = rawText.trim();
  if (!text) return 'chat';
  if (INTERNAL_TURN.test(text)) return 'chat';
  if (DISCUSSION.test(text)) return 'chat';
  if (isCancel(text)) return 'game_cancel';
  if (isAction(text)) return 'game_action';
  if (isGameQuery(text)) return 'game_query';
  return 'chat';
}

/** GoalAgent ingress classifier. MainBrain must not classify game semantics. */
export function classifyGoalRequest(rawText: string): GoalIntentKindV2 {
  if (isCancel(rawText)) return 'cancel';
  if (isAction(rawText)) return 'action';
  return 'query';
}

export function clarifyGoalRequest(
  rawText: string,
  inventory: Array<{ name: string; count: number }>,
): string | null {
  const asksForPickaxe = /(?:稿子|镐子|镐|pickaxe)/i.test(rawText);
  const specifiesMaterial = /(?:木镐|石镐|铁镐|金镐|钻石镐|下界合金镐|wooden_pickaxe|stone_pickaxe|iron_pickaxe|golden_pickaxe|diamond_pickaxe|netherite_pickaxe)/i.test(rawText);
  const isDelivery = /(?:给|交给|递给|送给|拿给|扔给|deliver|give|bring|drop)/i.test(rawText);
  if (!asksForPickaxe || specifiesMaterial || !isDelivery) return null;
  const labels: Record<string, string> = {
    wooden_pickaxe: '木镐', stone_pickaxe: '石镐', iron_pickaxe: '铁镐',
    golden_pickaxe: '金镐', diamond_pickaxe: '钻石镐', netherite_pickaxe: '下界合金镐',
  };
  const candidates = inventory
    .filter(item => item.count > 0 && item.name.endsWith('_pickaxe'))
    .map(item => labels[item.name] ?? item.name);
  const unique = [...new Set(candidates)];
  return unique.length > 1 ? `你想要${unique.join('还是')}？` : null;
}
