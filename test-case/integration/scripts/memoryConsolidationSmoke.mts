import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LLMClient } from '../../../apps/minecraft-companion/src/bot/v2/cognitive/llm/LLMClient.js';
import { ChatMemoryService } from '../../../apps/minecraft-companion/src/bot/v2/infra/chatMemory.js';
import {
  ChatMemoryConsolidator,
  LLMMemoryFactExtractor,
} from '../../../apps/minecraft-companion/src/bot/v2/infra/chatMemoryConsolidation.js';

const apiKey = process.env.LLM_API_KEY?.trim();
if (!apiKey) throw new Error('LLM_API_KEY is required for the real memory consolidation smoke');

const root = mkdtempSync(join(tmpdir(), 'mineclaw-memory-real-smoke-'));
const dbPath = join(root, 'chat-memory.db');
const profileId = 'memory-real-smoke';
const config = {
  batchMessages: 40,
  batchChars: 8_000,
  activeFactLimit: 100,
  maxOperations: 24,
  timeoutMs: 60_000,
};

let memory: ChatMemoryService | null = null;
try {
  memory = new ChatMemoryService({ dbPath, profileId, autoCapture: false });
  memory.recordMessage({
    id: 'smoke-fish-owner',
    sessionId: 'smoke-before-restart',
    role: 'owner',
    content: '还可以，我喜欢吃鱼嘻嘻',
    timestamp: Date.now(),
  });

  const failed = await new ChatMemoryConsolidator(memory, { async extract() { return null; } })
    .runOnce(config);
  assert.equal(failed.status, 'retry');
  assert.equal(memory.pendingOwnerMessageCount(), 1);
  memory.close();
  memory = null;

  memory = new ChatMemoryService({ dbPath, profileId, autoCapture: false });
  const llm = new LLMClient({
    apiKey,
    baseUrl: process.env.LLM_BASE_URL ?? 'https://api.openai.com/v1',
    model: process.env.LLM_MODEL ?? 'gpt-4o-mini',
  }, () => undefined);
  const consolidator = new ChatMemoryConsolidator(memory, new LLMMemoryFactExtractor(llm));
  const recovered = await consolidator.runOnce(config);
  assert.equal(recovered.status, 'committed');
  const fish = memory.getMemorySlotValues({ status: 'active', slotKey: 'preference.food.favorite' })
    .find(value => String(value.value).includes('鱼'));
  assert.ok(fish, 'natural fish preference must become an active official slot after restart');
  assert.deepEqual(fish.sourceMessageIds, ['smoke-fish-owner']);
  assert.equal(memory.getFacts({ status: 'active' }).some(fact => fact.text.includes('鱼')), false);

  memory.recordMessage({
    id: 'smoke-shrimp-owner',
    sessionId: 'smoke-conflict',
    role: 'owner',
    content: '我现在不喜欢吃鱼了，更喜欢吃虾。',
    timestamp: Date.now() + 1,
  });
  const changed = await consolidator.runOnce(config);
  assert.equal(changed.status, 'committed');
  const activeFavorites = memory.getMemorySlotValues({ status: 'active', slotKey: 'preference.food.favorite' });
  const activeDislikes = memory.getMemorySlotValues({ status: 'active', slotKey: 'preference.food.dislike' });
  assert.ok(activeFavorites.some(value => String(value.value).includes('虾')), 'new shrimp preference must be active');
  assert.ok(activeDislikes.some(value => String(value.value).includes('鱼')), 'fish dislike must be active');
  assert.ok(!activeFavorites.some(value => value.id === fish.id), 'old fish favorite must leave active state');
  assert.equal(memory.getMemorySlotValues({ status: 'superseded', slotKey: 'preference.food.favorite' }).some(value => value.id === fish.id), true);

  const idle = await consolidator.runOnce(config);
  assert.equal(idle.status, 'idle');
  console.log(JSON.stringify({
    ok: true,
    recoveredAfterRestart: true,
    conflictGoverned: true,
    idleWithoutNewMessages: true,
    activeSlots: [...activeFavorites, ...activeDislikes].map(value => ({ slotKey: value.slotKey, value: value.value, sourceCount: value.sourceMessageIds.length })),
  }));
} finally {
  memory?.close();
  rmSync(root, { recursive: true, force: true });
}
