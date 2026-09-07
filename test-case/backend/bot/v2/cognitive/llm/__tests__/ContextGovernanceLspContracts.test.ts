import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  MODEL_CONTEXT_PROFILE_BINDING_SCHEMA,
  ModelContextProfileResolver,
  type ModelContextProfileBindingV1,
  type ModelContextProfileResolution,
  type ModelContextProfileSource,
} from '../../../../../../../apps/minecraft-companion/src/llm/modelContextProfile.js';
import {
  RequestTokenMeter,
  Utf8JsonWireUpperBoundTokenizer,
  type TokenMeasureResult,
  type WireRequestTokenizer,
} from '../../../../../../../apps/minecraft-companion/src/bot/v2/cognitive/llm/requestTokenMeter.js';
import type { ExactModelRequest } from '../../../../../../../apps/minecraft-companion/src/bot/v2/cognitive/llm/apiCodec.js';

const binding: ModelContextProfileBindingV1 = {
  schema: MODEL_CONTEXT_PROFILE_BINDING_SCHEMA,
  profileId: 'lsp-profile',
  contextWindowTokens: 131_072,
  maxOutputTokens: 8_192,
  windowAccounting: 'input_plus_output',
  tokenizerRef: 'lsp-tokenizer',
  version: 'lsp-v1',
  verifiedAt: '2026-09-06T00:00:00.000Z',
};

const route = {
  routeId: 'lsp-route', adapterId: 'openai-http', api: 'openai-completions' as const,
  baseUrl: 'https://lsp.example/v1', model: 'lsp-model',
};

function assertResolvedContract(result: ModelContextProfileResolution): void {
  assert.equal(result.kind, 'resolved');
  if (result.kind !== 'resolved') return;
  assert.equal(result.profile.routeId, route.routeId);
  assert.equal(result.profile.model, route.model);
  assert.ok(result.profile.contextWindowTokens > 0);
  assert.ok(result.profile.maxOutputTokens <= result.profile.contextWindowTokens);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.profile));
}

function assertMeasuredContract(result: TokenMeasureResult): void {
  assert.equal(result.kind, 'measured');
  if (result.kind !== 'measured') return;
  assert.ok(result.measure.tokens >= 0);
  assert.ok(result.measure.upperBoundTokens >= result.measure.tokens);
  if (result.measure.precision === 'exact') {
    assert.equal(result.measure.tokens, result.measure.upperBoundTokens);
  }
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.measure));
}

describe('FEAT-CROSS-29 · shared LSP contracts', () => {
  it('LS-01 substitutes explicit, catalog and discovery profile resolution', () => {
    const missCatalog: ModelContextProfileSource = { kind: 'builtin_catalog', resolve: () => ({ kind: 'miss' }) };
    const matchCatalog: ModelContextProfileSource = {
      kind: 'builtin_catalog', resolve: () => ({ kind: 'match', binding }),
    };
    const discovery: ModelContextProfileSource = {
      kind: 'provider_discovery', resolve: () => ({ kind: 'match', binding }),
    };
    const variants = [
      () => new ModelContextProfileResolver(missCatalog).resolve(route, binding),
      () => new ModelContextProfileResolver(matchCatalog).resolve(route),
      () => new ModelContextProfileResolver(missCatalog, [discovery]).resolve(route),
    ];
    for (const resolve of variants) assertResolvedContract(resolve());
  });

  it('LS-02 turns source exceptions into the shared unresolved contract', () => {
    const throwing: ModelContextProfileSource = {
      kind: 'builtin_catalog',
      resolve: () => { throw new Error('source offline'); },
    };
    const result = new ModelContextProfileResolver(throwing).resolve(route);
    assert.equal(result.kind, 'unresolved');
    if (result.kind === 'unresolved') {
      assert.equal(result.reason, 'source_unavailable');
      assert.match(result.detail, /source offline/);
    }
  });

  it('LS-05 substitutes exact and conservative Token Meter implementations', () => {
    const exactTokenizer: WireRequestTokenizer = {
      tokenizerRef: 'exact-fixture/v1',
      measure: request => {
        const tokens = Buffer.byteLength(JSON.stringify(request.body), 'utf8');
        return { tokens, upperBoundTokens: tokens, precision: 'exact' };
      },
    };
    const exactRequest: ExactModelRequest = { path: '/test', body: { messages: [{ role: 'user', content: 'hello' }] } };
    const variants = [
      { tokenizer: new Utf8JsonWireUpperBoundTokenizer(), ref: 'wire-json-utf8-upper-bound/v1' },
      { tokenizer: exactTokenizer, ref: exactTokenizer.tokenizerRef },
    ];
    for (const variant of variants) {
      const meter = new RequestTokenMeter([variant.tokenizer]);
      assertMeasuredContract(meter.measure({
        profile: {
          schema: 'mineclaw.model-context-profile/v1', profileId: 'lsp', routeId: route.routeId,
          model: route.model, api: route.api, contextWindowTokens: 131_072, maxOutputTokens: 8_192,
          windowAccounting: 'input_plus_output', tokenizerRef: variant.ref,
          source: { kind: 'explicit_config', version: 'lsp-v1', verifiedAt: '2026-09-06T00:00:00.000Z' },
        },
        request: exactRequest,
      }));
    }
  });

  it('LS-06 keeps failure and reconciliation side effects inside the meter registry', () => {
    const meter = new RequestTokenMeter();
    const input = {
      profile: {
        schema: 'mineclaw.model-context-profile/v1' as const, profileId: 'lsp', routeId: route.routeId,
        model: route.model, api: route.api, contextWindowTokens: 131_072, maxOutputTokens: 8_192,
        windowAccounting: 'input_plus_output' as const, tokenizerRef: 'wire-json-utf8-upper-bound/v1',
        source: { kind: 'explicit_config' as const, version: 'lsp-v1', verifiedAt: '2026-09-06T00:00:00.000Z' },
      },
      request: { path: '/test', body: { input: 'hello' } },
    };
    const measured = meter.measure(input);
    assertMeasuredContract(measured);
    if (measured.kind !== 'measured') return;

    const under = meter.reconcile(measured.measure, measured.measure.upperBoundTokens + 1);
    assert.equal(under.kind, 'underestimated');
    const after = meter.measure(input);
    assert.equal(after.kind, 'unavailable');

    const independent = new RequestTokenMeter().measure(input);
    assert.equal(independent.kind, 'measured');
  });
});
