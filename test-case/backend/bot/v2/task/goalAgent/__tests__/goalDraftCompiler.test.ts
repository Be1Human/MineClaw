import assert from 'node:assert/strict';
import { test, beforeEach, afterEach } from 'node:test';
import { GoalDraftCompiler } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/goalAgent/goalDraftCompiler.js';
import { GoalAgentRoundToolRuntime } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/goalAgent/goalAgentRoundTools.js';
import { GoalAgentRoundLoop } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/goalAgent/goalAgentRoundLoop.js';
import { GoalAgentSessionStore } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/goalAgent/goalAgentSessionStore.js';
import { GoalAgentContextCompiler } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/goalAgent/goalAgentContextCompiler.js';
import { createGoalAgentState, assertGoalAgentStateV1, GOAL_AGENT_STATE_SCHEMA_V1, GOAL_AGENT_STATE_SCHEMA_V2 } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/goalAgent/goalAgentState.js';
import { assertGoalContractV1 } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/contracts/goalContract.js';
import { freezeGoalContractV2 } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/contracts/goalContractV2.js';
import { __setTuningOverride } from '../../../../../../../apps/minecraft-companion/src/bot/v2/infra/tuning.js';
import type { GoalDraft, GoalScopeBinding } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/contracts/goalDraft.js';
import type { GoalPredicateEvaluator } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/goalRunner/goalCriteriaEvaluator.js';
import type { WorldStateView } from '../../../../../../../apps/minecraft-companion/src/bot/v2/types.js';

beforeEach(() => __setTuningOverride({ goalComposition: { enabled: true } }));
afterEach(() => __setTuningOverride(null));

function fixture() {
  const now = Date.now(), acceptedAt = new Date(now).toISOString();
  const state = createGoalAgentState({ sessionId: 'draft-session', interactionSessionId: 'interaction', request: {
    meta: { schemaVersion: 2, sessionId: 'interaction', messageId: 'request', correlationId: 'correlation', conversationId: 'conversation',
      sequence: 1, emittedAt: acceptedAt, idempotencyKey: 'request' },
    origin: 'player_message', originalText: '把这个田种一下', requestText: '把这个田种一下', requestKind: 'task', constraints: ['仅已有耕地'],
  } });
  state.world.latest = { tick: 1, timestamp: now, self: { position: { x: 0, y: 64, z: 0 }, yaw: 0, pitch: 0, health: 20, maxHealth: 20, food: 20, isOnGround: true },
    owner: null, environment: { dimension: 'overworld', timeOfDay: 1000, isDay: true, isRaining: false },
    entities: [], inventory: { items: [], held: null, freeSlots: 36 }, taskContext: null } satisfies WorldStateView;
  const ref = { id: 'test.crop_present', version: '1', args: { fieldRef: 'field:one', count: 4 } };
  const binding: GoalScopeBinding = { id: 'field:one', version: 'geometry-1', kind: 'region', summary: 'confirmed field',
    dimension: 'overworld', region: { min: { x: 1, y: 64, z: 1 }, max: { x: 2, y: 64, z: 2 } },
    mutationAllowed: true, required: true, requiredPredicates: [ref], evidenceRefs: ['field:confirmed'] };
  const predicate: GoalPredicateEvaluator = { id: ref.id, version: ref.version,
    argumentSchema: { type: 'object', additionalProperties: false, required: ['fieldRef', 'count'], properties: {
      fieldRef: { type: 'string', minLength: 1 }, count: { type: 'integer', minimum: 1 },
    } }, evaluate: () => ({ status: 'unknown', detail: 'not verified' }) };
  const draft: GoalDraft = { schema: 'mineclaw.goal-draft/v1', requestRef: state.requestId,
    success: { allOf: [ref] }, scope: { dimension: 'overworld', targetRefs: [binding.id], allowedMutationRegion: binding.region } };
  const compiler = new GoalDraftCompiler({ predicates: () => [predicate], bindings: () => [binding] });
  const compile = (value: unknown = draft) => compiler.compile({ draft: value, state, profileId: 'test', goalId: 'goal-1', acceptedAt });
  return { state, draft, binding, predicate, compiler, compile, acceptedAt };
}

test('U05: a registered predicate and observed binding compile without any target template', () => {
  const f = fixture(), result = f.compile();
  assert.equal(result.rootGoal.schema, 'mineclaw.goal/v2');
  assert.equal(result.rootGoal.goalText, f.state.request.originalText);
  assert.deepEqual(result.rootGoal.scope.allowedMutationRegion, f.binding.region);
  assert.equal(result.rootGoal.successCriteria[0]!.args!.count, 4);
  assert.equal(result.rootGoal.successCriteria[0]!.predicateVersion, '1');
  assert.equal(result.signature.schemaVersion, 2);
  assert.equal(result.goal.outcome, 'composed');
  assert.ok(Object.isFrozen(result.rootGoal.scope.bindings[0]));
  assert.throws(() => { (result.rootGoal.successCriteria[0]!.args as any).count = 1; });
});

test('U06: malformed drafts, unknown predicates, unbound targets and narrowed/expanded scopes reject without mutation', () => {
  const f = fixture();
  const variants = [
    { ...f.draft, script: 'dig()' }, { ...f.draft, requestRef: 'other' },
    { ...f.draft, success: { allOf: [] } }, { ...f.draft, success: { allOf: [{ id: 'unknown', version: '1', args: {} }] } },
    { ...f.draft, success: { allOf: [{ ...f.draft.success.allOf[0], version: '2' }] } },
    { ...f.draft, success: { allOf: [{ ...f.draft.success.allOf[0], args: { fieldRef: 'field:one', count: 1 } }] } },
    { ...f.draft, success: { allOf: [{ ...f.draft.success.allOf[0], args: { fieldRef: 'field:one', count: -1 } }] } },
    { ...f.draft, scope: { dimension: 'the_nether', targetRefs: ['field:one'] } },
    { ...f.draft, scope: { dimension: 'overworld', targetRefs: ['invented'] } },
    { ...f.draft, scope: { ...f.draft.scope, allowedMutationRegion: { ...f.binding.region!, max: { x: 99, y: 64, z: 99 } } } },
    { ...f.draft, scope: { ...f.draft.scope, allowedMutationRegion: { ...f.binding.region!, max: { x: 1, y: 64, z: 1 } } } },
  ];
  for (const invalid of variants) assert.throws(() => f.compile(invalid));
  assert.equal(f.state.rootGoal, null);
  assert.equal(f.state.budget.actions, 0);
});

test('U06: stale world, duplicate targets, missing required predicates and runtime limits fail closed', () => {
  const f = fixture();
  assert.throws(() => f.compile({ ...f.draft, scope: { ...f.draft.scope, targetRefs: ['field:one', 'field:one'] } }), /duplicate/);
  f.state.world.latest!.timestamp -= 6000;
  assert.throws(() => f.compile(), /fresh_world/);
  f.state.world.latest!.timestamp += 6000;
  __setTuningOverride({ goalComposition: { enabled: true, maxRegionVolume: 1 } });
  assert.throws(() => f.compile(), /region_limit/);
  __setTuningOverride({ goalComposition: { enabled: true, maxDraftBytes: 1 } });
  assert.throws(() => f.compile(), /size_limit/);
  __setTuningOverride({ goalComposition: { enabled: true, maxTargets: -1 } });
  assert.throws(() => f.compile(), /invalid_goal_composition_limits/);
});

test('U05: root signature covers binding geometry/version and not the acceptedAt baseline', () => {
  const f = fixture(), initial = f.compile();
  const later = f.compiler.compile({ draft: f.draft, state: f.state, profileId: 'test', goalId: 'goal-2', acceptedAt: new Date(Date.parse(f.acceptedAt) + 1).toISOString() });
  assert.equal(later.signature.key, initial.signature.key);
  const changed = new GoalDraftCompiler({ predicates: () => [f.predicate], bindings: () => [{ ...f.binding, version: 'geometry-2' }] });
  assert.notEqual(changed.compile({ draft: f.draft, state: f.state, profileId: 'test', goalId: 'goal-3', acceptedAt: f.acceptedAt }).signature.key, initial.signature.key);
});

test('U05/U08: goal_create composed mode uses the real port, bumps state schema and remains idempotent', async () => {
  const f = fixture();
  const runtime = new GoalAgentRoundToolRuntime({ profileId: 'test', tools: { goals: f.compiler }, now: () => f.acceptedAt });
  const call = (args: Record<string, unknown>) => runtime.execute({ id: 'create', name: 'goal_create', arguments: args }, f.state, new AbortController().signal);
  assert.equal((await call({ mode: 'composed', draft: f.draft })).content.ok, true);
  assert.equal(f.state.schema, GOAL_AGENT_STATE_SCHEMA_V2);
  assertGoalAgentStateV1(f.state);
  const committed = structuredClone(f.state.rootGoal);
  assert.equal((await call({ mode: 'composed', draft: { broken: true } })).content.alreadyCreated, true);
  assert.deepEqual(f.state.rootGoal, committed);
  assert.throws(() => assertGoalContractV1(f.state.rootGoal as never), /unsupported goal schema/);
  assert.throws(() => assertGoalAgentStateV1({ ...f.state, schema: GOAL_AGENT_STATE_SCHEMA_V1 }), /requires_state_v2/);
});

test('U08: store preserves v2 contract and rejects rewritten roots, downgrade and reinterpretation of an active v1 goal', async () => {
  const f = fixture(), store = new GoalAgentSessionStore(':memory:');
  try {
    store.create(f.state);
    const compiled = f.compile(), next = structuredClone(f.state);
    next.schema = GOAL_AGENT_STATE_SCHEMA_V2; next.rootGoal = compiled.rootGoal;
    next.goal.definition = compiled.goal; next.goal.signature = compiled.signature; next.revision = 1;
    const saved = store.commit({ expectedRevision: 0, expectedEpoch: 1, state: next });
    assert.deepEqual(store.get(saved.sessionId)!.rootGoal, compiled.rootGoal);
    const changed = structuredClone(saved); changed.revision = 2;
    changed.rootGoal = freezeGoalContractV2({ ...compiled.rootGoal, goalText: 'different goal' });
    assert.throws(() => store.commit({ expectedRevision: 1, expectedEpoch: 1, state: changed }), /immutable/);
    const downgrade = structuredClone(saved); downgrade.revision = 2; downgrade.schema = GOAL_AGENT_STATE_SCHEMA_V1;
    assert.throws(() => store.commit({ expectedRevision: 1, expectedEpoch: 1, state: downgrade }), /requires_state_v2/);
    const legacy = fixture().state; legacy.sessionId = 'legacy'; legacy.rootGoal = {
      schema: 'mineclaw.goal/v1', goalId: 'v1', profileId: 'test', goalText: 'old root', createdAt: f.acceptedAt,
      successCriteria: [{ type: 'inventory', item: 'stick', count: 1 }],
    }; store.create(legacy);
    const reinterpreted = structuredClone(legacy); reinterpreted.schema = GOAL_AGENT_STATE_SCHEMA_V2; reinterpreted.rootGoal = compiled.rootGoal; reinterpreted.revision = 1;
    assert.throws(() => store.commit({ expectedRevision: 0, expectedEpoch: 1, state: reinterpreted }), /cannot_be_reinterpreted/);
  } finally { store.close(); }
});

test('U08: disabling new composed goals does not prevent cancelling a stored v2 session', async () => {
  const f = fixture(), compiled = f.compile();
  f.state.schema = GOAL_AGENT_STATE_SCHEMA_V2; f.state.rootGoal = compiled.rootGoal;
  f.state.goal.definition = compiled.goal; f.state.goal.signature = compiled.signature;
  const store = new GoalAgentSessionStore(':memory:');
  const loop = new GoalAgentRoundLoop({ profileId: 'test', store, model: { invoke: async () => { throw new Error('cancel must not invoke model'); } } });
  try {
    loop.create(f.state);
    __setTuningOverride({ goalComposition: { enabled: false } });
    assert.throws(() => fixture().compile(), /disabled/);
    const cancelled = await loop.cancel(f.state.sessionId, 'owner stopped');
    assert.equal(cancelled.terminal?.outcome, 'cancelled');
    assert.equal(cancelled.rootGoal?.schema, 'mineclaw.goal/v2');
    assert.equal(store.getActive(cancelled.sessionId), null);
  } finally { loop.dispose(); store.close(); }
});

test('U05: world_observe exposes code bindings, and the committed scope survives history compaction', async () => {
  const f = fixture();
  const runtime = new GoalAgentRoundToolRuntime({ profileId: 'test', now: () => f.acceptedAt,
    tools: { goals: f.compiler, perception: { observe: async () => structuredClone(f.state.world.latest!) } } });
  const observed = await runtime.execute({ id: 'observe', name: 'world_observe', arguments: {} }, f.state, new AbortController().signal);
  assert.equal(observed.content.requestRef, f.state.requestId);
  assert.deepEqual(observed.content.goalBindings, [f.binding]);
  assert.equal(observed.content.composedGoalsEnabled, true);
  const created = await runtime.execute({ id: 'create', name: 'goal_create', arguments: { mode: 'composed', draft: f.draft } }, f.state, new AbortController().signal);
  assert.equal(created.content.ok, true);
  const context = new GoalAgentContextCompiler({ maxHistoryCharacters: 2000 }).compile({ state: f.state, node: 'round', instruction: 'continue',
    historyMessages: [{ role: 'user', content: 'old'.repeat(1000) }] });
  const compacted = JSON.parse(context.compaction!.summary.split('\n').slice(1).join('\n'));
  assert.deepEqual(compacted.scope, (f.state.rootGoal as any).scope);
  assert.equal(compacted.goalSchema, 'mineclaw.goal/v2');
  assert.ok(context.messages.some(message => message.content.includes('Immutable composed goal:')));
});
