import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { ModelContextProfileV1 } from '../../../../../../../apps/minecraft-companion/src/llm/modelContextProfile.js';
import { ChatCompletionsCodec } from '../../../../../../../apps/minecraft-companion/src/bot/v2/cognitive/llm/chatCompletionsCodec.js';
import { ResponsesCodec } from '../../../../../../../apps/minecraft-companion/src/bot/v2/cognitive/llm/responsesCodec.js';
import {
  RequestTokenMeter,
  Utf8JsonWireUpperBoundTokenizer,
  type WireRequestTokenizer,
} from '../../../../../../../apps/minecraft-companion/src/bot/v2/cognitive/llm/requestTokenMeter.js';
import type { CanonicalLlmCall } from '../../../../../../../apps/minecraft-companion/src/bot/v2/cognitive/llm/types.js';

const route = { routeId: 'route-meter', model: 'deepseek-v4-flash', baseUrl: 'https://api.deepseek.com/v1' };
const profile: ModelContextProfileV1 = {
  schema: 'mineclaw.model-context-profile/v1',
  profileId: 'deepseek-v4-flash-1m',
  routeId: route.routeId,
  model: route.model,
  api: 'openai-completions',
  contextWindowTokens: 1_048_576,
  maxOutputTokens: 393_216,
  windowAccounting: 'input_plus_output',
  tokenizerRef: 'wire-json-utf8-upper-bound/v1',
  source: { kind: 'builtin_catalog', version: 'test', verifiedAt: '2026-09-06T00:00:00.000Z' },
};

const basicCall = (text = '你好，帮我整理工具结果'): CanonicalLlmCall => ({
  messages: [
    { role: 'system', content: [{ kind: 'text', text: 'You are a Minecraft agent.' }] },
    { role: 'user', content: [{ kind: 'text', text }] },
  ],
  tools: [],
  maxTokens: 512,
});

describe('FEAT-CROSS-29 · exact wire request Token Meter', () => {
  it('TM-01 meters the Chat exact body including Unicode and protocol fields', () => {
    const exact = new ChatCompletionsCodec().buildRequest(basicCall(), route);
    const result = new RequestTokenMeter().measure({ profile, request: exact });
    assert.equal(result.kind, 'measured');
    if (result.kind === 'measured') {
      assert.equal(result.measure.precision, 'conservative_upper_bound');
      const bytes = Buffer.byteLength(JSON.stringify(exact.body), 'utf8');
      assert.equal(result.measure.tokens, Math.ceil(bytes / 4));
      assert.equal(result.measure.upperBoundTokens, bytes + 256);
    }
  });

  it('TM-02 includes tool descriptions, JSON Schema and tool choice', () => {
    const codec = new ChatCompletionsCodec();
    const withoutTools = codec.buildRequest(basicCall('dig'), route);
    const withTools = codec.buildRequest({
      ...basicCall('dig'),
      tools: [{
        name: 'dig_block',
        description: 'Dig one selected Minecraft block and report the observed outcome.',
        parameters: { type: 'object', properties: { block: { type: 'string' } }, required: ['block'] },
      }],
      toolChoice: 'auto',
    }, route);
    const meter = new RequestTokenMeter();
    const small = meter.measure({ profile, request: withoutTools });
    const large = meter.measure({ profile, request: withTools });
    assert.equal(small.kind, 'measured');
    assert.equal(large.kind, 'measured');
    if (small.kind === 'measured' && large.kind === 'measured') {
      assert.ok(large.measure.upperBoundTokens > small.measure.upperBoundTokens);
    }
  });

  it('TM-03 measures Responses native replay and encrypted reasoning metadata', () => {
    const call: CanonicalLlmCall = {
      ...basicCall('continue'),
      messages: [
        basicCall().messages[0]!,
        {
          role: 'assistant',
          content: [{ kind: 'reasoning', text: '' }],
          source: {
            providerRoute: route.routeId,
            model: route.model,
            replay: {
              kind: 'openai-native', version: 1, api: 'openai-responses',
              providerRoute: route.routeId, model: route.model,
              blocks: [{ type: 'reasoning', id: 'r1', status: 'completed', encrypted_content: 'encrypted-fixture', summary: [] }],
            },
          },
        },
        { role: 'user', content: [{ kind: 'text', text: 'continue' }] },
      ],
    };
    const exact = new ResponsesCodec().buildRequest(call, route);
    const result = new RequestTokenMeter().measure({
      profile: { ...profile, api: 'openai-responses' },
      request: exact,
    });
    assert.equal(result.kind, 'measured');
    assert.match(JSON.stringify(exact.body), /encrypted-fixture/);
  });

  it('TM-04 reports independently measured section requests without claiming additivity', () => {
    const codec = new ChatCompletionsCodec();
    const system = codec.buildRequest({ messages: [basicCall().messages[0]!], tools: [] }, route);
    const instruction = codec.buildRequest({ messages: [basicCall().messages[1]!], tools: [] }, route);
    const result = new RequestTokenMeter().measure({
      profile,
      request: codec.buildRequest(basicCall(), route),
      sectionRequests: [
        { sectionId: 'system', request: system },
        { sectionId: 'instruction', request: instruction },
      ],
    });
    assert.equal(result.kind, 'measured');
    if (result.kind === 'measured') {
      assert.deepEqual(result.measure.sectionTokens.map(item => item.sectionId), ['system', 'instruction']);
      assert.ok(result.measure.sectionTokens.every(item => item.tokens > 0));
    }
  });

  it('TM-05 returns unavailable for an unregistered tokenizer instead of zero', () => {
    const exact = new ChatCompletionsCodec().buildRequest(basicCall(), route);
    const result = new RequestTokenMeter([]).measure({
      profile: { ...profile, tokenizerRef: 'missing/v1' },
      request: exact,
    });
    assert.deepEqual(result, {
      kind: 'unavailable', tokenizerRef: 'missing/v1', reason: 'tokenizer_not_registered',
      detail: 'no request token meter registered for missing/v1',
    });
  });

  it('TM-06 accepts a second exact tokenizer through registration without core branching', () => {
    const exactTokenizer: WireRequestTokenizer = {
      tokenizerRef: 'fixture-exact/v1',
      measure: request => {
        const count = JSON.stringify(request.body).split(/\s+/u).length;
        return { tokens: count, upperBoundTokens: count, precision: 'exact' };
      },
    };
    const meter = new RequestTokenMeter([new Utf8JsonWireUpperBoundTokenizer()]);
    meter.register(exactTokenizer);
    const result = meter.measure({
      profile: { ...profile, tokenizerRef: exactTokenizer.tokenizerRef },
      request: new ChatCompletionsCodec().buildRequest(basicCall(), route),
    });
    assert.equal(result.kind, 'measured');
    if (result.kind === 'measured') assert.equal(result.measure.precision, 'exact');
  });

  it('TM-07 rejects invalid meter results and duplicate registrations', () => {
    const invalid: WireRequestTokenizer = {
      tokenizerRef: 'invalid/v1',
      measure: () => ({ tokens: 10, upperBoundTokens: 9, precision: 'conservative_upper_bound' }),
    };
    const meter = new RequestTokenMeter([invalid]);
    const result = meter.measure({
      profile: { ...profile, tokenizerRef: invalid.tokenizerRef },
      request: { path: '/test', body: {} },
    });
    assert.equal(result.kind, 'unavailable');
    if (result.kind === 'unavailable') assert.equal(result.reason, 'invalid_measurement');
    assert.throws(() => meter.register(invalid), /tokenizer_already_registered/);
  });

  it('TM-08 fuses a tokenizer when controlled Provider usage exceeds its bound', () => {
    const meter = new RequestTokenMeter();
    const exact = new ChatCompletionsCodec().buildRequest(basicCall(), route);
    const result = meter.measure({ profile, request: exact });
    assert.equal(result.kind, 'measured');
    if (result.kind !== 'measured') return;

    const reconciliation = meter.reconcile(result.measure, result.measure.upperBoundTokens + 1);
    assert.equal(reconciliation.kind, 'underestimated');
    const next = meter.measure({ profile, request: exact });
    assert.equal(next.kind, 'unavailable');
    if (next.kind === 'unavailable') assert.equal(next.reason, 'meter_fused_after_underestimate');
  });
});
