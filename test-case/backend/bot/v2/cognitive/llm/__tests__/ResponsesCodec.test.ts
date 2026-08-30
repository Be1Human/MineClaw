import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  ResponsesCodec,
  decideResponsesReplay,
} from '../../../../../../../apps/minecraft-companion/src/bot/v2/cognitive/llm/responsesCodec.js';
import { LlmApiCodecError } from '../../../../../../../apps/minecraft-companion/src/bot/v2/cognitive/llm/apiCodec.js';
import { OpenAICompatibleProvider } from '../../../../../../../apps/minecraft-companion/src/bot/v2/cognitive/llm/openaiCompatibleProvider.js';
import { LLMProviderError } from '../../../../../../../apps/minecraft-companion/src/bot/v2/cognitive/llm/errors.js';

const route = { routeId: 'route-responses', baseUrl: 'https://api.openai.com/v1', model: 'gpt-test' };

describe('FEAT-CROSS-22 · OpenAI Responses codec', () => {
  it('builds stateless input items, flat tools and function outputs', () => {
    const exact = new ResponsesCodec().buildRequest({
      messages: [
        { role: 'system', content: [{ kind: 'text', text: 'You are MineClaw.' }] },
        { role: 'user', content: [{ kind: 'text', text: 'inspect' }] },
        { role: 'assistant', content: [{ kind: 'tool-call', id: 'call-1', name: 'look', arguments: { radius: 2 } }] },
        { role: 'assistant', content: [{ kind: 'tool-result', callId: 'call-1', output: '{"ok":true}' }] },
      ],
      tools: [{ name: 'look', description: 'Look around', parameters: { type: 'object', properties: {} } }],
      toolChoice: { name: 'look' },
      maxTokens: 256,
    }, route);

    assert.equal(exact.path, '/responses');
    assert.equal(exact.body.store, false);
    assert.deepEqual(exact.body.include, ['reasoning.encrypted_content']);
    assert.equal(Object.hasOwn(exact.body, 'previous_response_id'), false);
    assert.equal(exact.body.instructions, 'You are MineClaw.');
    assert.deepEqual(exact.body.tools, [{
      type: 'function', name: 'look', description: 'Look around',
      parameters: { type: 'object', properties: {} },
    }]);
    assert.deepEqual(exact.body.tool_choice, { type: 'function', name: 'look' });
    assert.deepEqual(exact.body.input, [
      { role: 'user', content: [{ type: 'input_text', text: 'inspect' }] },
      { type: 'function_call', call_id: 'call-1', name: 'look', arguments: '{"radius":2}' },
      { type: 'function_call_output', call_id: 'call-1', output: '{"ok":true}' },
    ]);
    assert.equal(exact.body.max_output_tokens, 256);
  });

  it('disables DeepSeek Responses thinking for tool calls that use tool_choice', () => {
    const exact = new ResponsesCodec().buildRequest({
      messages: [{ role: 'user', content: [{ kind: 'text', text: 'inspect' }] }],
      tools: [{ name: 'look', description: 'Look around', parameters: { type: 'object' } }],
      toolChoice: { name: 'look' },
    }, { routeId: 'deepseek-responses', baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-flash' });

    assert.deepEqual(exact.body.reasoning, { effort: 'none' });
    assert.deepEqual(exact.body.tool_choice, { type: 'function', name: 'look' });
    assert.equal(Object.hasOwn(new ResponsesCodec().buildRequest({
      messages: [{ role: 'user', content: [{ kind: 'text', text: 'hello' }] }],
      tools: [],
    }, route).body, 'reasoning'), false);
  });

  it('walks every output item and records encrypted reasoning plus actual usage', () => {
    const result = new ResponsesCodec().parseResponse({
      id: 'resp-1',
      object: 'response',
      status: 'completed',
      output: [
        {
          id: 'rs-1', type: 'reasoning', status: 'completed', encrypted_content: 'encrypted-value',
          summary: [{ type: 'summary_text', text: 'checked the plan' }],
        },
        {
          id: 'msg-1', type: 'message', status: 'completed', role: 'assistant',
          content: [{ type: 'output_text', text: 'I need two checks.', annotations: [] }],
        },
        { id: 'fc-1', type: 'function_call', status: 'completed', call_id: 'call-a', name: 'look', arguments: '{"radius":2}' },
        { id: 'fc-2', type: 'function_call', status: 'completed', call_id: 'call-b', name: 'say', arguments: '{"text":"ok"}' },
      ],
      usage: {
        input_tokens: 120,
        output_tokens: 40,
        total_tokens: 160,
        input_tokens_details: { cached_tokens: 80, cache_write_tokens: 12 },
        output_tokens_details: { reasoning_tokens: 24 },
      },
    }, route);

    assert.deepEqual(result.content, [
      { kind: 'reasoning', text: 'checked the plan' },
      { kind: 'text', text: 'I need two checks.' },
      { kind: 'tool-call', id: 'call-a', name: 'look', arguments: { radius: 2 } },
      { kind: 'tool-call', id: 'call-b', name: 'say', arguments: { text: 'ok' } },
    ]);
    assert.equal(result.usage.cachedInputTokens, 80);
    assert.equal(result.usage.cacheMissInputTokens, 40);
    assert.equal(result.usage.cacheWriteInputTokens, 12);
    assert.equal(result.usage.reasoningOutputTokens, 24);
    assert.equal(result.replay?.providerRoute, 'route-responses');
    assert.equal(result.replay?.model, 'gpt-test');
    assert.equal(result.replay?.blocks.length, result.content.length);
    assert.equal(result.replay?.blocks[0]?.encrypted_content, 'encrypted-value');
  });

  it('keeps encrypted-only reasoning replayable without inventing visible text', () => {
    const result = new ResponsesCodec().parseResponse({
      id: 'resp-2', status: 'completed',
      output: [{ id: 'rs-2', type: 'reasoning', encrypted_content: 'opaque-only', summary: [] }],
    }, route);
    assert.deepEqual(result.content, [{ kind: 'reasoning', text: '' }]);
    assert.equal(result.replay?.blocks[0]?.encrypted_content, 'opaque-only');
  });

  it('replays native output items only when route, model and every block match', () => {
    const codec = new ResponsesCodec();
    const parsed = codec.parseResponse({
      id: 'resp-replay', status: 'completed',
      output: [
        { id: 'rs-r', type: 'reasoning', status: 'completed', encrypted_content: 'opaque', summary: [] },
        {
          id: 'msg-r', type: 'message', status: 'completed', role: 'assistant',
          content: [{ type: 'output_text', text: 'Checking.', annotations: [{ type: 'url_citation', url: 'https://example.test' }] }],
        },
        { id: 'fc-r', type: 'function_call', status: 'completed', call_id: 'call-r', name: 'look', arguments: '{"radius":3}' },
      ],
    }, route);
    const message = {
      role: 'assistant' as const,
      content: parsed.content,
      source: { providerRoute: route.routeId, model: route.model, replay: parsed.replay! },
    };

    const decision = decideResponsesReplay(message, route);
    assert.equal(decision.source, 'native-replay');
    assert.equal(decision.items[0]?.encrypted_content, 'opaque');
    assert.deepEqual(decision.items[1], {
      id: 'msg-r', type: 'message', status: 'completed', role: 'assistant',
      content: [{ type: 'output_text', text: 'Checking.', annotations: [{ type: 'url_citation', url: 'https://example.test' }] }],
    });
    assert.deepEqual(decision.items[2], {
      id: 'fc-r', type: 'function_call', status: 'completed', call_id: 'call-r',
      name: 'look', arguments: '{"radius":3}',
    });
  });

  it('falls back as one canonical unit on replay mismatch and emits tool results once', () => {
    const codec = new ResponsesCodec();
    const parsed = codec.parseResponse({
      output: [
        { type: 'reasoning', encrypted_content: 'opaque', summary: [] },
        { type: 'function_call', call_id: 'call-r', name: 'look', arguments: '{}' },
      ],
    }, route);
    const mismatched = {
      role: 'assistant' as const,
      content: parsed.content,
      source: { providerRoute: route.routeId, model: route.model, replay: { ...parsed.replay!, model: 'other-model' } },
    };

    const decision = decideResponsesReplay(mismatched, route);
    assert.equal(decision.source, 'canonical-rebuild');
    assert.equal(decision.reason, 'model-mismatch');
    assert.deepEqual(decision.items, [
      { type: 'function_call', call_id: 'call-r', name: 'look', arguments: '{}' },
    ]);

    const exact = codec.buildRequest({
      messages: [
        mismatched,
        { role: 'assistant', content: [{ kind: 'tool-result', callId: 'call-r', output: '{"ok":true}' }] },
      ],
      tools: [],
    }, route);
    const input = exact.body.input as Array<Record<string, unknown>>;
    assert.equal(input.filter(item => item.type === 'function_call_output').length, 1);
    assert.equal(Object.hasOwn(exact.body, 'previous_response_id'), false);
  });

  it('classifies every replay fingerprint and block-alignment degradation without throwing', () => {
    const parsed = new ResponsesCodec().parseResponse({
      output: [
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'safe canonical text' }] },
        { type: 'function_call', call_id: 'call-fault', name: 'look', arguments: '{}' },
      ],
    }, route);
    const base = {
      role: 'assistant' as const,
      content: parsed.content,
      source: { providerRoute: route.routeId, model: route.model, replay: parsed.replay! },
    };
    const cases = [
      {
        name: 'provider route',
        message: { ...base, source: { ...base.source, providerRoute: 'route-other' } },
        reason: 'provider-route-mismatch',
      },
      {
        name: 'unknown version',
        message: { ...base, source: { ...base.source, replay: { ...base.source.replay, version: 99 as never } } },
        reason: 'unsupported-envelope',
      },
      {
        name: 'API fingerprint',
        message: { ...base, source: { ...base.source, replay: { ...base.source.replay, api: 'openai-completions' as const } } },
        reason: 'unsupported-envelope',
      },
      {
        name: 'block count',
        message: { ...base, source: { ...base.source, replay: { ...base.source.replay, blocks: [base.source.replay.blocks[0]!] } } },
        reason: 'block-count-mismatch',
      },
      {
        name: 'block type',
        message: { ...base, source: { ...base.source, replay: { ...base.source.replay, blocks: [{ type: 'reasoning' }, base.source.replay.blocks[1]!] } } },
        reason: 'block-0-mismatch',
      },
      {
        name: 'damaged metadata',
        message: { ...base, source: { ...base.source, replay: { ...base.source.replay, blocks: [null, base.source.replay.blocks[1]!] } } },
        reason: 'block-0-mismatch',
      },
    ];

    for (const fault of cases) {
      const decision = decideResponsesReplay(fault.message, route);
      assert.equal(decision.source, 'canonical-rebuild', fault.name);
      assert.equal(decision.reason, fault.reason, fault.name);
      assert.ok(decision.items.some(item => item.type === 'message'), fault.name);
      assert.ok(decision.items.some(item => item.type === 'function_call'), fault.name);
    }
    assert.deepEqual(decideResponsesReplay({ role: 'assistant', content: base.content }, route), {
      items: [
        { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'safe canonical text', annotations: [] }] },
        { type: 'function_call', call_id: 'call-fault', name: 'look', arguments: '{}' },
      ],
      source: 'canonical-rebuild',
      reason: 'missing-envelope',
    });
  });

  it('rejects malformed function arguments before tool execution', () => {
    assert.throws(() => new ResponsesCodec().parseResponse({
      output: [{ type: 'function_call', call_id: 'bad', name: 'act', arguments: '{bad' }],
    }, route), LlmApiCodecError);
  });

  it('dispatches /responses and preserves shared HTTP error semantics', async () => {
    const originalFetch = globalThis.fetch;
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (input, init) => {
      requests.push({ url: String(input), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return new Response(JSON.stringify({
        id: 'resp-provider', status: 'completed',
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'OK' }] }],
        usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    try {
      const provider = new OpenAICompatibleProvider();
      const response = await provider.callWithTools({
        routeId: 'route-responses', api: 'openai-responses', apiKey: 'secret',
        baseUrl: 'https://example.test/v1', model: 'model',
        messages: [{ role: 'user', content: 'reply OK' }], tools: [],
      });
      assert.equal(requests[0]?.url, 'https://example.test/v1/responses');
      assert.equal(requests[0]?.body.store, false);
      assert.equal(Object.hasOwn(requests[0]?.body ?? {}, 'previous_response_id'), false);
      assert.equal((response as { value?: { content?: string } }).value?.content, 'OK');
    } finally {
      globalThis.fetch = originalFetch;
    }

    globalThis.fetch = (async () => new Response('{}', { status: 429 })) as typeof fetch;
    try {
      await assert.rejects(new OpenAICompatibleProvider().call({
        routeId: 'route-responses', api: 'openai-responses', apiKey: 'secret',
        baseUrl: 'https://example.test/v1', model: 'model', user: 'hello',
      }), (error: unknown) => error instanceof LLMProviderError && error.failure.kind === 'rate_limit');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('keeps caller cancellation distinct from adapter timeout', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    })) as typeof fetch;

    const provider = new OpenAICompatibleProvider();
    try {
      const caller = new AbortController();
      const cancelled = provider.call({
        routeId: 'route-responses', api: 'openai-responses', apiKey: 'secret',
        baseUrl: 'https://example.test/v1', model: 'model', user: 'hello', signal: caller.signal,
      });
      caller.abort();
      await assert.rejects(cancelled, (error: unknown) => error instanceof Error && error.name === 'AbortError');

      await assert.rejects(provider.call({
        routeId: 'route-responses', api: 'openai-responses', apiKey: 'secret',
        baseUrl: 'https://example.test/v1', model: 'model', user: 'hello', timeoutMs: 1,
      }), (error: unknown) => error instanceof LLMProviderError && error.failure.kind === 'timeout');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
