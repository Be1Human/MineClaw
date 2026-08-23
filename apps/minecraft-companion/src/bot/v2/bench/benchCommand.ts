import { getTestCard, TEST_CARDS } from './cards.js';

export type BenchCommand =
  | { kind: 'not_bench' }
  | { kind: 'list' }
  | { kind: 'abort' }
  | { kind: 'run'; cardId: string }
  | { kind: 'error'; message: string };

/** 精确前缀解析，避免误伤普通聊天内容。 */
export function parseBenchCommand(message: string): BenchCommand {
  if (!message.startsWith('#test')) return { kind: 'not_bench' };
  const arg = message.slice(5).trim();
  if (!arg || arg === 'list') return { kind: 'list' };
  if (arg === 'abort') return { kind: 'abort' };
  return getTestCard(arg) ? { kind: 'run', cardId: arg } : { kind: 'error', message: `未知测试卡：${arg}；可用：${TEST_CARDS.map(card => card.id).join(', ')}` };
}
