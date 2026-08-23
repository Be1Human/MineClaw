import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeOpenAICompatibleUsage,
} from '../../../../../../../apps/minecraft-companion/src/bot/v2/cognitive/llm/usage.js';

test('归一化 prompt_tokens_details.cached_tokens 并保留真实 0% 命中', () => {
  assert.deepEqual(normalizeOpenAICompatibleUsage({
    prompt_tokens: 100,
    completion_tokens: 25,
    total_tokens: 125,
    prompt_tokens_details: { cached_tokens: 80 },
  }), {
    inputTokens: 100,
    outputTokens: 25,
    totalTokens: 125,
    cachedInputTokens: 80,
    cacheMissInputTokens: 20,
    cacheEligibleInputTokens: 100,
    cacheStatus: 'reported',
    source: 'prompt_tokens_details.cached_tokens',
  });

  const zero = normalizeOpenAICompatibleUsage({
    prompt_tokens: 100,
    prompt_tokens_details: { cached_tokens: 0 },
  });
  assert.equal(zero.cacheStatus, 'reported');
  assert.equal(zero.cachedInputTokens, 0);
});

test('归一化 prompt cache hit/miss 字段族', () => {
  assert.deepEqual(normalizeOpenAICompatibleUsage({
    prompt_tokens: 100,
    completion_tokens: 12,
    prompt_cache_hit_tokens: 80,
    prompt_cache_miss_tokens: 20,
  }), {
    inputTokens: 100,
    outputTokens: 12,
    cachedInputTokens: 80,
    cacheMissInputTokens: 20,
    cacheEligibleInputTokens: 100,
    cacheStatus: 'reported',
    source: 'prompt_cache_hit_tokens+prompt_cache_miss_tokens',
  });
});

test('Provider 未提供缓存字段时返回 unsupported 而不是 0%', () => {
  assert.deepEqual(normalizeOpenAICompatibleUsage({
    prompt_tokens: 100,
    completion_tokens: 12,
    total_tokens: 112,
  }), {
    inputTokens: 100,
    outputTokens: 12,
    totalTokens: 112,
    cacheStatus: 'unsupported',
    source: 'usage_without_cache_details',
  });
  assert.deepEqual(normalizeOpenAICompatibleUsage(undefined), {
    cacheStatus: 'unsupported',
    source: 'usage_not_reported',
  });
});

test('矛盾、负数、小数和不完整缓存字段均明确 unavailable', () => {
  const cases = [
    { prompt_tokens: 99, prompt_cache_hit_tokens: 80, prompt_cache_miss_tokens: 20 },
    { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 101 } },
    { prompt_tokens: -1, prompt_tokens_details: { cached_tokens: 0 } },
    { prompt_tokens: 100.5, prompt_tokens_details: { cached_tokens: 0 } },
    { prompt_tokens: 100, prompt_cache_hit_tokens: 80 },
  ];
  for (const value of cases) {
    assert.equal(normalizeOpenAICompatibleUsage(value).cacheStatus, 'unavailable');
  }
});
