import assert from 'node:assert/strict';
import test from 'node:test';

import type { LLMToolCallResult } from '../../../../../../../apps/minecraft-companion/src/bot/v2/cognitive/llm/types.js';
import type { GoalRequestV2 } from '../../../../../../../apps/minecraft-companion/src/bot/v2/decision/goalAgentPort/contracts.js';
import {
  defaultGoalKnowledge,
  InMemoryGoalKnowledgePort,
} from '../../../../../../../apps/minecraft-companion/src/bot/v2/knowledge/goalTargetKnowledge.js';
import type { WorldStateView } from '../../../../../../../apps/minecraft-companion/src/bot/v2/types.js';
import { GoalAgentModelRuntime } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/goalAgent/goalAgentModelRuntime.js';
import { GoalAgentRoundLoop } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/goalAgent/goalAgentRoundLoop.js';
import { GoalAgentRoundToolRuntime } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/goalAgent/goalAgentRoundTools.js';
import { GoalAgentSessionStore } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/goalAgent/goalAgentSessionStore.js';
import { createGoalAgentState } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/goalAgent/goalAgentState.js';

function request(): GoalRequestV2 {
  return {
    meta: {
      schemaVersion: 2,
      sessionId: 'interaction-round-1',
      messageId: 'request-round-1',
      correlationId: 'correlation-round-1',
      conversationId: 'conversation-round-1',
      sequence: 1,
      emittedAt: '2026-08-23T00:00:00.000Z',
      idempotencyKey: 'request-round-1',
    },
    origin: 'player_message',
    originalText: '给我一块石头',
    requestText: '给我一块石头',
    requestKind: 'task',
    constraints: [],
  };
}

function world(cobblestone: number): WorldStateView {
  return {
    tick: cobblestone ? 2 : 1,
    timestamp: Date.parse(cobblestone ? '2026-08-23T00:00:02.000Z' : '2026-08-23T00:00:01.000Z'),
    self: { position: { x: 0, y: 64, z: 0 }, yaw: 0, pitch: 0, health: 20, maxHealth: 20, food: 20, isOnGround: true },
    owner: null,
    environment: { dimension: 'overworld', timeOfDay: 1000, isDay: true, isRaining: false },
    entities: [],
    inventory: {
      items: cobblestone ? [{ name: 'cobblestone', count: cobblestone, slot: 0 }] : [],
      held: null,
      freeSlots: cobblestone ? 35 : 36,
    },
    taskContext: null,
  };
}

test('BUG-CROSS-77 · round slice yields and resumes the same non-terminal session', async () => {
  const store = new GoalAgentSessionStore(':memory:');
  const events: string[] = [];
  let calls = 0;
  const loop = new GoalAgentRoundLoop({
    store,
    profileId: 'round-slice-test',
    maxRoundsPerRun: 2,
    publish: event => events.push(event.type),
    model: new GoalAgentModelRuntime({
      async callWithTools() { calls += 1; return { content: 'still working', toolCalls: [] }; },
    }, { eventLog: store }),
  });
  try {
    const initial = createGoalAgentState({
      sessionId: 'goal-round-slice', interactionSessionId: 'interaction-round-slice', request: request(),
      budget: { maxTotalTokens: null },
    });
    loop.create(initial);
    const first = await loop.run(initial.sessionId);
    assert.equal(first.phase, 'running');
    assert.equal(first.sessionId, initial.sessionId);
    assert.equal(first.epoch, initial.epoch);
    assert.equal(first.revision, 2);
    assert.equal(events.filter(value => value === 'goalagent.run.yielded').length, 1);

    const second = await loop.run(initial.sessionId, { maxRounds: 1 });
    assert.equal(second.phase, 'running');
    assert.equal(second.sessionId, first.sessionId);
    assert.equal(second.epoch, first.epoch);
    assert.equal(second.revision, 3);
    assert.equal(second.budget.llmCalls, 3);
    assert.equal(calls, 3);
  } finally {
    loop.dispose();
    store.close();
  }
});

test('continuous round loop keeps model, direct tools and receipts in one session log', async () => {
  const store = new GoalAgentSessionStore(':memory:');
  let inventoryCount = 0;
  let executions = 0;
  const responses: LLMToolCallResult[] = [
    { content: '', toolCalls: [{ id: 'search-1', name: 'goal_search_targets', arguments: { query: '石头', kind: 'item' } }] },
    {
      content: '',
      toolCalls: [{
        id: 'goal-1', name: 'goal_create', arguments: {
          outcome: 'obtain',
          target: { kind: 'item', surface: '石头', registryId: 'minecraft:cobblestone', quantity: 1 },
        },
      }],
    },
    { content: '', toolCalls: [{ id: 'world-1', name: 'world_observe', arguments: {} }] },
    {
      content: '',
      toolCalls: [{
        id: 'plan-1', name: 'plan_commit', arguments: {
          rationale: 'obtain one cobblestone',
          tasks: [{
            id: 'obtain-stone', goalText: '获得一块圆石',
            successCriteria: [{ type: 'inventory', item: 'cobblestone', count: 1 }],
            dependsOn: [], estimatedActions: 1, estimatedDurationMs: 1000, risk: 0.1,
          }],
        },
      }],
    },
    { content: '', toolCalls: [{ id: 'list-1', name: 'action_list', arguments: {} }] },
    { content: '', toolCalls: [{ id: 'execute-1', name: 'action_execute', arguments: { candidateId: 'test:obtain-stone' } }] },
  ];
  const model = new GoalAgentModelRuntime({
    async callWithTools() {
      const response = responses.shift();
      if (!response) throw new Error('unexpected extra model round');
      return response;
    },
  }, { eventLog: store });
  const loop = new GoalAgentRoundLoop({
    store,
    model,
    profileId: 'round-test',
    tools: {
      knowledge: defaultGoalKnowledge,
      perception: { async observe() { return world(inventoryCount); } },
      execution: {
        listCandidates() {
          return [{
            id: 'test:obtain-stone', kind: 'atomic', source: 'slow_llm',
            action: 'test_obtain', description: 'obtain one cobblestone', fixedArgs: {}, evidenceRefs: ['candidate:test_obtain'],
          }];
        },
        async execute(input) {
          executions += 1;
          inventoryCount = 1;
          return {
            executionSessionId: `execution:${input.idempotencyKey}`,
            idempotencyKey: input.idempotencyKey,
            ok: true,
            detail: 'obtained cobblestone',
            startedAt: '2026-08-23T00:00:01.000Z',
            completedAt: '2026-08-23T00:00:02.000Z',
            evidenceRefs: ['action:obtain-stone:ok'],
          };
        },
      },
      verification: {
        verifyTask({ state }) {
          const ok = state.world.latest?.inventory.items.some(item => item.name === 'cobblestone' && item.count >= 1) ?? false;
          return { ok, detail: ok ? 'task satisfied' : 'task pending', evidenceRefs: [`task:${ok}`] };
        },
        verifyRoot({ state }) {
          const ok = state.world.latest?.inventory.items.some(item => item.name === 'cobblestone' && item.count >= 1) ?? false;
          return { ok, detail: ok ? 'root satisfied' : 'root pending', evidenceRefs: [`root:${ok}`] };
        },
      },
    },
  });
  try {
    const initial = createGoalAgentState({
      sessionId: 'goal-round-1',
      interactionSessionId: 'interaction-round-1',
      request: request(),
    });
    loop.create(initial);
    const terminal = await loop.run(initial.sessionId, { maxRounds: 10 });

    assert.equal(terminal.phase, 'completed');
    assert.equal(terminal.activeNode, 'round');
    assert.equal(terminal.terminal?.outcome, 'completed');
    assert.equal(terminal.verdict?.machineCriteriaSatisfied, true);
    assert.equal(terminal.plan.graph?.nodes[0]?.state, 'satisfied');
    assert.equal(executions, 1);
    assert.equal(responses.length, 0);
    assert.deepEqual(loop.registeredTools().includes('action_execute'), true);

    const events = store.listSessionEvents(initial.sessionId);
    assert.equal(events.filter(event => event.type === 'model.requested').length, 6);
    assert.equal(events.filter(event => event.type === 'tool.called').length, 6);
    assert.equal(events.filter(event => event.type === 'tool.result').length, 6);
    assert.equal(store.deriveMessages(initial.sessionId).filter(message => message.role === 'tool').length, 6);
    assert.match(JSON.stringify(store.deriveMessages(initial.sessionId)), /obtained cobblestone/);
  } finally {
    loop.dispose();
    store.close();
  }
});

test('simple root goal executes directly without a mandatory planner Step', async () => {
  const store = new GoalAgentSessionStore(':memory:');
  let inventoryCount = 0;
  const responses: LLMToolCallResult[] = [
    { content: '', toolCalls: [{ id: 'search', name: 'goal_search_targets', arguments: { query: '石头', kind: 'item' } }] },
    { content: '', toolCalls: [{ id: 'goal', name: 'goal_create', arguments: {
      outcome: 'obtain', target: { kind: 'item', surface: '石头', registryId: 'minecraft:cobblestone', quantity: 1 },
    } }] },
    { content: '', toolCalls: [{ id: 'observe', name: 'world_observe', arguments: {} }] },
    { content: '', toolCalls: [{ id: 'list', name: 'action_list', arguments: {} }] },
    { content: '', toolCalls: [{ id: 'execute', name: 'action_execute', arguments: { candidateId: 'direct:stone' } }] },
  ];
  const loop = new GoalAgentRoundLoop({
    store,
    profileId: 'direct-root-test',
    model: new GoalAgentModelRuntime({ async callWithTools() { return responses.shift() ?? null; } }, { eventLog: store }),
    tools: {
      knowledge: defaultGoalKnowledge,
      perception: { async observe() { return world(inventoryCount); } },
      execution: {
        listCandidates(input) {
          assert.equal(input.planNodeId, undefined);
          return [{
            id: 'direct:stone', kind: 'atomic', source: 'slow_llm', action: 'test_obtain',
            description: 'obtain root item', fixedArgs: {}, evidenceRefs: ['candidate:direct'],
          }];
        },
        async execute(input) {
          inventoryCount = 1;
          return {
            executionSessionId: 'execution:direct', idempotencyKey: input.idempotencyKey, ok: true,
            detail: 'direct root action complete', startedAt: '2026-08-23T00:00:01.000Z',
            completedAt: '2026-08-23T00:00:02.000Z', evidenceRefs: ['action:direct'],
          };
        },
      },
      verification: {
        verifyTask() { throw new Error('simple root task must not invoke plan-task verifier'); },
        verifyRoot({ state }) {
          const ok = state.world.latest?.inventory.items.some(item => item.name === 'cobblestone') ?? false;
          return { ok, detail: ok ? 'root satisfied' : 'root pending', evidenceRefs: [`root:${ok}`] };
        },
      },
      memory: {
        search() { return { records: [], evidenceRefs: [], gaps: [], traceId: 'memory-trace-1' }; },
        get() { return null; },
      },
    },
  });
  try {
    const initial = createGoalAgentState({
      sessionId: 'goal-direct-root', interactionSessionId: 'interaction-direct-root', request: request(),
    });
    loop.create(initial);
    const terminal = await loop.run(initial.sessionId, { maxRounds: 8 });
    assert.equal(terminal.terminal?.outcome, 'completed');
    assert.equal(terminal.plan.graph, null);
    assert.equal(responses.length, 0);
    assert.deepEqual(loop.registeredTools().slice().sort(), loop.registeredTools());
    assert.ok(loop.registeredTools().includes('memory_search'));
  } finally {
    loop.dispose();
    store.close();
  }
});

test('memory is progressively searched then read through the same tool registry', async () => {
  const shared = createGoalAgentState({
    sessionId: 'goal-memory', interactionSessionId: 'interaction-memory', request: request(),
  });
  const record = {
    id: 'memory-1', profileId: 'round-test', kind: 'task_experience' as const, status: 'active' as const,
    summary: 'stone can be gathered nearby', createdAt: 1, updatedAt: 1, importance: 0.8, confidence: 0.9,
    entities: [], locationRefs: [], sourceRefs: [], evidenceRefs: ['memory-evidence:1'], metadata: {},
  };
  const runtime = new GoalAgentRoundToolRuntime({
    profileId: 'round-test',
    tools: {
      memory: {
        search() { return { records: [record], evidenceRefs: record.evidenceRefs, gaps: [], traceId: 'trace-1' }; },
        get(ref) { return ref === record.id ? record : null; },
      },
    },
  });
  const signal = new AbortController().signal;
  const denied = await runtime.execute({ id: 'get-early', name: 'memory_get', arguments: { ref: record.id } }, shared, signal);
  assert.equal(denied.content.ok, false);
  const searched = await runtime.execute({ id: 'search-memory', name: 'memory_search', arguments: { query: '石头' } }, shared, signal);
  assert.equal(searched.content.ok, true);
  assert.deepEqual(shared.cognition.memoryRefs, [record.id]);
  const loaded = await runtime.execute({ id: 'get-memory', name: 'memory_get', arguments: { ref: record.id } }, shared, signal);
  assert.equal(loaded.content.ok, true);
  assert.deepEqual(loaded.evidenceRefs, record.evidenceRefs);
});

test('tool runtime propagates cancellation instead of converting it into a retryable receipt', async () => {
  const shared = createGoalAgentState({
    sessionId: 'goal-abort-tool', interactionSessionId: 'interaction-abort-tool', request: request(),
  });
  const runtime = new GoalAgentRoundToolRuntime({
    profileId: 'abort-tool-test',
    tools: {
      memory: {
        search() { throw new DOMException('cancelled during search', 'AbortError'); },
        get() { return null; },
      },
    },
  });
  await assert.rejects(runtime.execute({
    id: 'abort-search', name: 'memory_search', arguments: { query: 'stone' },
  }, shared, new AbortController().signal), { name: 'AbortError' });
});

test('goal_create preserves an earlier world context and plan schema exposes exact criterion types', async () => {
  const shared = createGoalAgentState({
    sessionId: 'goal-context-preserved', interactionSessionId: 'interaction-context-preserved', request: request(),
  });
  const runtime = new GoalAgentRoundToolRuntime({
    profileId: 'context-preserved-test',
    tools: {
      knowledge: defaultGoalKnowledge,
      perception: { async observe() { return world(0); } },
    },
    now: () => '2026-08-23T00:00:03.000Z',
  });
  const signal = new AbortController().signal;
  await runtime.execute({ id: 'search', name: 'goal_search_targets', arguments: { query: '石头', kind: 'item' } }, shared, signal);
  await runtime.execute({ id: 'observe', name: 'world_observe', arguments: {} }, shared, signal);
  const contextBeforeGoal = structuredClone(shared.goal.context);
  const created = await runtime.execute({ id: 'goal', name: 'goal_create', arguments: {
    outcome: 'obtain', target: { kind: 'structure', registryId: 'minecraft:cobblestone', quantity: 1 },
  } }, shared, signal);
  assert.equal(created.content.ok, true);
  assert.equal(shared.goal.definition?.target.kind, 'item');
  assert.deepEqual(shared.goal.context, contextBeforeGoal);
  const committed = await runtime.execute({ id: 'plan', name: 'plan_commit', arguments: {
    tasks: [{
      id: 'obtain-stone', goalText: '获得一块圆石',
      successCriteria: [{ type: 'inventory', item: 'cobblestone', count: 1 }], dependsOn: [],
    }],
  } }, shared, signal);
  assert.equal(committed.content.ok, true);

  const planSchema = runtime.schemas().find(tool => tool.function.name === 'plan_commit');
  const parameters = planSchema?.function.parameters as { properties?: Record<string, any> };
  const criterionType = parameters.properties?.tasks?.items?.properties?.successCriteria?.items?.properties?.type;
  assert.ok(criterionType.enum.includes('inventory'));
  assert.ok(criterionType.enum.includes('block_placed'));

  const placement = createGoalAgentState({
    sessionId: 'goal-placement-binding', interactionSessionId: 'interaction-placement-binding', request: request(),
  });
  await runtime.execute({ id: 'search-table', name: 'goal_search_targets', arguments: { query: '工作台', kind: 'item' } }, placement, signal);
  await runtime.execute({ id: 'observe-table', name: 'world_observe', arguments: {} }, placement, signal);
  await runtime.execute({ id: 'goal-table', name: 'goal_create', arguments: {
    outcome: 'place', target: { registryId: 'minecraft:crafting_table', quantity: 1 },
    placement: { relativeTo: 'owner', relation: 'underfoot', radius: 3 },
  } }, placement, signal);
  assert.equal(placement.rootGoal?.successCriteria[0]?.relation, 'near');
  const planWithoutSystemTimestamp = await runtime.execute({ id: 'plan-table', name: 'plan_commit', arguments: {
    tasks: [{
      id: 'place-table', goalText: '在主人附近放工作台', dependsOn: [],
      successCriteria: [{ type: 'block_placed', item: 'crafting_table', count: 1, relativeTo: 'owner', relation: 'underfoot', radius: 3 }],
    }],
  } }, placement, signal);
  assert.equal(planWithoutSystemTimestamp.content.ok, true);
  assert.equal(typeof placement.plan.graph?.nodes[0]?.goal.metadata?.structuredSuccessCriteria?.[0]?.since, 'number');
  assert.equal(placement.plan.graph?.nodes[0]?.goal.metadata?.structuredSuccessCriteria?.[0]?.relation, 'near');
});

test('FEAT-CROSS-19 · authoritative package target keeps its registered predicate instead of generic inventory semantics', async () => {
  const shared = createGoalAgentState({
    sessionId: 'goal-agriculture-target', interactionSessionId: 'interaction-agriculture-target', request: request(),
  });
  const knowledge = new InMemoryGoalKnowledgePort([{
    kind: 'item', registryId: 'mineclaw:mature_crops_to_chest', aliases: ['收田', '收割农田'],
    taskFamilies: ['agriculture'], successCriteriaPolicy: 'authoritative',
    successCriteria: [{ type: 'predicate', predicate: 'agriculture.harvest_to_chest' }],
  }]);
  const runtime = new GoalAgentRoundToolRuntime({
    profileId: 'agriculture-target-test', tools: { knowledge },
    now: () => '2026-08-23T12:00:00.000Z',
  });
  const signal = new AbortController().signal;
  const searched = await runtime.execute({
    id: 'search-harvest', name: 'goal_search_targets', arguments: { query: '收田', kind: 'item' },
  }, shared, signal);
  assert.equal(searched.content.ok, true);
  const created = await runtime.execute({
    id: 'create-harvest', name: 'goal_create', arguments: {
      outcome: 'obtain', target: { registryId: 'mineclaw:mature_crops_to_chest', quantity: 1 },
    },
  }, shared, signal);
  assert.equal(created.content.ok, true);
  assert.deepEqual(shared.rootGoal?.successCriteria, [{
    type: 'predicate', predicate: 'agriculture.harvest_to_chest', since: Date.parse('2026-08-23T12:00:00.000Z'),
  }]);
});

test('plan guard rejects transient inventory and its consuming effect on the same task', async () => {
  const shared = createGoalAgentState({
    sessionId: 'goal-transient-plan', interactionSessionId: 'interaction-transient-plan', request: request(),
  });
  const runtime = new GoalAgentRoundToolRuntime({
    profileId: 'transient-plan-test',
    tools: {
      knowledge: defaultGoalKnowledge,
      perception: { async observe() { return world(0); } },
    },
  });
  const signal = new AbortController().signal;
  await runtime.execute({ id: 'search-table', name: 'goal_search_targets', arguments: { query: '工作台', kind: 'item' } }, shared, signal);
  await runtime.execute({ id: 'observe-table', name: 'world_observe', arguments: {} }, shared, signal);
  await runtime.execute({ id: 'goal-table', name: 'goal_create', arguments: {
    outcome: 'place', target: { registryId: 'minecraft:crafting_table', quantity: 1 },
    placement: { relativeTo: 'owner', relation: 'underfoot', radius: 3 },
  } }, shared, signal);
  const placementCriterion = shared.rootGoal?.successCriteria[0];
  assert.ok(placementCriterion);

  const rejected = await runtime.execute({ id: 'plan-impossible', name: 'plan_commit', arguments: {
    tasks: [{
      id: 'craft-and-place-table', goalText: '制作并放置工作台', dependsOn: [],
      successCriteria: [
        { type: 'inventory', item: 'crafting_table', count: 1 },
        placementCriterion,
      ],
    }],
  } }, shared, signal);
  assert.equal(rejected.content.ok, false);
  assert.match(String(rejected.content.error), /transient_inventory_must_be_separate:craft-and-place-table:crafting_table:block_placed/);
  assert.equal(shared.plan.graph, null);

  const accepted = await runtime.execute({ id: 'plan-valid', name: 'plan_commit', arguments: {
    tasks: [
      {
        id: 'craft-table', goalText: '制作工作台', dependsOn: [],
        successCriteria: [{ type: 'inventory', item: 'crafting_table', count: 1 }],
      },
      {
        id: 'place-table', goalText: '放置工作台', dependsOn: ['craft-table'],
        successCriteria: [placementCriterion],
      },
    ],
  } }, shared, signal);
  assert.equal(accepted.content.ok, true);
  assert.deepEqual(shared.plan.graph?.edges, [{ from: 'craft-table', to: 'place-table', type: 'requires' }]);
});

test('failed physical actions consume recovery budget and fail closed', async () => {
  const store = new GoalAgentSessionStore(':memory:');
  const responses: LLMToolCallResult[] = [
    { content: '', toolCalls: [{ id: 'search', name: 'goal_search_targets', arguments: { query: '石头', kind: 'item' } }] },
    { content: '', toolCalls: [{ id: 'goal', name: 'goal_create', arguments: {
      outcome: 'obtain', target: { kind: 'item', surface: '石头', registryId: 'minecraft:cobblestone', quantity: 1 },
    } }] },
    { content: '', toolCalls: [{ id: 'observe', name: 'world_observe', arguments: {} }] },
    { content: '', toolCalls: [{ id: 'list', name: 'action_list', arguments: {} }] },
    { content: '', toolCalls: [{ id: 'execute', name: 'action_execute', arguments: { candidateId: 'direct:fail' } }] },
  ];
  const loop = new GoalAgentRoundLoop({
    store, profileId: 'recovery-budget-test',
    model: new GoalAgentModelRuntime({ async callWithTools() { return responses.shift() ?? null; } }, { eventLog: store }),
    tools: {
      knowledge: defaultGoalKnowledge,
      perception: { async observe() { return world(0); } },
      execution: {
        listCandidates() { return [{
          id: 'direct:fail', kind: 'atomic', source: 'slow_llm', action: 'test_fail',
          description: 'fail once', fixedArgs: {}, evidenceRefs: [],
        }]; },
        async execute(input) { return {
          executionSessionId: 'execution:failed', idempotencyKey: input.idempotencyKey, ok: false,
          detail: 'resource unavailable', startedAt: '2026-08-23T00:00:01.000Z',
          completedAt: '2026-08-23T00:00:02.000Z', evidenceRefs: ['failure:resource'],
          failure: {
            code: 'resource.unavailable', origin: 'atomic', stage: 'executing', category: 'resource',
            retryable: true, ownerActionable: false, evidenceRefs: ['failure:resource'],
          },
        }; },
      },
      verification: {
        verifyTask() { return { ok: false, detail: 'pending', evidenceRefs: [] }; },
        verifyRoot() { return { ok: false, detail: 'pending', evidenceRefs: [] }; },
      },
    },
  });
  try {
    const initial = createGoalAgentState({
      sessionId: 'goal-recovery-budget', interactionSessionId: 'interaction-recovery-budget', request: request(),
      budget: { maxRecoveries: 1 },
    });
    loop.create(initial);
    const failed = await loop.run(initial.sessionId, { maxRounds: 8 });
    assert.equal(failed.terminal?.outcome, 'failed');
    assert.equal(failed.budget.recoveries, 1);
    assert.match(failed.terminal?.summary ?? '', /recovery budget exhausted/);
  } finally {
    loop.dispose();
    store.close();
  }
});
