import assert from 'node:assert/strict';
import test from 'node:test';

import { LLMClient } from '../../../../../../../apps/minecraft-companion/src/bot/v2/cognitive/llm/LLMClient.js';

test('F03: governed preparation freezes the exact request and dispatch provider identity', async () => {
  const originalFetch = globalThis.fetch;
  const bodies: unknown[] = [];
  globalThis.fetch = (async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 17, completion_tokens: 2, total_tokens: 19 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  try {
    const client = new LLMClient({
      routeId: 'governed-route', apiKey: 'test-key', baseUrl: 'https://example.invalid/v1', model: 'chat-model',
      toolModel: 'exact-model',
      contextProfile: {
        schema: 'mineclaw.model-context-profile-binding/v1', profileId: 'exact-model/v1',
        contextWindowTokens: 128_000, maxOutputTokens: 8_192, windowAccounting: 'input_plus_output',
        tokenizerRef: 'wire-json-utf8-upper-bound/v1', version: '1', verifiedAt: '2026-09-06T00:00:00.000Z',
      },
    }, () => {});
    const messages = [{ role: 'user' as const, content: 'original' }];
    const prepared = client.prepareGovernedToolCall({ messages, tools: [], maxTokens: 512 });
    assert.equal(client.contextProfile().kind === 'resolved' ? client.contextProfile().profile.model : null, 'exact-model');
    assert.equal(Object.isFrozen(prepared), true);
    assert.equal(Object.isFrozen(prepared.exact), true);
    assert.equal(Object.isFrozen(prepared.exact.body), true);
    assert.equal(Object.isFrozen(prepared.args.messages), true);
    messages[0].content = 'mutated-after-prepare';
    let interceptorCalls = 0;
    client.register({
      name: 'late-interceptor', matches: () => true, call: async () => null,
      callWithTools: async () => { interceptorCalls += 1; return { content: 'wrong', toolCalls: [] }; },
    });
    const result = await client.dispatchPreparedGovernedToolCall(prepared);
    assert.equal(result?.content, 'ok');
    assert.equal(result?.usage?.inputTokens, 17);
    assert.equal(interceptorCalls, 0);
    assert.match(JSON.stringify(prepared.exact.body), /original/);
    assert.doesNotMatch(JSON.stringify(prepared.exact.body), /mutated-after-prepare/);
    assert.deepEqual(bodies[0], prepared.exact.body);
    const otherClient = new LLMClient({
      apiKey: 'test-key', baseUrl: 'https://example.invalid/v1', model: 'exact-model',
      contextProfile: {
        schema: 'mineclaw.model-context-profile-binding/v1', profileId: 'exact-model/v1',
        contextWindowTokens: 128_000, maxOutputTokens: 8_192, windowAccounting: 'input_plus_output',
        tokenizerRef: 'wire-json-utf8-upper-bound/v1', version: '1', verifiedAt: '2026-09-06T00:00:00.000Z',
      },
    }, () => {});
    await assert.rejects(() => otherClient.dispatchPreparedGovernedToolCall(prepared), /does not belong/);
  } finally { globalThis.fetch = originalFetch; }
});
