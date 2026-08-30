import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { LLMChatMessage, LLMToolCallResult } from '../../../../../../../apps/minecraft-companion/src/bot/v2/cognitive/llm/types.js';
import type { GoalRequestV2 } from '../../../../../../../apps/minecraft-companion/src/bot/v2/decision/goalAgentPort/contracts.js';
import { GoalAgentContextCompiler } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/goalAgent/goalAgentContextCompiler.js';
import {
  GoalAgentModelBudgetExceededError,
  GoalAgentModelContextConflictError,
  GoalAgentModelRuntime,
  goalAgentTraceInteractionId,
  type GoalAgentModelTrace,
} from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/goalAgent/goalAgentModelRuntime.js';
import { cloneGoalAgentState, createGoalAgentState, type GoalAgentStateV1 } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/goalAgent/goalAgentState.js';
import type { GamePresenceState } from '../../../../../../../apps/minecraft-companion/src/bot/v2/gamePresenceContext.js';
import { GoalAgentSessionStore } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/goalAgent/goalAgentSessionStore.js';
import { InMemoryGoalAgentSessionEventLog } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/goalAgent/goalAgentSessionEventLog.js';
import type { LlmTraceCallContext } from '../../../../../../../apps/minecraft-companion/src/bot/v2/infra/llmTrace/index.js';
import { canonicalizeChatMessages } from '../../../../../../../apps/minecraft-companion/src/bot/v2/cognitive/llm/canonical.js';
import { ResponsesCodec } from '../../../../../../../apps/minecraft-companion/src/bot/v2/cognitive/llm/responsesCodec.js';

function request(): GoalRequestV2 {
  return {
    meta: {
      schemaVersion: 2, sessionId: 'interaction-1', messageId: 'request-1', correlationId: 'correlation-1',
      conversationId: 'conversation-1', sequence: 1, emittedAt: '2026-08-20T00:00:00.000Z', idempotencyKey: 'request-1',
    },
    origin: 'player_message', originalText: 'make a pickaxe', requestText: 'make a pickaxe',
    requestKind: 'task', constraints: [],
  };
}

function state(sessionId = 'goal-1'): GoalAgentStateV1 {
  return createGoalAgentState({
    sessionId, interactionSessionId: 'interaction-1', request: request(),
    budget: { maxLlmCalls: 8, maxTotalTokens: 30_000 },
  });
}

function response(content: string, toolCalls: LLMToolCallResult['toolCalls'] = []): LLMToolCallResult {
  return { content, toolCalls };
}

function commitModelResult(
  store: GoalAgentSessionStore,
  current: GoalAgentStateV1,
  result: Awaited<ReturnType<GoalAgentModelRuntime['invoke']>>,
): GoalAgentStateV1 {
  const next = cloneGoalAgentState(current);
  next.revision += 1;
  next.updatedAt = new Date(Date.parse(current.updatedAt) + 1_000).toISOString();
  next.budget = structuredClone(result.budget);
  return store.commit({
    expectedRevision: current.revision, expectedEpoch: current.epoch, state: next,
    messages: result.messagesToAppend,
    ...(result.compaction ? { compaction: result.compaction } : {}),
  });
}

test('one Event Log carries every committed Step into the next model request', async () => {
  const store = new GoalAgentSessionStore(':memory:');
  const prompts: LLMChatMessage[][] = [];
  const traces: GoalAgentModelTrace[] = [];
  const runtime = new GoalAgentModelRuntime({
    async callWithTools(args) { prompts.push(structuredClone(args.messages)); return response('{"ok":true}'); },
  }, { eventLog: store, trace: value => traces.push(value) });
  let shared = state();
  store.create(shared);
  const first = await runtime.invoke({
    sessionId: shared.sessionId, expectedRevision: 0, node: 'round',
    instruction: 'Inspect the task.', historyInstruction: 'Inspect task.', state: shared,
    parse: JSON.parse, signal: new AbortController().signal,
  });
  shared = commitModelResult(store, shared, first);
  const second = await runtime.invoke({
    sessionId: shared.sessionId, expectedRevision: 1, node: 'round',
    instruction: 'Continue from the result.', historyInstruction: 'Continue.', state: shared,
    parse: JSON.parse, signal: new AbortController().signal,
  });
  assert.equal(second.budget.llmCalls, 2);
  assert.equal(traces.length, 2);
  assert.match(prompts[1].map(message => message.content).join('\n'), /GoalAgent delegated request/);
  assert.match(prompts[1].map(message => message.content).join('\n'), /Inspect task/);
  assert.equal(store.deriveMessages(shared.sessionId).length, 3);
  store.close();
});

test('uncommitted model output remains audit-only and cannot become ghost context', async () => {
  const store = new GoalAgentSessionStore(':memory:');
  const shared = state();
  store.create(shared);
  const prompts: LLMChatMessage[][] = [];
  const client = {
    async callWithTools(args: { messages: LLMChatMessage[] }) {
      prompts.push(structuredClone(args.messages));
      return response('{"attempt":"answer"}');
    },
  };
  await new GoalAgentModelRuntime(client, { eventLog: store }).invoke({
    sessionId: shared.sessionId, expectedRevision: 0, node: 'round', instruction: 'uncommitted secret',
    state: shared, parse: JSON.parse, signal: new AbortController().signal,
  });
  const restored = store.getActive(shared.sessionId)!;
  await new GoalAgentModelRuntime(client, { eventLog: store }).invoke({
    sessionId: restored.sessionId, expectedRevision: 0, node: 'round', instruction: 'fresh retry',
    state: restored, parse: JSON.parse, signal: new AbortController().signal,
  });
  assert.doesNotMatch(prompts[1].map(message => message.content).join('\n'), /uncommitted secret|"attempt":"answer"/);
  assert.equal(store.deriveMessages(shared.sessionId).length, 1);
  assert.equal(store.listSessionEvents(shared.sessionId).filter(event => event.type === 'model.responded').length, 2);
  store.close();
});

test('frozen request keeps exact input while committed history keeps only semantic instruction', async () => {
  const store = new GoalAgentSessionStore(':memory:');
  let shared = state();
  store.create(shared);
  const runtime = new GoalAgentModelRuntime({ async callWithTools() { return response('{"ok":true}'); } }, { eventLog: store });
  const result = await runtime.invoke({
    sessionId: shared.sessionId, expectedRevision: 0, node: 'round',
    instruction: 'Large current-only catalog: SECRET-CATALOG', historyInstruction: 'Search the target catalog.',
    state: shared, parse: JSON.parse, signal: new AbortController().signal,
  });
  shared = commitModelResult(store, shared, result);
  const frozen = store.listSessionEvents(shared.sessionId).find(event => event.type === 'model.requested')!;
  assert.match(JSON.stringify(frozen.payload.messages), /SECRET-CATALOG/);
  assert.doesNotMatch(JSON.stringify(store.deriveMessages(shared.sessionId)), /SECRET-CATALOG/);
  assert.match(JSON.stringify(store.deriveMessages(shared.sessionId)), /Search the target catalog/);
  store.close();
});

test('context stack keeps stable prefix first and dynamic state at the tail', () => {
  const history: LLMChatMessage[] = [
    { role: 'user', content: 'old input' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'world_observe', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: '{"ok":true}' },
  ];
  const shared = state();
  const compiler = new GoalAgentContextCompiler();
  const compiled = compiler.compile({
    state: shared, node: 'round', instruction: 'Continue.', historyMessages: history,
  });
  assert.equal(compiled.messages[0].role, 'system');
  assert.match(compiled.messages[0].content, /continuous model-tool-result loop/);
  assert.equal(compiled.messages.at(-2)?.role, 'user');
  assert.match(compiled.messages.at(-2)?.content ?? '', /Shared GoalAgent state/);
  assert.match(compiled.messages.at(-1)?.content ?? '', /Continue/);
  assert.match(JSON.stringify(compiled.messages), /world_observe/);
  const changed = cloneGoalAgentState(shared);
  changed.revision = 1;
  changed.phase = 'running';
  changed.activeNode = 'round';
  changed.budget.actions = 1;
  const recompiled = compiler.compile({
    state: changed, node: 'round', instruction: 'Continue.', historyMessages: history,
  });
  assert.deepEqual(recompiled.messages.slice(0, -2), compiled.messages.slice(0, -2));
  assert.notEqual(recompiled.messages.at(-2)?.content, compiled.messages.at(-2)?.content);
});

test('BUG-CROSS-81 · default system identity starts with Minecraft world cognition', () => {
  const compiled = new GoalAgentContextCompiler().compile({
    state: state(), node: 'round', instruction: 'Understand the player request.', historyMessages: [],
  });
  const system = compiled.messages[0];
  assert.equal(system.role, 'system');
  assert.ok(system.content.startsWith(
    'You are an embodied AI player operating inside a live Minecraft game world.',
  ));
  assert.ok(system.content.indexOf('Minecraft gameplay context first')
    < system.content.indexOf('continuous model-tool-result loop'));
  assert.match(system.content, /fresh world observations/);
  assert.match(system.content, /colloquialisms, omissions, abbreviations, typos, homophones, or speech-recognition errors/);
  assert.match(system.content, /"稿子" may mean "镐子\/pickaxe" in a Minecraft action context/);
  assert.match(system.content, /one clear valid referent, use it and continue/);
  assert.match(system.content, /two or more materially different valid interpretations remain/);
  assert.match(system.content, /Never invent Minecraft items, recipes, world state, actions, or completion/);
  assert.match(system.content, /Controlled catalogs, tool receipts, machine observations, safety gates, and success criteria override linguistic inference/);
  assert.deepEqual(compiled.contextSources.selected[0], {
    kind: 'system_identity', ref: 'goalagent:identity/v1', messageIndexes: [0],
  });
});

test('BUG-CROSS-81 · explicit system identity remains an exact override', () => {
  const compiled = new GoalAgentContextCompiler({ systemIdentity: 'Custom GoalAgent identity.' }).compile({
    state: state(), node: 'round', instruction: 'Continue.', historyMessages: [],
  });
  assert.deepEqual(compiled.messages[0], { role: 'system', content: 'Custom GoalAgent identity.' });
});

test('BUG-CROSS-82 · default identity reads current body and player-observation state on every compile', () => {
  let presence: GamePresenceState = { embodied: false, ownerObservation: 'unknown' };
  const compiler = new GoalAgentContextCompiler({ getGamePresence: () => presence });
  const unembodied = compiler.compile({
    state: state(), node: 'round', instruction: 'Observe.', historyMessages: [],
  });
  assert.match(unembodied.messages[0].content, /MinecraftBodyState=unembodied/);
  assert.match(unembodied.messages[0].content, /does not prove the configured player is offline/);
  assert.doesNotMatch(unembodied.messages[0].content, /^You are an embodied AI player/);

  presence = { embodied: true, ownerObservation: 'not_observed' };
  const embodied = compiler.compile({
    state: state(), node: 'round', instruction: 'Observe again.', historyMessages: [],
  });
  assert.match(embodied.messages[0].content, /^You are an embodied AI player operating inside a live Minecraft game world/);
  assert.match(embodied.messages[0].content, /owner=null does not prove the player is offline/);
});

test('compaction replaces only model surface and retains every raw event', () => {
  const store = new GoalAgentSessionStore(':memory:');
  const shared = state();
  store.create(shared);
  for (let index = 0; index < 6; index += 1) {
    store.appendMessage({
      sessionId: shared.sessionId, node: 'round', stateRevision: 0, epoch: 1,
      message: { role: index % 2 === 0 ? 'user' : 'assistant', content: `${index}:${'x'.repeat(700)}` },
    });
  }
  const rawBefore = store.deriveMessages(shared.sessionId);
  const compiled = new GoalAgentContextCompiler({ maxHistoryCharacters: 2_000 }).compile({
    state: shared, node: 'round', instruction: 'Continue.', historyMessages: rawBefore,
  });
  assert.ok(compiled.compaction);
  store.recordCompaction({
    sessionId: shared.sessionId, node: 'round', stateRevision: 0, epoch: 1,
    occurredAt: shared.updatedAt, ...compiled.compaction!,
  });
  const projection = store.projectMessages(shared.sessionId);
  assert.equal(store.deriveMessages(shared.sessionId).length, rawBefore.length);
  assert.equal(projection.compactedThroughMessageIndex, compiled.compaction!.throughMessageIndex);
  assert.equal(projection.messages.length, rawBefore.length - compiled.compaction!.throughMessageIndex);
  assert.match(projection.compactionSummary ?? '', /GoalAgent compaction/);
  store.close();
});

test('trace context identifies exact GoalAgent Step and its manifest', async () => {
  const store = new GoalAgentSessionStore(':memory:');
  const shared = state();
  store.create(shared);
  let captured: LlmTraceCallContext | undefined;
  const runtime = new GoalAgentModelRuntime({
    async callWithTools(args) { captured = structuredClone(args.traceContext); return response('{}'); },
  }, { eventLog: store });
  await runtime.invoke({
    sessionId: shared.sessionId, expectedRevision: 0, node: 'round', instruction: 'Continue.',
    state: shared, parse: JSON.parse, signal: new AbortController().signal,
  });
  assert.equal(captured?.agent, 'goalagent');
  assert.equal(captured?.interactionSessionId, 'conversation-1');
  assert.equal(captured?.goalSessionId, 'goal-1');
  assert.equal(captured?.node, 'round');
  assert.equal(captured?.stateRevision, 0);
  assert.ok((captured?.contextSources?.selected.length ?? 0) >= 4);
  store.close();
});

test('GoalPort delivery session remains separate from shared trace root', () => {
  const shared = state();
  assert.equal(shared.interactionSessionId, 'interaction-1');
  assert.equal(goalAgentTraceInteractionId(shared), 'conversation-1');
});

test('main loop model access is fenced by identity, terminal and budget', async () => {
  let calls = 0;
  const runtime = new GoalAgentModelRuntime(
    { async callWithTools() { calls += 1; return response('{}'); } },
    { eventLog: new InMemoryGoalAgentSessionEventLog() },
  );
  const shared = state();
  await assert.rejects(() => runtime.invoke({
    sessionId: 'other', expectedRevision: 0, node: 'round', instruction: 'x', state: shared,
    parse: JSON.parse, signal: new AbortController().signal,
  }), GoalAgentModelContextConflictError);
  const terminal = cloneGoalAgentState(shared);
  terminal.phase = 'completed';
  terminal.terminal = { outcome: 'completed', summary: 'verified', completedAt: terminal.updatedAt, evidenceRefs: ['verified:1'] };
  await assert.rejects(() => runtime.invoke({
    sessionId: terminal.sessionId, expectedRevision: 0, node: 'round', instruction: 'continue', state: terminal,
    parse: JSON.parse, signal: new AbortController().signal,
  }), /cannot run after terminal/);
  const exhausted = cloneGoalAgentState(shared);
  exhausted.budget.llmCalls = exhausted.budget.maxLlmCalls;
  await assert.rejects(() => runtime.invoke({
    sessionId: exhausted.sessionId, expectedRevision: 0, node: 'round', instruction: 'continue', state: exhausted,
    parse: JSON.parse, signal: new AbortController().signal,
  }), GoalAgentModelBudgetExceededError);
  assert.equal(calls, 0);
});

test('BUG-CROSS-77 · null token limit keeps telemetry without terminating the session', async () => {
  let calls = 0;
  const runtime = new GoalAgentModelRuntime(
    { async callWithTools() { calls += 1; return response('{}'); } },
    { eventLog: new InMemoryGoalAgentSessionEventLog() },
  );
  const unlimited = createGoalAgentState({
    sessionId: 'goal-unlimited-token', interactionSessionId: 'interaction-unlimited-token', request: request(),
    budget: { maxLlmCalls: 8, maxTotalTokens: null },
  });
  unlimited.budget.promptTokens = 130_000;
  const result = await runtime.invoke({
    sessionId: unlimited.sessionId, expectedRevision: 0, node: 'round', instruction: 'continue', state: unlimited,
    parse: JSON.parse, signal: new AbortController().signal,
  });
  assert.equal(result.budget.llmCalls, 1);
  assert.ok(result.budget.promptTokens >= 130_000);
  assert.equal(result.budget.maxTotalTokens, null);
  assert.equal(calls, 1);

  const limited = cloneGoalAgentState(unlimited);
  limited.sessionId = 'goal-limited-token';
  limited.interactionSessionId = 'interaction-limited-token';
  limited.budget.maxTotalTokens = 120_000;
  await assert.rejects(() => runtime.invoke({
    sessionId: limited.sessionId, expectedRevision: 0, node: 'round', instruction: 'continue', state: limited,
    parse: JSON.parse, signal: new AbortController().signal,
  }), (error: unknown) => error instanceof GoalAgentModelBudgetExceededError && error.budget === 'tokens');
  assert.equal(calls, 1);
});

test('terminal reflection uses a read-only frozen request outside the main message surface', async () => {
  const store = new GoalAgentSessionStore(':memory:');
  const initial = state();
  store.create(initial);
  const terminal = cloneGoalAgentState(initial);
  terminal.revision = 1;
  terminal.phase = 'completed';
  terminal.updatedAt = '2026-08-20T00:00:01.000Z';
  terminal.terminal = {
    outcome: 'completed', summary: 'verified', completedAt: terminal.updatedAt, evidenceRefs: ['verified:1'],
  };
  terminal.verdict = {
    decision: 'complete', summary: 'verified', machineCriteriaSatisfied: true,
    ownerActionable: false, retryable: false, evidenceRefs: ['verified:1'],
  };
  store.commit({ expectedRevision: 0, expectedEpoch: 1, state: terminal });
  const beforeMessages = store.deriveMessages(initial.sessionId);
  const runtime = new GoalAgentModelRuntime({
    async callWithTools() { return response('{"summary":"reuse only verified evidence"}'); },
  }, { eventLog: store });
  const reflected = await runtime.reflectTerminal(store.get(initial.sessionId)!, new AbortController().signal);
  assert.equal(reflected.summary, 'reuse only verified evidence');
  assert.deepEqual(store.deriveMessages(initial.sessionId), beforeMessages);
  assert.equal(store.get(initial.sessionId)?.terminal?.summary, 'verified');
  const reflectionRequest = store.listSessionEvents(initial.sessionId)
    .find(event => event.type === 'model.requested' && event.payload.purpose === 'quarantined_reflection');
  assert.ok(reflectionRequest);
  store.close();
});

test('assistant tool calls are preserved for atomic call/result commit', async () => {
  const runtime = new GoalAgentModelRuntime({
    async callWithTools() { return response('', [{ id: 'call-1', name: 'world_observe', arguments: {} }]); },
  }, { eventLog: new InMemoryGoalAgentSessionEventLog() });
  const shared = state();
  const result = await runtime.invoke({
    sessionId: shared.sessionId, expectedRevision: 0, node: 'round', instruction: 'Observe.', state: shared,
    parse: (_content, calls) => calls, signal: new AbortController().signal,
  });
  assert.equal(result.toolCalls[0].name, 'world_observe');
  assert.equal(result.messagesToAppend[1].tool_calls?.[0].function.name, 'world_observe');
});

test('explicit tool choice and abort signal pass through unified runtime', async () => {
  let choice: unknown;
  let calls = 0;
  const runtime = new GoalAgentModelRuntime({
    async callWithTools(args) { calls += 1; choice = structuredClone(args.toolChoice); return response('{}'); },
  }, { eventLog: new InMemoryGoalAgentSessionEventLog() });
  const shared = state();
  await runtime.invoke({
    sessionId: shared.sessionId, expectedRevision: 0, node: 'round', instruction: 'Observe.', state: shared,
    tools: [{ type: 'function', function: { name: 'world_observe', description: 'observe', parameters: { type: 'object', properties: {} } } }],
    toolChoice: { type: 'function', function: { name: 'world_observe' } },
    parse: JSON.parse, signal: new AbortController().signal,
  });
  assert.deepEqual(choice, { type: 'function', function: { name: 'world_observe' } });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => runtime.invoke({
    sessionId: shared.sessionId, expectedRevision: 0, node: 'round', instruction: 'x', state: shared,
    parse: JSON.parse, signal: controller.signal,
  }), { name: 'AbortError' });
  assert.equal(calls, 1);
});

test('FEAT-CROSS-22 · durable Responses replay survives GoalAgent restart and actual usage wins', async () => {
  const root = mkdtempSync(join(tmpdir(), 'goalagent-responses-replay-'));
  const filename = join(root, 'sessions.sqlite');
  const shared = state('goal-responses-replay');
  const canonical = {
    content: [
      { kind: 'reasoning' as const, text: '' },
      { kind: 'tool-call' as const, id: 'call-r', name: 'world_observe', arguments: { radius: 4 } },
    ],
    usage: {
      inputTokens: 321, outputTokens: 45, totalTokens: 366,
      cachedInputTokens: 250, cacheMissInputTokens: 71,
      cacheStatus: 'reported' as const, source: 'openai-responses',
    },
    replay: {
      kind: 'openai-native' as const, version: 1 as const, api: 'openai-responses' as const,
      providerRoute: 'route-responses', model: 'gpt-test',
      blocks: [
        { id: 'rs-r', type: 'reasoning', status: 'completed', encrypted_content: 'opaque', summary: [] },
        { id: 'fc-r', type: 'function_call', status: 'completed', call_id: 'call-r' },
      ],
    },
  };

  let store = new GoalAgentSessionStore(filename);
  try {
    store.create(shared);
    const runtime = new GoalAgentModelRuntime({
      async callWithTools() {
        return {
          content: '',
          toolCalls: [{ id: 'call-r', name: 'world_observe', arguments: { radius: 4 } }],
          usage: canonical.usage,
          canonical,
        };
      },
    }, { eventLog: store });
    const result = await runtime.invoke({
      sessionId: shared.sessionId, expectedRevision: 0, node: 'round', instruction: 'Observe.', state: shared,
      parse: (_content, calls) => calls, signal: new AbortController().signal,
    });
    assert.equal(result.promptTokens, 321);
    assert.equal(result.completionTokens, 45);
    assert.equal(result.tokenUsageSource, 'provider');
    assert.equal(result.assistant.canonical?.source?.replay?.blocks[0]?.encrypted_content, 'opaque');
    commitModelResult(store, shared, result);
    const responseEvent = store.listSessionEvents(shared.sessionId).find(event => event.type === 'model.responded');
    assert.equal((responseEvent?.payload.usage as { cachedInputTokens?: number }).cachedInputTokens, 250);
    assert.equal(responseEvent?.payload.tokenUsageSource, 'provider');

    store.close();
    store = new GoalAgentSessionStore(filename);
    const messages = store.projectMessages(shared.sessionId).messages;
    const restoredAssistant = messages.find(message => message.role === 'assistant');
    assert.equal(restoredAssistant?.canonical?.source?.replay?.providerRoute, 'route-responses');
    const exact = new ResponsesCodec().buildRequest({
      messages: canonicalizeChatMessages(messages),
      tools: [],
    }, { routeId: 'route-responses', baseUrl: 'https://api.openai.com/v1', model: 'gpt-test' });
    const input = exact.body.input as Array<Record<string, unknown>>;
    assert.ok(input.some(item => item.type === 'reasoning' && item.encrypted_content === 'opaque'));
    assert.ok(input.some(item => item.type === 'function_call' && item.call_id === 'call-r'));
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
