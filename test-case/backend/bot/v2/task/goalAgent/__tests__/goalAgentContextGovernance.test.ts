import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { LLMChatMessage } from '../../../../../../../apps/minecraft-companion/src/bot/v2/cognitive/llm/types.js';
import type { AgentContextPolicyConfigV1 } from '../../../../../../../apps/minecraft-companion/src/bot/v2/cognitive/llm/contextBudget.js';
import type { GoalRequestV2 } from '../../../../../../../apps/minecraft-companion/src/bot/v2/decision/goalAgentPort/contracts.js';
import { GoalAgentContextCompiler } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/goalAgent/goalAgentContextCompiler.js';
import {
  GoalAgentModelRuntime,
  createGoalAgentTestModelClient,
} from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/goalAgent/goalAgentModelRuntime.js';
import { GoalAgentSessionStore, GoalAgentStateConflictError } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/goalAgent/goalAgentSessionStore.js';
import { cloneGoalAgentState, createGoalAgentState, type GoalAgentStateV1 } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/goalAgent/goalAgentState.js';
import { formalizeState } from './goalTestFixtures.js';

function request(): GoalRequestV2 {
  return {
    meta: {
      schemaVersion: 2, sessionId: 'interaction-context', messageId: 'request-context', correlationId: 'correlation-context',
      conversationId: 'conversation-context', sequence: 1, emittedAt: '2026-09-06T00:00:00.000Z', idempotencyKey: 'request-context',
    },
    origin: 'player_message', originalText: '种一块小麦田', requestText: '种一块小麦田', requestKind: 'task',
    constraints: ['不要破坏主人的建筑'],
  };
}

function state(): GoalAgentStateV1 {
  const value = createGoalAgentState({
    sessionId: 'goal-context', interactionSessionId: 'interaction-context', request: request(),
    budget: { maxLlmCalls: 20, maxTotalTokens: null },
  });
  return formalizeState(value, [{ type: 'inventory', item: 'wheat', count: 8 }]);
}

function compactingPolicy(): AgentContextPolicyConfigV1 {
  return { revision: 'goalagent-context-test/v1', purposes: { goalAgent: {
    softInputLimitTokens: 200_000, minimumSafetyReserveTokens: 500, safetyReserveRatio: 0.01,
    compactionTriggerRatio: 0.4, compactionTargetRatio: 0.2,
    minimumRecentHistoryTokens: 1_200, maxSummaryTokens: 4_000,
  } } };
}

function appendLongHistory(store: GoalAgentSessionStore, shared: GoalAgentStateV1, turns = 32): void {
  for (let index = 0; index < turns; index += 1) {
    store.appendMessage({
      sessionId: shared.sessionId, node: 'round', stateRevision: shared.revision, epoch: shared.epoch,
      message: { role: 'user', content: `round-${index}-request ${'种田事实'.repeat(90)}` },
    });
    store.appendMessage({
      sessionId: shared.sessionId, node: 'round', stateRevision: shared.revision, epoch: shared.epoch,
      message: { role: 'assistant', content: '', tool_calls: [{
        id: `call-${index}`, type: 'function', function: { name: 'world_observe', arguments: JSON.stringify({ round: index }) },
      }] },
    });
    store.appendMessage({
      sessionId: shared.sessionId, node: 'round', stateRevision: shared.revision, epoch: shared.epoch,
      message: { role: 'tool', tool_call_id: `call-${index}`, content: JSON.stringify({
        ok: index % 5 !== 0, detail: `observation-${index}`,
        evidenceRefs: [`world:${index}`], ...(index % 5 === 0 ? { failure: { code: 'not_ready', category: 'world', retryable: true } } : {}),
      }) },
    });
  }
}

function commit(store: GoalAgentSessionStore, current: GoalAgentStateV1, result: Awaited<ReturnType<GoalAgentModelRuntime['invoke']>>) {
  const next = cloneGoalAgentState(current);
  next.revision += 1;
  next.updatedAt = new Date(Date.parse(next.updatedAt) + 1_000).toISOString();
  next.budget = structuredClone(result.budget);
  return store.commit({
    expectedRevision: current.revision, expectedEpoch: current.epoch, state: next,
    messages: result.messagesToAppend, ...(result.compaction ? { compaction: result.compaction } : {}),
  });
}

test('GA-01/GA-03: compiler emits complete typed segments and never splits a tool call/result round', () => {
  const shared = state();
  const history: LLMChatMessage[] = [
    { role: 'user', content: 'observe' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'world_observe', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call-1', content: '{"ok":true}' },
    { role: 'user', content: 'continue' },
    { role: 'user', content: 'current open round' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'call-open', type: 'function', function: { name: 'world_observe', arguments: '{}' } }] },
  ];
  const compiled = new GoalAgentContextCompiler().compile({
    state: shared, node: 'round', instruction: 'Act.', historyMessages: history,
    historyRefs: history.map((_message, index) => ({ messageIndex: index, eventSeq: index + 10 })),
  });
  const rounds = compiled.segments.filter(segment => segment.kind === 'history_round');
  assert.equal(rounds.length, 3);
  assert.equal(rounds[0].messages.length, 3);
  assert.equal(rounds[0].atomicGroupId, rounds[0].id);
  assert.deepEqual(compiled.contextSources.omitted, []);
  assert.deepEqual(compiled.segments.filter(segment => segment.retention === 'required').map(segment => segment.kind),
    ['stable_system', 'history_round', 'dynamic_state', 'current_instruction']);
});

test('GA-02/GA-04/CP-01: Token trigger produces bounded Compaction V2 but does not persist it before Agent commit', async () => {
  const store = new GoalAgentSessionStore(':memory:');
  try {
    const shared = state(); store.create(shared); appendLongHistory(store, shared);
    let dispatched: LLMChatMessage[] = [];
    const runtime = new GoalAgentModelRuntime(createGoalAgentTestModelClient({
      async callWithTools(args) { dispatched = structuredClone(args.messages); return { content: '{"ok":true}', toolCalls: [] }; },
    }), { eventLog: store, contextPolicy: compactingPolicy });
    const result = await runtime.invoke({
      sessionId: shared.sessionId, expectedRevision: 0, node: 'round', instruction: 'Continue farming.',
      state: shared, parse: JSON.parse, signal: new AbortController().signal,
    });
    assert.equal(result.compaction?.schema, 'mineclaw.goalagent-compaction/v2');
    assert.ok(result.compaction!.tokensAfter < result.compaction!.tokensBefore);
    assert.equal(result.compaction!.policyRevision, compactingPolicy().revision);
    assert.match(result.compaction!.profileRef, /goalagent-legacy-test-double/);
    assert.deepEqual(result.compaction!.summary.goal.constraints, [{ type: 'natural_language', value: '不要破坏主人的建筑' }]);
    assert.ok(result.compaction!.summary.attempts.length > 0);
    assert.ok(result.compaction!.summary.failures.length > 0);
    assert.ok(result.compaction!.summary.receiptEvidence.refs.some(ref => ref.startsWith('world:')));
    assert.match(dispatched.map(message => message.content).join('\n'), /GoalAgent compaction\/v2/);
    assert.equal(store.listSessionEvents(shared.sessionId).filter(event => event.type === 'compaction.checkpoint').length, 0);

    const repeated = await runtime.invoke({
      sessionId: shared.sessionId, expectedRevision: 0, node: 'round', instruction: 'Continue farming.',
      state: shared, parse: JSON.parse, signal: new AbortController().signal,
    });
    assert.deepEqual({ summary: repeated.compaction?.summary, sourceDigest: repeated.compaction?.sourceDigest,
      through: repeated.compaction?.throughMessageIndex, events: repeated.compaction?.coveredEventSeq },
    { summary: result.compaction?.summary, sourceDigest: result.compaction?.sourceDigest,
      through: result.compaction?.throughMessageIndex, events: result.compaction?.coveredEventSeq });

    commit(store, shared, result);
    const checkpoint = store.listSessionEvents(shared.sessionId).filter(event => event.type === 'compaction.checkpoint').at(-1)!;
    assert.equal(checkpoint.payload.schema, 'mineclaw.goalagent-compaction/v2');
    assert.equal(checkpoint.payload.sourceDigest, result.compaction!.sourceDigest);
    assert.equal(store.deriveMessages(shared.sessionId).length, 99);
    assert.ok(store.projectMessages(shared.sessionId).compactedThroughMessageIndex > 0);
    assert.match(store.projectMessages(shared.sessionId).compactionSummary ?? '', /GoalAgent compaction\/v2/);
  } finally { store.close(); }
});

test('GA-05/CP-02/CP-03: provider failure and cancellation cannot create ghost checkpoints', async () => {
  for (const mode of ['failure', 'cancel'] as const) {
    const store = new GoalAgentSessionStore(':memory:');
    try {
      const shared = state(); store.create(shared); appendLongHistory(store, shared);
      const controller = new AbortController();
      const runtime = new GoalAgentModelRuntime(createGoalAgentTestModelClient({
        async callWithTools() { if (mode === 'cancel') controller.abort(); return null; },
      }), { eventLog: store, contextPolicy: compactingPolicy });
      await assert.rejects(runtime.invoke({
        sessionId: shared.sessionId, expectedRevision: 0, node: 'round', instruction: 'Continue.',
        state: shared, parse: JSON.parse, signal: controller.signal,
      }), mode === 'cancel' ? { name: 'AbortError' } : { name: 'GoalAgentModelUnavailableError' });
      assert.equal(store.listSessionEvents(shared.sessionId).filter(event => event.type === 'compaction.checkpoint').length, 0);
      assert.equal(store.deriveMessages(shared.sessionId).length, 97);
    } finally { store.close(); }
  }
});

test('GA-06/CP-04: stale CAS rolls back new messages and Compaction V2 in one transaction', async () => {
  const store = new GoalAgentSessionStore(':memory:');
  try {
    const shared = state(); store.create(shared); appendLongHistory(store, shared);
    const runtime = new GoalAgentModelRuntime(createGoalAgentTestModelClient({
      async callWithTools() { return { content: '{"ok":true}', toolCalls: [] }; },
    }), { eventLog: store, contextPolicy: compactingPolicy });
    const result = await runtime.invoke({ sessionId: shared.sessionId, expectedRevision: 0, node: 'round', instruction: 'Continue.',
      state: shared, parse: JSON.parse, signal: new AbortController().signal });
    const next = cloneGoalAgentState(shared); next.revision = 2;
    assert.throws(() => store.commit({ expectedRevision: 1, expectedEpoch: 1, state: next,
      messages: result.messagesToAppend, compaction: result.compaction }), GoalAgentStateConflictError);
    assert.equal(store.deriveMessages(shared.sessionId).length, 97);
    assert.equal(store.listSessionEvents(shared.sessionId).filter(event => event.type === 'compaction.checkpoint').length, 0);
  } finally { store.close(); }
});

test('CP-05/CP-07: historical V1 is readable and is rebuilt into the sole V2 write path', async () => {
  const store = new GoalAgentSessionStore(':memory:');
  try {
    const shared = state(); store.create(shared);
    store.appendSessionEvent({
      sessionId: shared.sessionId, occurredAt: shared.updatedAt, type: 'compaction.checkpoint', node: 'round',
      stateRevision: 0, epoch: 1, payload: {
        summary: '[GoalAgent compaction/v1]\n{"request":"legacy","attempts":[{"callId":"legacy-call","tool":"legacy-tool"}],"evidenceRefs":["legacy:evidence"],"compacted":{"messages":1}}',
        omittedMessages: 1, throughMessageIndex: 1,
      },
    });
    assert.match(store.projectMessages(shared.sessionId).compactionSummary ?? '', /compaction\/v1/);
    assert.throws(() => store.recordCompaction({ schema: 'mineclaw.goalagent-compaction/v1' } as never), /only writes Compaction V2/);
    appendLongHistory(store, shared);
    const runtime = new GoalAgentModelRuntime(createGoalAgentTestModelClient({
      async callWithTools() { return { content: '{"ok":true}', toolCalls: [] }; },
    }), { eventLog: store, contextPolicy: compactingPolicy });
    const result = await runtime.invoke({ sessionId: shared.sessionId, expectedRevision: 0, node: 'round', instruction: 'Continue.',
      state: shared, parse: JSON.parse, signal: new AbortController().signal });
    assert.equal(result.compaction?.schema, 'mineclaw.goalagent-compaction/v2');
    assert.ok(result.compaction?.summary.attempts.some(attempt => attempt.callId === 'legacy-call'));
    assert.ok(result.compaction?.summary.receiptEvidence.refs.includes('legacy:evidence'));
    assert.equal(result.compaction?.coveredEventSeq.from, 1);
  } finally { store.close(); }
});

test('GA-07/GA-08: a 10K-character history stays intact under the 1M profile and raw clients fail closed', async () => {
  const store = new GoalAgentSessionStore(':memory:');
  try {
    const shared = state(); store.create(shared);
    store.appendMessage({ sessionId: shared.sessionId, node: 'round', stateRevision: 0, epoch: 1,
      message: { role: 'user', content: 'x'.repeat(10_500) } });
    assert.throws(() => new GoalAgentModelRuntime({ async callWithTools() { return null; } }, { eventLog: store }),
      /must implement governed exact-request preparation/);
    const runtime = new GoalAgentModelRuntime(createGoalAgentTestModelClient({
      async callWithTools() { return { content: '{"ok":true}', toolCalls: [] }; },
    }), { eventLog: store });
    const result = await runtime.invoke({ sessionId: shared.sessionId, expectedRevision: 0, node: 'round', instruction: 'Continue.',
      state: shared, parse: JSON.parse, signal: new AbortController().signal });
    assert.equal(result.compaction, undefined);
  } finally { store.close(); }
});

test('CP-06: evidence overflow remains explicit through omitted count and digest', async () => {
  const store = new GoalAgentSessionStore(':memory:');
  try {
    const shared = state();
    shared.interpretation.evidenceRefs = Array.from({ length: 200 }, (_value, index) => `evidence:${index}:${'x'.repeat(80)}`);
    store.create(shared); appendLongHistory(store, shared);
    const runtime = new GoalAgentModelRuntime(createGoalAgentTestModelClient({
      async callWithTools() { return { content: '{"ok":true}', toolCalls: [] }; },
    }), { eventLog: store, contextPolicy: compactingPolicy });
    const result = await runtime.invoke({ sessionId: shared.sessionId, expectedRevision: 0, node: 'round', instruction: 'Continue.',
      state: shared, parse: JSON.parse, signal: new AbortController().signal });
    assert.ok((result.compaction?.summary.receiptEvidence.omitted ?? 0) > 0);
    assert.match(result.compaction?.summary.receiptEvidence.digest ?? '', /^[a-f0-9]{64}$/);
  } finally { store.close(); }
});

test('GA-06: V2 checkpoint and raw events survive restart and resume through the same governed path', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mineclaw-compaction-v2-'));
  const filename = join(directory, 'goal-agent.db');
  let store = new GoalAgentSessionStore(filename);
  try {
    const shared = state(); store.create(shared); appendLongHistory(store, shared);
    const firstRuntime = new GoalAgentModelRuntime(createGoalAgentTestModelClient({
      async callWithTools() { return { content: '{"ok":true}', toolCalls: [] }; },
    }), { eventLog: store, contextPolicy: compactingPolicy });
    const first = await firstRuntime.invoke({ sessionId: shared.sessionId, expectedRevision: 0, node: 'round', instruction: 'Continue.',
      state: shared, parse: JSON.parse, signal: new AbortController().signal });
    const committed = commit(store, shared, first);
    const rawCount = store.deriveMessages(shared.sessionId).length;
    store.close();

    store = new GoalAgentSessionStore(filename);
    assert.equal(store.deriveMessages(shared.sessionId).length, rawCount);
    assert.equal(store.projectMessages(shared.sessionId).compaction?.schema, 'mineclaw.goalagent-compaction/v2');
    let resumedSurface = '';
    const resumedRuntime = new GoalAgentModelRuntime(createGoalAgentTestModelClient({
      async callWithTools(args) { resumedSurface = args.messages.map(message => message.content).join('\n'); return { content: '{"ok":true}', toolCalls: [] }; },
    }), { eventLog: store, contextPolicy: compactingPolicy });
    await resumedRuntime.invoke({ sessionId: committed.sessionId, expectedRevision: committed.revision, node: 'round',
      instruction: 'Resume after restart.', state: committed, parse: JSON.parse, signal: new AbortController().signal });
    assert.match(resumedSurface, /GoalAgent compaction\/v2/);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
