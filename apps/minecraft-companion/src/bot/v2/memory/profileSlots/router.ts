import type { ChatMessage } from '../../infra/chatMemory.js';
import { getMemorySlotDefinition, searchMemorySlotDefinitions } from './catalog.js';
import type { MemorySlotDefinition } from './contracts.js';

export type OwnerMemorySpeechAct = 'statement' | 'explicit_statement' | 'question' | 'quote' | 'temporary' | 'unsafe';

export interface DeterministicSlotRoute {
  slotKey: string;
  value: string;
  operation: 'add' | 'remove';
}

const QUESTION = /(?:[?？]\s*$|^(?:我|你|他|她|它|我们|他们)?(?:喜欢|不喜欢|爱|讨厌)?什么|^(?:为什么|怎么|是否|是不是|能不能|可不可以|谁|哪里|哪种|哪个))/u;
const QUOTE = /^(?:他说|她说|它说|别人说|朋友说|有人说|原话是|引用)[，,:：\s]/u;
const TEMPORARY = /(?:现在|刚刚|刚才|今天|这会儿|目前|这一局|这局|这次|暂时)(?:有点|很|正在|想|要|不想|饿|累|忙|玩|做)/u;
const UNSAFE = /(?:api[_ -]?key|password|passwd|token|secret|sk-[\w-]{8,}|system prompt|开发者消息|忽略(?:之前|以上)?指令)/i;
const EXPLICIT = /^(?:请)?(?:记住|记一下|记得|保存下来)[，,:：\s]?/u;

export function classifyOwnerMemorySpeech(text: string): OwnerMemorySpeechAct {
  const clean = text.trim();
  if (!clean || UNSAFE.test(clean)) return 'unsafe';
  if (EXPLICIT.test(clean)) return 'explicit_statement';
  if (QUESTION.test(clean)) return 'question';
  if (QUOTE.test(clean)) return 'quote';
  if (TEMPORARY.test(clean)) return 'temporary';
  return 'statement';
}

export function isStorableOwnerMemoryStatement(text: string): boolean {
  return ['statement', 'explicit_statement'].includes(classifyOwnerMemorySpeech(text));
}

export function isExplicitMemoryStatement(text: string): boolean {
  return classifyOwnerMemorySpeech(text) === 'explicit_statement';
}

export function stripExplicitMemoryPrefix(text: string): string {
  return text.trim().replace(EXPLICIT, '').trim();
}

export function routeDeterministicMemorySlot(text: string): DeterministicSlotRoute | null {
  const act = classifyOwnerMemorySpeech(text);
  if (act !== 'statement' && act !== 'explicit_statement') return null;
  const clean = stripExplicitMemoryPrefix(text).replace(/[。！!]+$/u, '').trim();
  const routes: Array<{ pattern: RegExp; slotKey: string; operation?: 'add' | 'remove' }> = [
    { pattern: /^(?:我)?不再(?:喜欢|爱)吃(.+)$/u, slotKey: 'preference.food.favorite', operation: 'remove' },
    { pattern: /^(?:我)?(?:最|很|特别|非常)?(?:喜欢|爱)吃(.+)$/u, slotKey: 'preference.food.favorite' },
    { pattern: /^(?:我)?(?:不喜欢|讨厌|不爱)吃(.+)$/u, slotKey: 'preference.food.dislike' },
    { pattern: /^(?:我)?(?:最|很|特别|非常)?(?:喜欢|爱)喝(.+)$/u, slotKey: 'preference.drink.favorite' },
    { pattern: /^(?:我)?(?:不喜欢|讨厌|不爱)喝(.+)$/u, slotKey: 'preference.drink.dislike' },
    { pattern: /^(?:以后)?(?:请)?叫我(.+)$/u, slotKey: 'identity.preferred_name' },
    { pattern: /^我的名字(?:叫|是)(.+)$/u, slotKey: 'identity.preferred_name' },
    { pattern: /^(?:我)?喜欢(.+?)音乐$/u, slotKey: 'preference.music.genre' },
    { pattern: /^(?:我)?喜欢(?:玩)?(.+?)(?:游戏)$/u, slotKey: 'preference.game.title' },
    { pattern: /^(?:我)?的爱好是(.+)$/u, slotKey: 'interest.hobby' },
  ];
  for (const route of routes) {
    const match = clean.match(route.pattern);
    const value = cleanSlotValue(match?.[1]);
    if (value) return { slotKey: route.slotKey, value, operation: route.operation ?? 'add' };
  }
  return null;
}

export function candidateMemorySlots(messages: readonly ChatMessage[], limit = 20): MemorySlotDefinition[] {
  const merged = new Map<string, MemorySlotDefinition>();
  for (const message of messages) {
    const route = routeDeterministicMemorySlot(message.content);
    const exact = route ? getMemorySlotDefinition(route.slotKey) : null;
    if (exact) merged.set(exact.slotKey, exact);
    for (const definition of searchMemorySlotDefinitions(message.content, 8)) merged.set(definition.slotKey, definition);
  }
  return [...merged.values()].slice(0, Math.max(1, Math.floor(limit)));
}

function cleanSlotValue(value: string | undefined): string | null {
  const clean = value?.trim().replace(/^(?:是|就是)\s*/u, '').replace(/[，,。！!?？]+$/u, '').trim();
  return clean && clean.length <= 80 && !QUESTION.test(clean) ? clean : null;
}
