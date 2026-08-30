import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ChatCompletionsCodec } from '../../../../../../../apps/minecraft-companion/src/bot/v2/cognitive/llm/chatCompletionsCodec.js';
import { LlmApiCodecError } from '../../../../../../../apps/minecraft-companion/src/bot/v2/cognitive/llm/apiCodec.js';
import { ArkProvider } from '../../../../../../../apps/minecraft-companion/src/bot/v2/cognitive/llm/arkProvider.js';
import { OpenAICompatibleProvider } from '../../../../../../../apps/minecraft-companion/src/bot/v2/cognitive/llm/openaiCompatibleProvider.js';
import { LLMProviderError } from '../../../../../../../apps/minecraft-companion/src/bot/v2/cognitive/llm/errors.js';

describe('FEAT-CROSS-22 · Chat Completions codec', () => {
  it('owns nested tools, tool history and the DeepSeek thinking policy', () => {
    const exact = new ChatCompletionsCodec().buildRequest({
      messages: [
        { role: 'system', content: [{ kind: 'text', text: 'be concise' }] },
        { role: 'user', content: [{ kind: 'text', text: 'look' }] },
        { role: 'assistant', content: [{ kind: 'tool-call', id: 'call-1', name: 'look', arguments: { radius: 3 } }] },
        { role: 'assistant', content: [{ kind: 'tool-result', callId: 'call-1', output: '{"ok":true}' }] },
      ],
      tools: [{ name: 'look', description: 'Look around', parameters: { type: 'object', properties: {} } }],
      toolChoice: { name: 'look' },
    }, { routeId: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' });

    assert.equal(exact.path, '/chat/completions');
    assert.deepEqual(exact.body.thinking, { type: 'disabled' });
    assert.deepEqual(exact.body.tool_choice, { type: 'function', function: { name: 'look' } });
    assert.deepEqual((exact.body.tools as Array<Record<string, unknown>>)[0], {
      type: 'function',
      function: {
        name: 'look', description: 'Look around', parameters: { type: 'object', properties: {} },
      },
    });
    assert.deepEqual((exact.body.messages as Array<Record<string, unknown>>).at(-1), {
      role: 'tool', content: '{"ok":true}', tool_call_id: 'call-1',
    });
  });

  it('parses reasoning, text, every tool call and cached usage', () => {
    const result = new ChatCompletionsCodec().parseResponse({
      choices: [{
        finish_reason: 'tool_calls',
        message: {
          reasoning_content: 'checked context',
          content: 'using tools',
          tool_calls: [
            { id: 'a', function: { name: 'look', arguments: '{"radius":2}' } },
            { id: 'b', function: { name: 'say', arguments: '{"text":"ok"}' } },
          ],
        },
      }],
      usage: {
        prompt_tokens: 100, completion_tokens: 10, total_tokens: 110,
        prompt_tokens_details: { cached_tokens: 80 },
      },
    }, { routeId: 'example', baseUrl: 'https://example.test/v1', model: 'model' });

    assert.deepEqual(result.content, [
      { kind: 'reasoning', text: 'checked context' },
      { kind: 'text', text: 'using tools' },
      { kind: 'tool-call', id: 'a', name: 'look', arguments: { radius: 2 } },
      { kind: 'tool-call', id: 'b', name: 'say', arguments: { text: 'ok' } },
    ]);
    assert.equal(result.usage.cachedInputTokens, 80);
    assert.equal(result.finishReason, 'tool_calls');
  });

  it('rejects malformed tool arguments instead of executing an empty object', () => {
    assert.throws(() => new ChatCompletionsCodec().parseResponse({
      choices: [{ message: { tool_calls: [
        { id: 'broken', function: { name: 'act', arguments: '{broken' } },
      ] } }],
    }, { routeId: 'example', baseUrl: 'https://example.test/v1', model: 'model' }), LlmApiCodecError);
  });

  it('keeps Ark route matching and refuses unknown API without fallback', async () => {
    assert.equal(new ArkProvider().matches('https://ark.cn-beijing.volces.com/api/v3'), true);
    const provider = new OpenAICompatibleProvider();
    await assert.rejects(provider.call({
      routeId: 'route',
      api: 'anthropic-messages' as 'openai-responses',
      apiKey: 'test',
      baseUrl: 'https://example.test/v1',
      model: 'model',
      user: 'hello',
    }), (error: unknown) => (
      error instanceof LLMProviderError && error.failure.kind === 'unsupported'
    ));
  });
});
