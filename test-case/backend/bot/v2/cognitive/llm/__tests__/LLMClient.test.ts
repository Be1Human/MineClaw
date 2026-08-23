import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { LLMClient, type LLMClientConfig } from '../../../../../../../apps/minecraft-companion/src/bot/v2/cognitive/llm/LLMClient.js';
import type { LLMCallOptions, LLMProvider, LLMToolCallOptions } from '../../../../../../../apps/minecraft-companion/src/bot/v2/cognitive/llm/types.js';
import { failureFromHttpStatus, LLMProviderError, type LLMFailure } from '../../../../../../../apps/minecraft-companion/src/bot/v2/cognitive/llm/errors.js';

function captureProvider(models: string[]): LLMProvider {
  return {
    name: 'capture',
    matches: baseUrl => baseUrl.includes('deepseek'),
    call: async (_opts: LLMCallOptions) => 'ok',
    callWithTools: async (opts: LLMToolCallOptions) => {
      models.push(opts.model);
      return { toolCalls: [], content: 'ok' };
    },
  };
}

async function invoke(config: LLMClientConfig): Promise<string[]> {
  const models: string[] = [];
  const client = new LLMClient(config, () => {});
  client.register(captureProvider(models));
  await client.callWithTools({ messages: [{ role: 'user', content: 'test' }], tools: [] });
  return models;
}

describe('BUG-CROSS-10 · 工具调用模型路由', () => {
  it('未配置 toolModel 时原样使用配置模型', async () => {
    const models = await invoke({
      apiKey: 'test-key',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-flash',
    });
    assert.deepEqual(models, ['deepseek-v4-flash']);
  });

  it('显式 toolModel 才覆盖普通模型', async () => {
    const models = await invoke({
      apiKey: 'test-key',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-flash',
      toolModel: 'deepseek-tool-special',
    });
    assert.deepEqual(models, ['deepseek-tool-special']);
  });
});

describe('BUG-CROSS-43 · Provider 失败按调用传播', () => {
  it('HTTP 状态映射不依赖响应体', () => {
    assert.equal(failureFromHttpStatus(401).kind, 'auth');
    assert.equal(failureFromHttpStatus(402).kind, 'billing');
    assert.equal(failureFromHttpStatus(429).kind, 'rate_limit');
    assert.equal(failureFromHttpStatus(504).kind, 'timeout');
    assert.equal(failureFromHttpStatus(503).kind, 'unavailable');
    assert.equal(failureFromHttpStatus(400).kind, 'bad_request');
  });

  it('结构化错误通过本轮 onError 传递并保持 null 兼容返回', async () => {
    const failures: LLMFailure[] = [];
    const client = new LLMClient({
      apiKey: 'test-key',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-chat',
    }, () => {});
    client.register({
      name: 'billing-failure',
      matches: baseUrl => baseUrl.includes('deepseek'),
      call: async () => null,
      callWithTools: async () => { throw new LLMProviderError({ kind: 'billing', status: 402 }); },
    });

    const result = await client.callWithTools({
      messages: [{ role: 'user', content: 'test' }],
      tools: [],
      onError: failure => failures.push(failure),
    });

    assert.equal(result, null);
    assert.deepEqual(failures, [{ kind: 'billing', status: 402 }]);
  });
});
