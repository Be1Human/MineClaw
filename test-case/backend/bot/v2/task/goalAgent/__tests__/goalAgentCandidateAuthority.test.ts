import assert from 'node:assert/strict';
import test from 'node:test';
import { GoalAgentCandidateAuthority, prepareCandidateArguments } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/goalAgent/goalAgentCandidateAuthority.js';
import { GoalAgentRoundToolRuntime } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/goalAgent/goalAgentRoundTools.js';
import { createGoalAgentState } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/goalAgent/goalAgentState.js';
import type { GoalAgentActionCandidate } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/goalAgent/ports/executionPort.js';

function state() {
  const value = createGoalAgentState({ sessionId: 'authority', interactionSessionId: 'interaction', request: {
    meta: { schemaVersion: 2, sessionId: 'interaction', messageId: 'request', correlationId: 'correlation', conversationId: 'conversation',
      sequence: 1, emittedAt: '2026-08-31T00:00:00.000Z', idempotencyKey: 'request' },
    origin: 'player_message', originalText: '做一把斧头', requestText: '做一把斧头', requestKind: 'task', constraints: [],
  } });
  value.rootGoal = { schema: 'mineclaw.goal/v1', goalId: 'root', profileId: 'test', goalText: '做一把斧头',
    createdAt: '2026-08-31T00:00:00.000Z', successCriteria: [{ type: 'inventory', item: 'stone_axe', count: 1 }] };
  return value;
}

function craft(): GoalAgentActionCandidate {
  return {
    id: 'task:craft', kind: 'task', source: 'registered_task', action: 'invoke_task', description: 'craft',
    fixedArgs: { taskKind: 'craft_item', params: { item: 'stone_axe', count: 1 } },
    mutableArgumentPaths: ['/params/item', '/params/count'],
    argumentSchema: { type: 'object', additionalProperties: false, required: ['taskKind', 'params'], properties: {
      taskKind: { type: 'string', enum: ['craft_item'] }, params: { type: 'object', additionalProperties: false,
        required: ['item', 'count'], properties: { item: { type: 'string', minLength: 1 }, count: { type: 'integer', minimum: 1 } } },
    } }, evidenceRefs: [],
  };
}

test('U13: identity, scope and unknown nested fields cannot be replaced', () => {
  const candidate = craft();
  for (const patch of [
    { taskKind: 'gather_material' }, { behavior: 'combat' }, { strategyId: 'other' }, { version: 2 },
    { params: { executor: { id: 'dig' } } }, { params: { unknown: true } },
    { params: [] }, { params: { count: '2' } }, { params: { count: -1 } }, { params: { count: 1.5 } },
    JSON.parse('{"params":{"__proto__":{"admin":true}}}'), null, [],
  ]) assert.throws(() => prepareCandidateArguments(candidate, patch));
  const spatial: GoalAgentActionCandidate = { ...candidate, action: 'invoke_behavior',
    fixedArgs: { behavior: 'withdraw_from_chest', behaviorParams: { chestPos: { x: 1, y: 64, z: 2 }, count: 1 } },
    argumentSchema: undefined, mutableArgumentPaths: [] };
  assert.throws(() => prepareCandidateArguments(spatial, { behaviorParams: { chestPos: { x: 5 } } }), /locked/);
  assert.deepEqual(prepareCandidateArguments(spatial, {}), spatial.fixedArgs);
});

test('U14: intermediate crafting business fields merge deeply without changing identity or root', () => {
  const candidate = craft();
  assert.deepEqual(prepareCandidateArguments(candidate, { params: { item: 'stick', count: 2 } }), {
    taskKind: 'craft_item', params: { item: 'stick', count: 2 },
  });
  assert.deepEqual(prepareCandidateArguments(candidate, { params: { count: 3 } }), {
    taskKind: 'craft_item', params: { item: 'stone_axe', count: 3 },
  });
  assert.equal((candidate.fixedArgs.params as { item: string }).item, 'stone_axe');
  const maliciousPolicy = { ...candidate, mutableArgumentPaths: ['/taskKind'] };
  assert.throws(() => prepareCandidateArguments(maliciousPolicy, { taskKind: 'gather_material' }), /identity_locked/);
});

test('U13: final merged arguments are validated, including malformed fixed arguments and unsupported schemas', () => {
  const invalid = craft(); invalid.fixedArgs = { ...invalid.fixedArgs, unknown: true };
  assert.throws(() => prepareCandidateArguments(invalid, {}), /unknown_field/);
  const invalidSchema = craft(); invalidSchema.argumentSchema = { ...invalidSchema.argumentSchema, $ref: 'remote' };
  assert.throws(() => prepareCandidateArguments(invalidSchema, {}), /unsupported_argument_schema/);
  const missing = craft(); missing.fixedArgs = { taskKind: 'craft_item', params: { item: 'stick' } };
  assert.throws(() => prepareCandidateArguments(missing, {}), /required/);
});

test('U14: grants bind session, epoch, plan, node, catalog, operation version and runtime incarnation', () => {
  const authority = new GoalAgentCandidateAuthority(), initial = state(), candidate = craft();
  candidate.operationRef = { id: 'craft.item', version: 1 };
  const handle = authority.issue(candidate, initial, 'catalog-1');
  assert.equal(authority.candidateId(handle), candidate.id);
  assert.equal(authority.matches(handle, candidate, initial, 'catalog-1'), true);
  for (const mutate of [
    (s: ReturnType<typeof state>) => { s.sessionId = 'other'; },
    (s: ReturnType<typeof state>) => { s.epoch += 1; },
    (s: ReturnType<typeof state>) => { s.plan.revision += 1; },
    (s: ReturnType<typeof state>) => { s.plan.activeNodeId = 'other'; },
    (s: ReturnType<typeof state>) => { s.budget.actions += 1; },
  ]) { const changed = structuredClone(initial); mutate(changed); assert.equal(authority.matches(handle, candidate, changed, 'catalog-1'), false); }
  assert.equal(authority.matches(handle, candidate, initial, 'catalog-2'), false);
  assert.equal(authority.matches(handle, { ...candidate, operationRef: { id: 'craft.item', version: 2 } }, initial, 'catalog-1'), false);
  assert.equal(new GoalAgentCandidateAuthority().matches(handle, candidate, initial, 'catalog-1'), false);
  assert.equal(authority.matches(`${handle.slice(0, -1)}!`, candidate, initial, 'catalog-1'), false);
});

function harness() {
  let candidate = craft();
  const shared = state(); let executions = 0; let dispatched: unknown;
  const runtime = new GoalAgentRoundToolRuntime({ profileId: 'test', tools: { execution: {
    listCandidates: () => [candidate],
    async execute(input) { executions += 1; dispatched = input.proposal; return {
      executionSessionId: 'execution', idempotencyKey: input.idempotencyKey, ok: true, detail: 'crafted',
      startedAt: '2026-08-31T00:00:00.000Z', completedAt: '2026-08-31T00:00:01.000Z', evidenceRefs: [],
    }; },
  } } });
  const call = (name: string, args: Record<string, unknown> = {}) => runtime.execute({ id: name, name, arguments: args }, shared, new AbortController().signal);
  const list = async () => (await call('action_list', { includeUnavailable: true })).content.candidates as Array<{ candidateHandle: string; authorization: { status: string; reasons: string[] } }>;
  return { shared, call, list, replace: (value: GoalAgentActionCandidate) => { candidate = value; }, counts: () => ({ executions, dispatched }) };
}

test('I02: only issued handles execute; illegal arguments do not consume an action or mutate the root', async () => {
  const h = harness();
  assert.equal((await h.call('action_execute', { candidateId: 'task:craft' })).content.ok, false);
  const root = structuredClone(h.shared.rootGoal), [{ candidateHandle }] = await h.list();
  assert.equal((await h.call('action_execute', { candidateHandle, arguments: { taskKind: 'other' } })).content.ok, false);
  assert.equal(h.counts().executions, 0); assert.equal(h.shared.budget.actions, 0);
  assert.equal((await h.call('action_execute', { candidateHandle, arguments: { params: { item: 'stick', count: 2 } } })).content.ok, true);
  assert.equal(h.counts().executions, 1); assert.deepEqual(h.shared.rootGoal, root);
  assert.equal((await h.call('action_execute', { candidateHandle })).content.ok, false);
  assert.equal(h.counts().executions, 1);
});

test('U12/I02: blocked candidates expose missing resources, refuse execution, and require refreshed authorization', async () => {
  const h = harness(), blocked = craft(); blocked.authorization = { status: 'blocked', reasons: ['missing_resources:stick'] };
  h.replace(blocked);
  const [listed] = await h.list();
  assert.deepEqual(listed.authorization, blocked.authorization);
  assert.match(String((await h.call('action_execute', { candidateHandle: listed.candidateHandle })).content.error), /not_authorized/);
  h.replace(craft());
  assert.match(String((await h.call('action_execute', { candidateHandle: listed.candidateHandle })).content.error), /stale/);
  const [fresh] = await h.list();
  assert.equal((await h.call('action_execute', { candidateHandle: fresh.candidateHandle })).content.ok, true);
  assert.equal(h.counts().executions, 1);
});

test('I02: changed binding, plan or terminal state rejects before dispatch', async () => {
  for (const change of ['binding', 'epoch', 'plan', 'paused'] as const) {
    const h = harness(), [listed] = await h.list();
    if (change === 'binding') { const changed = craft(); changed.fixedArgs.params = { item: 'diamond_axe', count: 1 }; h.replace(changed); }
    else if (change === 'epoch') h.shared.epoch += 1;
    else if (change === 'plan') h.shared.plan.revision += 1;
    else h.shared.phase = 'paused_owner';
    assert.equal((await h.call('action_execute', { candidateHandle: listed.candidateHandle })).content.ok, false);
    assert.equal(h.counts().executions, 0);
  }
});
