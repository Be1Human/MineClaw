import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveProfileLlmConfig } from '../../../../apps/minecraft-companion/src/hub/llmConfig.js';
import { LlmAgentConfigStore } from '../../../../apps/minecraft-companion/src/hub/llmAgentConfigStore.js';
import {
  MODEL_CONTEXT_PROFILE_BINDING_SCHEMA,
  type ModelContextProfileBindingV1,
} from '../../../../apps/minecraft-companion/src/llm/modelContextProfile.js';

const contextProfile: ModelContextProfileBindingV1 = {
  schema: MODEL_CONTEXT_PROFILE_BINDING_SCHEMA,
  profileId: 'relay-model-128k',
  contextWindowTokens: 131_072,
  maxOutputTokens: 16_384,
  windowAccounting: 'input_plus_output',
  tokenizerRef: 'relay-tokenizer/v1',
  version: 'operator-verified-v1',
  verifiedAt: '2026-09-06T00:00:00.000Z',
};

describe('FEAT-CROSS-29 · Hub model context profile ownership', () => {
  it('keeps endpoint identity and explicit physical profile in the same configuration layer', () => {
    const fallback = {
      apiKey: 'fallback-key', baseUrl: 'https://fallback.example/v1', model: 'fallback-model', contextProfile,
    };
    const resolved = resolveProfileLlmConfig(undefined, fallback);
    assert.deepEqual(resolved.contextProfile, contextProfile);
    assert.notEqual(resolved.contextProfile, contextProfile);

    const endpointOverride = resolveProfileLlmConfig(fallback, fallback, {
      baseUrl: 'https://other.example/v1', model: 'other-model',
    });
    assert.equal(endpointOverride.contextProfile, undefined);
  });

  it('persists, clones, updates, clears and safely projects an explicit profile', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mineclaw-context-profile-'));
    try {
      const store = new LlmAgentConfigStore(dir);
      const mutableInput = { ...contextProfile };
      const created = store.create({
        name: 'Profiled route', baseUrl: 'https://relay.example/v1', model: 'relay-model', contextProfile: mutableInput,
      });
      mutableInput.contextWindowTokens = 1;
      assert.equal(created.contextProfile?.contextWindowTokens, 131_072);
      assert.equal(store.toPublic(created, 0).contextProfile?.contextWindowTokens, 131_072);

      const reloaded = new LlmAgentConfigStore(dir);
      assert.equal(reloaded.get(created.id)?.contextProfile?.profileId, 'relay-model-128k');
      assert.equal(reloaded.update(created.id, { clearContextProfile: true })?.contextProfile, undefined);
      assert.equal(new LlmAgentConfigStore(dir).get(created.id)?.contextProfile, undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects malformed physical limits at the store boundary', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mineclaw-context-profile-invalid-'));
    try {
      const store = new LlmAgentConfigStore(dir);
      assert.throws(() => store.create({
        name: 'Invalid route', baseUrl: 'https://relay.example/v1', model: 'relay-model',
        contextProfile: { ...contextProfile, contextWindowTokens: 0 },
      }), /invalid_model_context_profile/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
