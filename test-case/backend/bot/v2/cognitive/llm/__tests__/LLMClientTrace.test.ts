import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  LLMClient,
  type LLMClientConfig,
} from '../../../../../../../apps/minecraft-companion/src/bot/v2/cognitive/llm/LLMClient.js';
import { LLMProviderError } from '../../../../../../../apps/minecraft-companion/src/bot/v2/cognitive/llm/errors.js';
import type {
  LLMCallOptions,
  LLMProvider,
  LLMToolCallOptions,
} from '../../../../../../../apps/minecraft-companion/src/bot/v2/cognitive/llm/types.js';
import type {
  LlmTraceEventInputV1,
  LlmTraceRecorderPort,
} from '../../../../../../../apps/minecraft-companion/src/bot/v2/infra/llmTrace/index.js';
import { LlmTraceEventStore } from '../../../../../../../apps/minecraft-companion/src/bot/v2/infra/llmTrace/index.js';

const config: LLMClientConfig = {
  apiKey: 'SECRET_API_KEY_CANARY',
  baseUrl: 'https://api.deepseek.com/v1?token=SECRET_URL_CANARY',
  model: 'deepseek-v4-flash',
};

class Recorder implements LlmTraceRecorderPort {
  readonly events: LlmTraceEventInputV1[] = [];
  failRequest = false;
  failTerminalOnce = false;

  append(input: LlmTraceEventInputV1): never | any {
    if (this.failRequest && input.type === 'llm.request.recorded') {
      throw new Error('request append unavailable SECRET_STORAGE_CANARY');
    }
    if (this.failTerminalOnce && input.type === 'llm.response.recorded') {
      this.failTerminalOnce = false;
      throw new Error('terminal append unavailable');
    }
    this.events.push(structuredClone(input));
    return {
      schema: 'mineclaw.llm-trace-event/v1',
      eventId: `event-${this.events.length}`,
      profileId: 'profile-a',
      seq: this.events.length,
      ...structuredClone(input),
    };
  }
}

function provider(overrides: Partial<LLMProvider> = {}): LLMProvider {
  return {
    name: 'trace-spy',
    matches: baseUrl => baseUrl.includes('deepseek'),
    call: async () => 'plain response',
    callWithTools: async () => ({ toolCalls: [], content: 'tool response' }),
    ...overrides,
  };
}

const reportedUsage = {
  inputTokens: 100,
  outputTokens: 20,
  totalTokens: 120,
  cachedInputTokens: 80,
  cacheMissInputTokens: 20,
  cacheEligibleInputTokens: 100,
  cacheStatus: 'reported' as const,
  source: 'prompt_tokens_details.cached_tokens',
};

test('ordinary and tool responses persist normalized usage without changing business values', async () => {
  const recorder = new Recorder();
  let callId = 0;
  const client = new LLMClient(config, () => {}, {
    traceRecorder: recorder,
    createId: () => `call-usage-${++callId}`,
  });
  client.register(provider({
    call: async () => ({ value: 'plain response', usage: reportedUsage, finishReason: 'stop' }),
    callWithTools: async () => ({
      value: { toolCalls: [], content: 'tool response' },
      usage: reportedUsage,
      finishReason: 'tool_calls',
    }),
  }));

  assert.equal(await client.call('hi'), 'plain response');
  assert.equal((await client.callWithTools({ messages: [], tools: [] }))?.content, 'tool response');
  const responses = recorder.events.filter(event => event.type === 'llm.response.recorded');
  assert.equal(responses.length, 2);
  assert.deepEqual(responses.map(event => event.payload.usage), [reportedUsage, reportedUsage]);
  assert.deepEqual(responses.map(event => event.payload.finishReason), ['stop', 'tool_calls']);
});

test('ordinary call records exact model-visible input before provider and never persists credentials', async () => {
  const recorder = new Recorder();
  let providerSawRequest = false;
  let received: LLMCallOptions | undefined;
  const client = new LLMClient(config, () => {}, {
    traceRecorder: recorder,
    createId: () => 'call-plain',
    now: () => new Date('2026-08-22T04:20:00.000Z'),
  });
  client.register(provider({
    call: async options => {
      received = options;
      providerSawRequest = recorder.events[0]?.type === 'llm.request.recorded';
      return 'plain response';
    },
  }));

  const result = await client.call('你好', '你是蓝一', {
    agent: 'mainbrain',
    interactionSessionId: 'interaction-1',
    turn: 3,
    contextSources: {
      selected: [{ kind: 'character', ref: 'character:blue-one', messageIndexes: [0] }],
      omitted: [{ kind: 'memory', ref: 'memory:old', reason: 'budget' }],
    },
  });

  assert.equal(result, 'plain response');
  assert.equal(providerSawRequest, true);
  assert.equal(received?.apiKey, config.apiKey);
  assert.deepEqual(recorder.events.map(event => event.type), [
    'llm.request.recorded',
    'llm.response.recorded',
  ]);
  const request = recorder.events[0]!.payload.request as Record<string, unknown>;
  assert.deepEqual(request.messages, [
    { role: 'system', content: '你是蓝一' },
    { role: 'user', content: '你好' },
  ]);
  assert.equal(request.baseUrlOrigin, 'https://api.deepseek.com');
  assert.equal(recorder.events[0]!.agent, 'mainbrain');
  assert.equal(recorder.events[0]!.turn, 3);
  const serialized = JSON.stringify(recorder.events);
  assert.equal(serialized.includes('SECRET_API_KEY_CANARY'), false);
  assert.equal(serialized.includes('SECRET_URL_CANARY'), false);
});

test('callWithTools snapshot matches provider model payload and request append failure blocks dispatch', async () => {
  const recorder = new Recorder();
  let received: LLMToolCallOptions | undefined;
  let providerCalls = 0;
  const client = new LLMClient(config, () => {}, {
    traceRecorder: recorder,
    createId: () => 'call-tools',
  });
  client.register(provider({
    callWithTools: async options => {
      providerCalls += 1;
      received = options;
      return { toolCalls: [{ id: 'tool-1', name: 'submit_goal_request', arguments: { text: '石头' } }], content: '' };
    },
  }));
  const messages = [{ role: 'user' as const, content: '给我一块石头' }];
  const tools = [{
    type: 'function' as const,
    function: {
      name: 'submit_goal_request',
      description: '委托任务',
      parameters: { type: 'object' as const, properties: { text: { type: 'string' } }, required: ['text'] },
    },
  }];

  await client.callWithTools({
    messages,
    tools,
    toolChoice: { type: 'function', function: { name: 'submit_goal_request' } },
    temperature: 0.2,
    maxTokens: 300,
    timeoutMs: 1_234,
    traceContext: { agent: 'mainbrain', callId: 'call-tools' },
  });
  const request = recorder.events[0]!.payload.request as Record<string, unknown>;
  assert.deepEqual(request.messages, received?.messages);
  assert.deepEqual(request.tools, received?.tools);
  assert.deepEqual(request.toolChoice, received?.toolChoice);
  assert.equal(request.temperature, received?.temperature);
  assert.equal(request.maxTokens, received?.maxTokens);
  assert.equal(request.timeoutMs, received?.timeoutMs);

  const blockedRecorder = new Recorder();
  blockedRecorder.failRequest = true;
  const failures: string[] = [];
  const blocked = new LLMClient(config, () => {}, { traceRecorder: blockedRecorder });
  blocked.register(provider({
    callWithTools: async () => {
      providerCalls += 1;
      return { toolCalls: [], content: 'must not run' };
    },
  }));
  assert.equal(await blocked.callWithTools({
    messages,
    tools,
    onError: failure => failures.push(failure.kind),
  }), null);
  assert.equal(providerCalls, 1);
  assert.deepEqual(failures, ['trace_unavailable']);
});

test('Responses records the exact endpoint and body before dispatch', async () => {
  const recorder = new Recorder();
  const originalFetch = globalThis.fetch;
  let dispatchedUrl = '';
  let dispatchedBody: unknown;
  let requestWasDurable = false;
  globalThis.fetch = (async (input, init) => {
    dispatchedUrl = String(input);
    dispatchedBody = JSON.parse(String(init?.body));
    requestWasDurable = recorder.events[0]?.type === 'llm.request.recorded';
    return new Response(JSON.stringify({
      id: 'resp_trace',
      status: 'completed',
      output: [{
        id: 'msg_trace',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: '完成', annotations: [] }],
      }],
      usage: {
        input_tokens: 12,
        output_tokens: 3,
        total_tokens: 15,
        input_tokens_details: { cached_tokens: 8 },
        output_tokens_details: { reasoning_tokens: 2 },
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  try {
    const client = new LLMClient({
      apiKey: 'RESPONSES_SECRET_CANARY',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-5.4',
      api: 'openai-responses',
      routeId: 'openai-primary',
    }, () => {}, { traceRecorder: recorder, createId: () => 'call-responses-trace' });

    const result = await client.callWithTools({
      messages: [{ role: 'user', content: '给我一块石头' }],
      tools: [],
      maxTokens: 321,
    });

    const request = recorder.events[0]!.payload.request as Record<string, any>;
    assert.equal(result?.content, '完成');
    assert.equal(requestWasDurable, true);
    assert.equal(dispatchedUrl, 'https://api.openai.com/v1/responses');
    assert.equal(request.api, 'openai-responses');
    assert.equal(request.routeId, 'openai-primary');
    assert.equal(request.path, '/responses');
    assert.deepEqual(request.body, dispatchedBody);
    assert.deepEqual(request.body.input, [
      { role: 'user', content: [{ type: 'input_text', text: '给我一块石头' }] },
    ]);
    assert.equal(request.body.store, false);
    assert.equal(request.body.max_output_tokens, 321);
    assert.equal(JSON.stringify(recorder.events).includes('RESPONSES_SECRET_CANARY'), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('provider failure and caller abort close the already-recorded request with distinct events', async () => {
  const failureRecorder = new Recorder();
  const failed = new LLMClient(config, () => {}, {
    traceRecorder: failureRecorder,
    createId: () => 'call-timeout',
  });
  failed.register(provider({
    callWithTools: async () => { throw new LLMProviderError({ kind: 'timeout' }); },
  }));
  await failed.callWithTools({ messages: [], tools: [] });
  assert.deepEqual(failureRecorder.events.map(event => event.type), [
    'llm.request.recorded',
    'llm.call.failed',
  ]);
  assert.equal(failureRecorder.events[1]!.payload.failure, 'timeout');

  const abortRecorder = new Recorder();
  const controller = new AbortController();
  controller.abort();
  const aborted = new LLMClient(config, () => {}, {
    traceRecorder: abortRecorder,
    createId: () => 'call-abort',
  });
  aborted.register(provider({
    callWithTools: async () => { throw new DOMException('aborted', 'AbortError'); },
  }));
  await aborted.callWithTools({
    messages: [],
    tools: [],
    signal: controller.signal,
    traceContext: { abortReason: 'new_owner_message' },
  });
  assert.deepEqual(abortRecorder.events.map(event => event.type), [
    'llm.request.recorded',
    'llm.call.cancelled',
  ]);
  assert.equal(abortRecorder.events[1]!.payload.reason, 'new_owner_message');
});

test('terminal append failure is surfaced as a persistence gap before the next provider request', async () => {
  const recorder = new Recorder();
  recorder.failTerminalOnce = true;
  let ids = 0;
  const logs: string[] = [];
  const client = new LLMClient(config, (_category, message) => logs.push(message), {
    traceRecorder: recorder,
    createId: () => `call-${++ids}`,
  });
  client.register(provider());

  assert.equal(await client.callWithTools({ messages: [], tools: [] })?.then(result => result?.content), 'tool response');
  assert.equal(await client.callWithTools({ messages: [], tools: [] })?.then(result => result?.content), 'tool response');
  assert.deepEqual(recorder.events.map(event => event.type), [
    'llm.request.recorded',
    'trace.persistence_gap',
    'llm.request.recorded',
    'llm.response.recorded',
  ]);
  assert.equal(recorder.events[1]!.callId, 'call-1');
  assert.equal(recorder.events[1]!.payload.missingEventType, 'llm.response.recorded');
  assert.equal(logs.some(message => message.includes('trace:fatal')), true);
});

test('SQLite restart preserves every provider request and credential canaries never reach the database', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mineclaw-llm-client-trace-'));
  const filename = join(root, 'llm-traces-profile-a.db');
  let providerCalls = 0;
  try {
    const store = new LlmTraceEventStore({ filename, profileId: 'profile-a' });
    const client = new LLMClient(config, () => {}, {
      traceRecorder: store,
      createId: () => `call-${providerCalls + 1}`,
    });
    client.register(provider({
      callWithTools: async () => {
        providerCalls += 1;
        return { toolCalls: [], content: `response-${providerCalls}` };
      },
    }));
    await client.callWithTools({ messages: [{ role: 'user', content: 'first' }], tools: [] });
    await client.callWithTools({ messages: [{ role: 'user', content: 'second' }], tools: [] });
    store.close();

    const restored = new LlmTraceEventStore({ filename, profileId: 'profile-a' });
    const events = restored.listEvents({ limit: 20 }).events;
    const requests = events.filter(event => event.type === 'llm.request.recorded');
    assert.equal(providerCalls, 2);
    assert.equal(requests.length, providerCalls);
    assert.deepEqual(requests.map(event =>
      ((event.payload.request as Record<string, unknown>).messages as Array<{ content: string }>)[0]!.content,
    ), ['first', 'second']);
    assert.deepEqual(restored.listOpenCalls(), []);
    restored.close();

    const databaseBytes = readFileSync(filename).toString('latin1');
    assert.equal(databaseBytes.includes('SECRET_API_KEY_CANARY'), false);
    assert.equal(databaseBytes.includes('SECRET_URL_CANARY'), false);
    assert.equal(databaseBytes.includes('SECRET_STORAGE_CANARY'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
