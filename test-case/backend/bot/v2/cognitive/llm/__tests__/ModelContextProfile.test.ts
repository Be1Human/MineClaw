import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  MODEL_CONTEXT_PROFILE_BINDING_SCHEMA,
  BuiltinModelContextProfileCatalog,
  ModelContextProfileResolver,
  type ModelContextProfileBindingV1,
  type ModelContextProfileSource,
  type ModelContextRouteIdentity,
} from '../../../../../../../apps/minecraft-companion/src/llm/modelContextProfile.js';
import { prepareLlmRoute } from '../../../../../../../apps/minecraft-companion/src/bot/v2/cognitive/llm/LLMClient.js';

const route = (model: string, api: ModelContextRouteIdentity['api'] = 'openai-completions'): ModelContextRouteIdentity => ({
  routeId: 'route-test',
  adapterId: 'openai-http',
  api,
  baseUrl: 'https://api.deepseek.com/v1',
  model,
});

const binding = (profileId: string, contextWindowTokens: number): ModelContextProfileBindingV1 => ({
  schema: MODEL_CONTEXT_PROFILE_BINDING_SCHEMA,
  profileId,
  contextWindowTokens,
  maxOutputTokens: Math.min(8_192, contextWindowTokens),
  windowAccounting: 'input_plus_output',
  tokenizerRef: `tokenizer/${profileId}`,
  version: 'test-v1',
  verifiedAt: '2026-09-06T00:00:00.000Z',
});

describe('FEAT-CROSS-29 · model context profile resolution', () => {
  it('MP-01 resolves explicit 64K and 128K bindings before other sources', () => {
    let catalogCalls = 0;
    const catalog: ModelContextProfileSource = {
      kind: 'builtin_catalog',
      resolve: () => { catalogCalls += 1; return { kind: 'match', binding: binding('catalog', 1_048_576) }; },
    };
    const resolver = new ModelContextProfileResolver(catalog);

    for (const size of [65_536, 131_072]) {
      const result = resolver.resolve(route(`explicit-${size}`), binding(`explicit-${size}`, size));
      assert.equal(result.kind, 'resolved');
      if (result.kind === 'resolved') {
        assert.equal(result.profile.contextWindowTokens, size);
        assert.equal(result.profile.source.kind, 'explicit_config');
      }
    }
    assert.equal(catalogCalls, 0);
  });

  it('MP-02 resolves the exact builtin DeepSeek V4 identity as 1M', () => {
    const result = new ModelContextProfileResolver().resolve(route('deepseek-v4-flash'));
    assert.equal(result.kind, 'resolved');
    if (result.kind === 'resolved') {
      assert.equal(result.profile.contextWindowTokens, 1_048_576);
      assert.equal(result.profile.maxOutputTokens, 393_216);
      assert.equal(result.profile.source.kind, 'builtin_catalog');
    }
  });

  it('MP-03 does not infer capacity from model-name substrings or another origin', () => {
    const resolver = new ModelContextProfileResolver();
    assert.equal(resolver.resolve(route('prefix-deepseek-v4-flash')).kind, 'unresolved');
    assert.equal(resolver.resolve({ ...route('deepseek-v4-flash'), baseUrl: 'https://relay.example/v1' }).kind, 'unresolved');
  });

  it('MP-04 reports retired aliases with an explicit replacement instead of guessing', () => {
    const result = new ModelContextProfileResolver().resolve(route('deepseek-chat'));
    assert.deepEqual(result, {
      kind: 'unresolved',
      reason: 'retired_model_alias',
      routeId: 'route-test',
      model: 'deepseek-chat',
      detail: 'deepseek-chat is a retired alias; select and verify an active model id before enabling governed calls',
      replacementModel: 'deepseek-v4-flash',
    });
  });

  it('MP-05 consults provider discovery only after an exact catalog miss', () => {
    const discovery: ModelContextProfileSource = {
      kind: 'provider_discovery',
      resolve: candidate => candidate.model === 'provider-model'
        ? { kind: 'match', binding: binding('provider-128k', 131_072) }
        : { kind: 'miss' },
    };
    const result = new ModelContextProfileResolver(new BuiltinModelContextProfileCatalog(), [discovery])
      .resolve(route('provider-model'));
    assert.equal(result.kind, 'resolved');
    if (result.kind === 'resolved') assert.equal(result.profile.source.kind, 'provider_discovery');
  });

  it('MP-06 fails closed for invalid explicit profiles and unknown routes', () => {
    const resolver = new ModelContextProfileResolver();
    const invalid = { ...binding('invalid', 65_536), maxOutputTokens: 70_000 };
    const invalidResult = resolver.resolve(route('deepseek-v4-flash'), invalid);
    assert.equal(invalidResult.kind, 'unresolved');
    if (invalidResult.kind === 'unresolved') assert.equal(invalidResult.reason, 'invalid_explicit_profile');

    const unknown = resolver.resolve(route('unknown-model'));
    assert.equal(unknown.kind, 'unresolved');
    if (unknown.kind === 'unresolved') assert.equal(unknown.reason, 'profile_not_found');
  });

  it('MP-07 freezes the resolved profile with the route snapshot', () => {
    const explicit = binding('frozen-64k', 65_536);
    const prepared = prepareLlmRoute({
      routeId: 'route-frozen',
      apiKey: 'key',
      baseUrl: 'https://relay.example/v1',
      model: 'relay-model',
      contextProfile: explicit,
    });
    explicit.contextWindowTokens = 1;

    assert.equal(prepared.contextProfile.kind, 'resolved');
    if (prepared.contextProfile.kind === 'resolved') {
      assert.equal(prepared.contextProfile.profile.contextWindowTokens, 65_536);
      assert.equal(prepared.contextProfile.profile.routeId, 'route-frozen');
      assert.ok(Object.isFrozen(prepared.contextProfile.profile));
      assert.ok(Object.isFrozen(prepared.contextProfile.profile.source));
    }
  });
});
