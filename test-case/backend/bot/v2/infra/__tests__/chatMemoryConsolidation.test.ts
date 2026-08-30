import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { CallWithToolsArgs } from '../../../../../../apps/minecraft-companion/src/bot/v2/cognitive/llm/LLMClient.js';
import type { LLMToolCallResult } from '../../../../../../apps/minecraft-companion/src/bot/v2/cognitive/llm/types.js';
import { ChatMemoryService } from '../../../../../../apps/minecraft-companion/src/bot/v2/infra/chatMemory.js';
import {
  ChatMemoryConsolidator,
  LLMMemoryFactExtractor,
  type MemoryExtractionInput,
  type MemoryFactExtractor,
} from '../../../../../../apps/minecraft-companion/src/bot/v2/infra/chatMemoryConsolidation.js';

const RUN_CONFIG = {
  batchMessages: 20,
  batchChars: 8_000,
  activeFactLimit: 50,
  maxOperations: 12,
  timeoutMs: 10_000,
};

async function withMemory(run: (memory: ChatMemoryService) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'mineclaw-memory-consolidation-'));
  const memory = new ChatMemoryService({ dbPath: join(dir, 'memory.db'), profileId: 'p', autoCapture: false });
  try { await run(memory); }
  finally { memory.close(); rmSync(dir, { recursive: true, force: true }); }
}

function toolResult(operations: unknown[]): LLMToolCallResult {
  return {
    content: '',
    toolCalls: [{ id: 'call-1', name: 'submit_memory_consolidation', arguments: { operations } }],
  };
}

describe('周期性对话记忆整理', () => {
  test('LLM 提取器强制结构化工具并保留 owner 证据 id', async () => {
    let captured: CallWithToolsArgs | undefined;
    const extractor = new LLMMemoryFactExtractor({
      async callWithTools(args) {
        captured = args;
        return toolResult([{
          action: 'add', kind: 'preference', text: '我喜欢吃鱼',
          sourceMessageIds: ['evidence-1'], confidence: 0.95, importance: 0.8,
        }]);
      },
    });
    const operations = await extractor.extract(extractionInput());
    assert.equal(captured?.toolChoice && typeof captured.toolChoice === 'object'
      ? captured.toolChoice.function.name : '', 'submit_memory_consolidation');
    assert.equal(captured?.traceContext?.agent, 'system');
    assert.match(captured?.messages[0]?.content ?? '', /他人引语/);
    assert.match(captured?.messages[1]?.content ?? '', /"evidenceRef":"evidence-1"/);
    assert.doesNotMatch(captured?.messages[1]?.content ?? '', /"id":"m-fish"/);
    assert.deepEqual(operations, [{
      action: 'add', kind: 'preference', text: '我喜欢吃鱼',
      sourceMessageIds: ['m-fish'], confidence: 0.95, importance: 0.8,
    }]);
  });

  test('模型引用批次外消息或非法数值时，本地拒绝整个输出', async () => {
    for (const operation of [
      { action: 'add', kind: 'preference', text: '越权事实', sourceMessageIds: ['outside'] },
      { action: 'add', kind: 'preference', text: '非法置信度', sourceMessageIds: ['m-fish'], confidence: 2 },
    ]) {
      const extractor = new LLMMemoryFactExtractor({ async callWithTools() { return toolResult([operation]); } });
      assert.equal(await extractor.extract(extractionInput()), null);
    }
  });

  test('目录外自然口语经提取后先写成 Candidate 并绑定来源', async () => withMemory(async memory => {
    memory.recordMessage({ id: 'm-fish', sessionId: 's', role: 'owner', content: '还可以，我喜欢吃鱼嘻嘻', timestamp: 1 });
    const extractor: MemoryFactExtractor = {
      async extract(input) {
        assert.equal(input.messages[0]?.content, '还可以，我喜欢吃鱼嘻嘻');
        return [{ action: 'add', kind: 'preference', text: '我喜欢吃鱼', sourceMessageIds: ['m-fish'] }];
      },
    };
    const result = await new ChatMemoryConsolidator(memory, extractor, () => 'run-fish').runOnce(RUN_CONFIG);
    assert.equal(result.status, 'committed');
    assert.equal(result.candidates, 1);
    assert.deepEqual(memory.getFacts({ status: 'candidate' }).map(fact => ({ text: fact.text, sources: fact.sourceMessageIds })), [
      { text: '我喜欢吃鱼', sources: ['m-fish'] },
    ]);
  }));

  test('没有新 owner 消息时完全不调用模型', async () => withMemory(async memory => {
    let calls = 0;
    const extractor: MemoryFactExtractor = { async extract() { calls += 1; return []; } };
    const result = await new ChatMemoryConsolidator(memory, extractor).runOnce(RUN_CONFIG);
    assert.equal(result.status, 'idle');
    assert.equal(calls, 0);
  }));

  test('模型失败时不结算账本，下个周期可重试同一原文', async () => withMemory(async memory => {
    memory.recordMessage({ id: 'm-retry', sessionId: 's', role: 'owner', content: '我喜欢安静一点', timestamp: 1 });
    const extractor: MemoryFactExtractor = { async extract() { return null; } };
    const result = await new ChatMemoryConsolidator(memory, extractor, () => 'run-retry').runOnce(RUN_CONFIG);
    assert.equal(result.status, 'retry');
    assert.equal(memory.pendingOwnerMessageCount(), 1);
    assert.equal(memory.getFacts().length, 0);
  }));

  test('空操作是成功整理，消息不会反复消耗模型', async () => withMemory(async memory => {
    memory.recordMessage({ id: 'm-smalltalk', sessionId: 's', role: 'owner', content: '今天天气还可以', timestamp: 1 });
    let calls = 0;
    const extractor: MemoryFactExtractor = { async extract() { calls += 1; return []; } };
    const consolidator = new ChatMemoryConsolidator(memory, extractor, () => 'run-empty');
    assert.equal((await consolidator.runOnce(RUN_CONFIG)).processed, 1);
    assert.equal((await consolidator.runOnce(RUN_CONFIG)).status, 'idle');
    assert.equal(calls, 1);
  }));

  test('重复一致的目录外表达累计两次主人证据后晋升 Active', async () => withMemory(async memory => {
    const extractor: MemoryFactExtractor = {
      async extract(input) {
        return [{
          action: 'candidate', kind: 'preference', text: '我可能更喜欢海边',
          sourceMessageIds: [input.messages[0]!.id],
        }];
      },
    };
    const consolidator = new ChatMemoryConsolidator(memory, extractor);
    memory.recordMessage({ id: 'm-sea-1', sessionId: 's', role: 'owner', content: '也许我更喜欢海边吧', timestamp: 1 });
    await consolidator.runOnce(RUN_CONFIG);
    memory.recordMessage({ id: 'm-sea-2', sessionId: 's', role: 'owner', content: '可能还是海边更适合我', timestamp: 2 });
    await consolidator.runOnce(RUN_CONFIG);
    const active = memory.getFacts({ status: 'active' });
    assert.equal(active.length, 1);
    assert.deepEqual(active[0]?.sourceMessageIds.sort(), ['m-sea-1', 'm-sea-2']);
  }));

  test('模型只能把命题写入候选官方槽位，问句证据会被本地忽略', async () => withMemory(async memory => {
    memory.recordMessage({ id: 'm-food', sessionId: 's', role: 'owner', content: '我喜欢吃鱼', timestamp: 1 });
    const extractor: MemoryFactExtractor = {
      async extract() {
        return [{ action: 'add', slotKey: 'preference.food.favorite', value: '鱼', sourceMessageIds: ['m-food'] }];
      },
    };
    const result = await new ChatMemoryConsolidator(memory, extractor, () => 'run-slot').runOnce(RUN_CONFIG);
    assert.equal(result.added, 1);
    assert.equal(memory.getMemorySlotValues({ status: 'active' })[0]?.value, '鱼');

    memory.recordMessage({ id: 'm-question', sessionId: 's', role: 'owner', content: '我喜欢什么？', timestamp: 2 });
    const bad: MemoryFactExtractor = {
      async extract() {
        return [{ action: 'add', slotKey: 'preference.food.favorite', value: '牛肉', sourceMessageIds: ['m-question'] }];
      },
    };
    const ignored = await new ChatMemoryConsolidator(memory, bad, () => 'run-question').runOnce(RUN_CONFIG);
    assert.equal(ignored.ignored, 1);
    assert.deepEqual(memory.getMemorySlotValues({ status: 'active' }).map(value => value.value), ['鱼']);
  }));
});

function extractionInput(): MemoryExtractionInput {
  return {
    messages: [{ id: 'm-fish', sessionId: 's', role: 'owner', content: '还可以，我喜欢吃鱼嘻嘻', timestamp: 1 }],
    activeFacts: [],
    maxOperations: 12,
    timeoutMs: 10_000,
    runId: 'run-contract',
  };
}
