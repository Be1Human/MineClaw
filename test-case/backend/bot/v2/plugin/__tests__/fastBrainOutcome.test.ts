import test from 'node:test';
import assert from 'node:assert/strict';
import { createFastBrainOutcomeVerifier, type FastBrainOutcomeSource } from '../../../../../../apps/minecraft-companion/src/bot/v2/plugins/builtin/fastbrain/outcome.js';
import { FastBrainAdapter, type DecisionContext } from '../../../../../../apps/minecraft-companion/src/bot/v2/plugins/builtin/fastbrain/adapter.js';
import { createGoalAgentState, type GoalAgentStateV1 } from '../../../../../../apps/minecraft-companion/src/bot/v2/task/goalAgent/goalAgentState.js';
import { GoalAgentProductionVerificationPort } from '../../../../../../apps/minecraft-companion/src/bot/v2/task/goalAgent/production/goalAgentProductionPorts.js';
import { formalizeState } from '../../task/goalAgent/__tests__/goalTestFixtures.js';
import type { WorldStateView } from '../../../../../../apps/minecraft-companion/src/bot/v2/types.js';
import type { GoalSuccessCriterion } from '../../../../../../apps/minecraft-companion/src/bot/v2/task/contracts/goalTypes.js';

function context(overrides: Partial<DecisionContext> = {}): DecisionContext {
  return { requestId: 'task-request', sessionId: 'task-session', actor: 'bot', dimension: 'overworld',
    notBefore: 100, deadlineAt: 200, signal: new AbortController().signal, isCurrent: () => true, ...overrides };
}

function world(count = 1): WorldStateView {
  return {
    tick: 1, timestamp: 100,
    self: { position: { x: 0, y: 64, z: 0 }, yaw: 0, pitch: 0, health: 20, maxHealth: 20, food: 20, isOnGround: true },
    owner: null, entities: [], taskContext: null,
    environment: { dimension: 'overworld', timeOfDay: 0, isDay: true, isRaining: false },
    inventory: { items: [{ name: 'stone_axe', count, slot: 36 }], held: null, freeSlots: 35 },
  };
}

function state(criteria?: GoalSuccessCriterion[]): GoalAgentStateV1 {
  const value = createGoalAgentState({ sessionId: 'task-session', interactionSessionId: 'interaction',
    now: new Date(50).toISOString(), request: {
      meta: { schemaVersion: 2, sessionId: 'interaction', messageId: 'task-request', correlationId: 'correlation',
        conversationId: 'conversation', sequence: 1, emittedAt: new Date(50).toISOString(), idempotencyKey: 'request-key' },
      origin: 'player_message', originalText: '获得一把石斧', requestText: '获得一把石斧', requestKind: 'task', constraints: [],
    } });
  value.world.latest = world(0);
  value.phase = 'running';
  return formalizeState(value, criteria);
}

function source(value = state(), overrides: Partial<FastBrainOutcomeSource> = {}): FastBrainOutcomeSource {
  const production = new GoalAgentProductionVerificationPort(() => []);
  return { read: id => id === value.sessionId ? value : null,
    verifyRoot: input => production.verifyRoot(input), getWorld: () => world(), getActor: () => 'bot', ...overrides };
}

test('finish uses the existing production criteria verifier with fresh world and does not mutate task state', async () => {
  const original = state();
  const before = structuredClone(original);
  const verifier = createFastBrainOutcomeVerifier(source(original), () => 100);
  const result = await verifier.verify({ type: 'finish', evidence_refs: ['policy:invented'] }, context());
  assert.equal(result.verdict, 'completed');
  assert.deepEqual(result.evidenceRefs, ['criterion:inventory:stone_axe:1']);
  assert.deepEqual(original, before);
  assert.doesNotMatch(JSON.stringify(result), /policy:invented/);
});

test('adapter receipts expose independent completion and retain unproven blockage as unknown', async () => {
  const verifier = createFastBrainOutcomeVerifier(source(), () => 100);
  const adapter = new FastBrainAdapter({ isActive: () => true, now: () => 100, verifier });
  const completed = await adapter.submit({ type: 'finish', evidence_refs: ['policy:invented'] }, context());
  assert.equal(completed.status, 'success');
  assert.deepEqual(completed.outcome, { verdict: 'completed' });
  assert.deepEqual(completed.evidenceRefs, ['criterion:inventory:stone_axe:1']);

  const unavailable = new FastBrainAdapter({ isActive: () => true, now: () => 100,
    verifier: createFastBrainOutcomeVerifier(source(state(), { getWorld: () => world(0) }), () => 100) });
  const blocked = await unavailable.submit({ type: 'report_blocked', reason: 'missing_material', evidence_refs: ['policy:invented'] }, context());
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.reason, 'outcome_unverified');
  assert.equal(blocked.effectKnowledge, 'unknown');
  assert.deepEqual(blocked.outcome, { verdict: 'unknown' });
  assert.deepEqual(blocked.evidenceRefs, []);
});

test('actual unsatisfied criteria reject finish even when policy or stored model verdict says completed', async () => {
  const value = state();
  value.verdict = { decision: 'complete', summary: 'claimed done', machineCriteriaSatisfied: true,
    ownerActionable: false, retryable: false, evidenceRefs: ['model:self-report'] };
  const verifier = createFastBrainOutcomeVerifier(source(value, { getWorld: () => world(0) }), () => 100);
  assert.deepEqual(await verifier.verify({ type: 'finish', evidence_refs: ['criterion:inventory:stone_axe:1'] }, context()),
    { verdict: 'rejected', evidenceRefs: [] });
});

test('report_blocked never promotes failed actions, model reasons or unsatisfied criteria to correct blockage', async () => {
  const value = state();
  value.phase = 'failed';
  value.action.result = { executionSessionId: 'execution', idempotencyKey: 'action', ok: false, detail: 'no path',
    startedAt: new Date(99).toISOString(), completedAt: new Date(100).toISOString(), evidenceRefs: ['action:failure'],
    failure: { code: 'no_path', origin: 'navigation', stage: 'executing', category: 'navigation',
      retryable: false, ownerActionable: false, evidenceRefs: ['action:failure'] } };
  const verifier = createFastBrainOutcomeVerifier(source(value, { getWorld: () => world(0) }), () => 100);
  assert.deepEqual(await verifier.verify({ type: 'report_blocked', reason: 'no_path', evidence_refs: ['action:failure'] }, context()),
    { verdict: 'unknown', evidenceRefs: [] });
  const completed = createFastBrainOutcomeVerifier(source(value), () => 100);
  assert.equal((await completed.verify({ type: 'report_blocked', reason: 'no_path' }, context())).verdict, 'rejected');
});

test('missing task source and missing root goals remain unknown, not an empty successful task', async () => {
  for (const read of [() => null, () => ({ ...state(), rootGoal: null })]) {
    const verifier = createFastBrainOutcomeVerifier(source(state(), { read }), () => 100);
    assert.deepEqual(await verifier.verify({ type: 'finish', evidence_refs: ['forged'] }, context()),
      { verdict: 'unknown', evidenceRefs: [] });
  }
});

test('exact task request, session, actor and dimension bindings cannot be substituted', async () => {
  let verifications = 0;
  const base = source(state(), { verifyRoot: () => { verifications++; throw new Error('must_not_verify'); } });
  for (const overrides of [{ requestId: 'other-action' }, { actor: 'other-bot' }, { dimension: 'the_nether' }]) {
    const verifier = createFastBrainOutcomeVerifier(base, () => 100);
    assert.equal((await verifier.verify({ type: 'finish' }, context(overrides))).verdict, 'rejected');
  }
  const wrongSession = createFastBrainOutcomeVerifier({ ...base, read: () => ({ ...state(), sessionId: 'other-session' }) }, () => 100);
  assert.equal((await wrongSession.verify({ type: 'finish' }, context())).verdict, 'rejected');
  assert.equal(verifications, 0);
});

test('finish cannot revive an already failed, cancelled or timed-out task', async () => {
  for (const phase of ['failed', 'cancelled', 'timed_out'] as const) {
    const value = state();
    value.phase = phase;
    const verifier = createFastBrainOutcomeVerifier(source(value, {
      verifyRoot: () => { throw new Error('terminal_task_must_not_be_reopened'); },
    }), () => 100);
    assert.equal((await verifier.verify({ type: 'finish' }, context())).verdict, 'rejected');
  }
});

test('stale, future, wrong-world and missing current observations cannot complete a task', async () => {
  let verifications = 0;
  const values = [null, { ...world(), timestamp: 99 }, { ...world(), timestamp: 101 },
    { ...world(), environment: { ...world().environment, dimension: 'the_nether' } }];
  for (const value of values) {
    const verifier = createFastBrainOutcomeVerifier(source(state(), {
      getWorld: () => value, verifyRoot: () => { verifications++; throw new Error('must_not_verify'); },
    }), () => 100);
    assert.equal((await verifier.verify({ type: 'finish' }, context())).verdict, 'unknown');
  }
  assert.equal(verifications, 0);
});

test('unavailable or inconsistent verifier evidence never becomes completion', async () => {
  for (const result of [
    { ok: false, status: 'unknown' as const, detail: 'provider missing', evidenceRefs: [] },
    { ok: true, status: 'satisfied' as const, detail: 'no evidence', evidenceRefs: [] },
    { ok: true, status: 'unsatisfied' as const, detail: 'contradiction', evidenceRefs: ['fake'] },
    { ok: true, detail: 'old boolean is not three-state evidence', evidenceRefs: ['fake'] },
  ]) {
    const verifier = createFastBrainOutcomeVerifier(source(state(), { verifyRoot: () => result }), () => 100);
    assert.equal((await verifier.verify({ type: 'finish' }, context())).verdict, 'unknown');
  }
});

test('an unsupported source-sensitive predicate is not replaced by inventory counting', async () => {
  const value = state([{ type: 'predicate', predicate: 'logs.newly_acquired', predicateVersion: '1.0.0', args: { count: 1 } }]);
  const verifier = createFastBrainOutcomeVerifier(source(value), () => 100);
  assert.equal((await verifier.verify({ type: 'finish' }, context())).verdict, 'unknown');
});

test('cancelled, expired and revoked contexts do not read task state or verify', async () => {
  let reads = 0;
  const verifier = createFastBrainOutcomeVerifier(source(state(), { read: () => { reads++; return state(); } }), () => 100);
  for (const overrides of [{ signal: AbortSignal.abort() }, { deadlineAt: 100 }, { isCurrent: () => false }]) {
    assert.equal((await verifier.verify({ type: 'finish' }, context(overrides))).verdict, 'unknown');
  }
  assert.equal(reads, 0);
});

test('late verification cannot settle a cancelled or rebound task', async () => {
  const value = state();
  let finish!: () => void;
  const abort = new AbortController();
  const verifier = createFastBrainOutcomeVerifier(source(value, { verifyRoot: () => new Promise(resolve => {
    finish = () => resolve({ ok: true, status: 'satisfied', detail: 'verified', evidenceRefs: ['independent:1'] });
  }) }), () => 100);
  const pending = verifier.verify({ type: 'finish' }, context({ signal: abort.signal }));
  abort.abort();
  finish();
  assert.equal((await pending).verdict, 'unknown');

  const rebound = createFastBrainOutcomeVerifier(source(value, { verifyRoot: async () => {
    value.epoch++;
    return { ok: true, status: 'satisfied', detail: 'verified old epoch', evidenceRefs: ['old:epoch'] };
  } }), () => 100);
  assert.equal((await rebound.verify({ type: 'finish' }, context())).verdict, 'unknown');
});

test('independent verification errors surface through the adapter as error, not as a blocked-training label', async () => {
  const verifier = createFastBrainOutcomeVerifier(source(state(), { verifyRoot: async () => { throw new Error('private-source-failed'); } }), () => 100);
  const adapter = new FastBrainAdapter({ isActive: () => true, now: () => 100, verifier });
  const receipt = await adapter.submit({ type: 'finish' }, context());
  assert.equal(receipt.status, 'error');
  assert.equal(receipt.effectKnowledge, 'unknown');
  assert.equal(receipt.outcome, undefined);
  assert.doesNotMatch(JSON.stringify(receipt), /private-source-failed/);
});
