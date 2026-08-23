import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMockBot } from './mocks/index.js';
import { V2Runtime } from '../../../../../apps/minecraft-companion/src/bot/v2/v2Runtime.js';

function runtime(semanticSearch?: boolean): V2Runtime {
  const bot = createMockBot();
  return new V2Runtime({
    game: bot.game,
    nav: bot.nav,
    embodied: false,
    ownerName: 'TestOwner',
    botName: `MemoryConfig-${semanticSearch ?? 'default'}`,
    dbPath: ':memory:',
    worldMapDbPath: ':memory:',
    chatMemoryDbPath: ':memory:',
    chatMemorySemanticSearch: semanticSearch,
  });
}

test('BUG-MEM-20 · 生产 V2Runtime 默认启用本地 Embedding', () => {
  const subject = runtime();
  try {
    subject.chatMemory.recordMessage({ id: 'default-message', sessionId: 's', role: 'owner', content: '记住蓝色纸船计划', timestamp: 1 });
    assert.ok(subject.chatMemory.inspectMetrics().embeddingRequests > 0);
  } finally {
    subject.stop();
  }
});

test('BUG-MEM-20 · 关闭语义检索后不请求 Embedding 且 FTS5 仍命中', () => {
  const subject = runtime(false);
  try {
    subject.chatMemory.recordMessage({ id: 'fts-message', sessionId: 's', role: 'owner', content: '记住蓝色纸船计划', timestamp: 1 });
    assert.equal(subject.chatMemory.inspectMetrics().embeddingRequests, 0);
    assert.deepEqual(subject.chatMemory.searchMessages('蓝色纸船', 5).map(item => item.id), ['fts-message']);
    assert.deepEqual(subject.chatMemory.searchMessagesMultiHop('蓝色纸船', 5).map(item => item.id), ['fts-message']);
  } finally {
    subject.stop();
  }
});
