import assert from 'node:assert/strict';
import test from 'node:test';

import { OpenAICompatibleProvider } from '../../../../../../../apps/minecraft-companion/src/bot/v2/cognitive/llm/openaiCompatibleProvider.js';
import {
  isLLMProviderResult,
  type LLMProviderResult,
  type LLMToolCallResult,
} from '../../../../../../../apps/minecraft-companion/src/bot/v2/cognitive/llm/types.js';

test('OpenAI-compatible Provider 为普通调用和工具调用返回统一 usage 信封', async () => {
  const originalFetch = globalThis.fetch;
  let callIndex = 0;
  globalThis.fetch = (async () => {
    callIndex += 1;
    const data = callIndex === 1
      ? {
          choices: [{ finish_reason: 'stop', message: { content: '你好' } }],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 20,
            total_tokens: 120,
            prompt_tokens_details: { cached_tokens: 80 },
          },
        }
      : {
          choices: [{
            finish_reason: 'tool_calls',
            message: {
              content: '',
              tool_calls: [{
                id: 'tool-1',
                function: { name: 'say', arguments: '{"text":"ok"}' },
              }],
            },
          }],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 10,
            prompt_cache_hit_tokens: 80,
            prompt_cache_miss_tokens: 20,
          },
        };
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const provider = new OpenAICompatibleProvider();
    const plain = await provider.call({
      apiKey: 'secret', baseUrl: 'https://example.test/v1', model: 'model', user: 'hi',
    });
    assert.equal(isLLMProviderResult<string | null>(plain), true);
    const plainResult = plain as LLMProviderResult<string | null>;
    assert.equal(plainResult.value, '你好');
    assert.equal(plainResult.finishReason, 'stop');
    assert.equal(plainResult.usage.cachedInputTokens, 80);
    assert.equal(plainResult.usage.cacheEligibleInputTokens, 100);

    const tools = await provider.callWithTools({
      apiKey: 'secret', baseUrl: 'https://example.test/v1', model: 'model',
      messages: [{ role: 'user', content: 'speak' }],
      tools: [],
    });
    assert.equal(isLLMProviderResult<LLMToolCallResult | null>(tools), true);
    const toolResult = tools as LLMProviderResult<LLMToolCallResult | null>;
    assert.equal(toolResult.finishReason, 'tool_calls');
    assert.deepEqual(toolResult.value?.toolCalls, [{ id: 'tool-1', name: 'say', arguments: { text: 'ok' } }]);
    assert.equal(toolResult.usage.cachedInputTokens, 80);
    assert.equal(toolResult.usage.cacheMissInputTokens, 20);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
