import type { WorldBookEntry } from './types.js';

function normalized(value: string): string { return value.trim().toLocaleLowerCase('zh-CN'); }

export function selectWorldBookEntries(entries: WorldBookEntry[], message: string, budgetChars = 3000): WorldBookEntry[] {
  const query = normalized(message);
  const candidates = entries
    .filter(entry => entry.enabled && (entry.constant || entry.keywords.some(keyword => query.includes(normalized(keyword)))))
    .sort((a, b) => Number(Boolean(b.constant)) - Number(Boolean(a.constant)) || b.priority - a.priority || a.id.localeCompare(b.id));
  const selected: WorldBookEntry[] = [];
  let used = 0;
  for (const entry of candidates) {
    const size = entry.title.length + entry.content.length + 8;
    if (used + size > budgetChars) continue;
    selected.push(entry);
    used += size;
  }
  return selected;
}
