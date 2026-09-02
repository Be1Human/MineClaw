import assert from 'node:assert/strict';
import { test, beforeEach, afterEach } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GoalProgressGuard, goalProgress } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/goalAgent/goalProgressGuard.js';
import { GoalAgent } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/goalAgent/goalAgent.js';
import { GoalAgentRoundLoop } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/goalAgent/goalAgentRoundLoop.js';
import { GoalAgentModelRuntime } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/goalAgent/goalAgentModelRuntime.js';
import { GoalAgentSessionStore } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/goalAgent/goalAgentSessionStore.js';
import { createGoalAgentState } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/goalAgent/goalAgentState.js';
import type { GoalAgentStateV1 } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/goalAgent/goalAgentState.js';
import { InMemoryGoalKnowledgePort } from '../../../../../../../apps/minecraft-companion/src/bot/v2/knowledge/goalTargetKnowledge.js';
import { GoalAgentProductionVerificationPort } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/goalAgent/production/goalAgentProductionPorts.js';
import { __setTuningOverride } from '../../../../../../../apps/minecraft-companion/src/bot/v2/infra/tuning.js';
import type { GoalProgressGuidance } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/goalAgent/ports/goalProgressPort.js';
import type { WorldStateView } from '../../../../../../../apps/minecraft-companion/src/bot/v2/types.js';

beforeEach(() => __setTuningOverride({ goalProgress: { enabled: true, noProgressRounds: 2, recoveryRounds: 1, maxRecoveryAttempts: 1, waitPollMs: 100, maxWaitMs: 1000, maxWaitChecks: 10 } }));
afterEach(() => __setTuningOverride(null));

function fixture() {
  let now = Date.now(), stage = 0, observations = 0, calls = 0;
  let guidance: GoalProgressGuidance | null = null;
  const state = createGoalAgentState({ sessionId: 'progress-test', interactionSessionId: 'interaction', request: {
    meta: { schemaVersion: 2, sessionId: 'interaction', messageId: 'request', correlationId: 'correlation', conversationId: 'conversation', sequence: 1, emittedAt: new Date(now).toISOString(), idempotencyKey: 'request' },
    origin: 'player_message', originalText: '测试生长等待', requestText: '测试生长等待', requestKind: 'task', constraints: [],
  } });
  state.phase = 'running';
  state.rootGoal = { schema: 'mineclaw.goal/v1', goalId: 'goal', profileId: 'test', goalText: state.request.requestText, createdAt: new Date(now).toISOString(), successCriteria: [{ type: 'inventory', item: 'wheat', count: 1 }] };
  const world: WorldStateView = { tick: 1, timestamp: now, self: { position: { x: 0, y: 64, z: 0 }, yaw: 0, pitch: 0, health: 20, maxHealth: 20, food: 20, isOnGround: true }, owner: null,
    environment: { dimension: 'overworld', timeOfDay: 0, isDay: true, isRaining: false }, inventory: { items: [], held: null, freeSlots: 36 }, entities: [], taskContext: null };
  state.world.latest = structuredClone(world);
  const policy = { assess: () => guidance && guidance.kind === 'wait' ? { ...guidance, observedAt: now } : guidance,
    project: (value: typeof state) => ({ stage, tick: value.world.latest?.tick ?? 0, timestamp: value.world.latest?.timestamp ?? 0 }) };
  const tools = { progress: policy, perception: { observe: async () => { observations++; world.tick++; world.timestamp = now; return structuredClone(world); } }, verification: new GoalAgentProductionVerificationPort(() => []) };
  const loop = (store: GoalAgentSessionStore, kind = 'observe', events: string[] = []) => new GoalAgentRoundLoop({ store, profileId: 'test', tools,
    now: () => new Date(now).toISOString(), nowMs: () => now, maxRoundsPerRun: 1, publish: event => events.push(event.type),
    capabilities: { list: () => [], search: () => [], get: () => undefined },
    model: new GoalAgentModelRuntime({ callWithTools: async () => { calls++; return { content: '', toolCalls: [{ id: `call-${calls}`, name: kind === 'observe' ? 'world_observe' : 'capability_search', arguments: kind === 'observe' ? {} : { query: calls % 2 ? '种田' : '播种' } }] }; } }, { eventLog: store }),
  });
  return { state, world, tools, policy, loop, now: () => now, advance: (ms: number) => now += ms, stage: (value: number) => stage = value,
    guidance: (value: GoalProgressGuidance | null) => guidance = value,
    wait: () => guidance = { kind: 'wait', key: 'known-growth', reason: '已观察到支持的生长条件，等待下一次事实变化', observedAt: now, evidenceRefs: ['growth-observed'] },
    observations: () => observations, calls: () => calls };
}

test('U15: clocks, synonymous empty queries, plan revisions and failed actions do not count as progress', () => {
  const f = fixture(), guard = new GoalProgressGuard(f.policy);
  assert.equal(guard.afterRound(f.state, f.now(), 'catalog-1', false), null);
  f.state.world.latest!.tick++; f.state.world.latest!.timestamp++; f.state.plan.revision++;
  assert.equal(guard.afterRound(f.state, f.now(), 'catalog-1', false), 'bounded_recovery');
  f.state.action.result = { ok: false, detail: 'failed again', executionSessionId: 'failure', idempotencyKey: 'failure', startedAt: new Date(f.now()).toISOString(), completedAt: new Date(f.now()).toISOString(), evidenceRefs: [] };
  assert.equal(guard.afterRound(f.state, f.now(), 'catalog-1', true), 'no_validated_path_after_bounded_recovery');
  assert.equal(f.state.terminal?.outcome, 'failed');
  assert.equal(f.state.progress!.totalNoProgressRounds, 3);
  assert.equal(f.state.budget.recoveries, 1);
});

test('U15: a new relevant fact resets the streak, replaying old fact states cannot farm recovery budget', () => {
  const f = fixture(), guard = new GoalProgressGuard(f.policy);
  guard.afterRound(f.state, f.now(), 'same', false);
  f.stage(1); assert.equal(guard.afterRound(f.state, f.now(), 'same', false), 'meaningful_progress');
  assert.equal(f.state.progress!.noProgressRounds, 0);
  f.stage(0); guard.afterRound(f.state, f.now(), 'same', false);
  f.stage(1); assert.equal(guard.afterRound(f.state, f.now(), 'same', false), 'bounded_recovery');
});

test('U16: empty searches, used recovery and notification dedupe survive slices and real database reopen', async () => {
  __setTuningOverride({ goalProgress: { noProgressRounds: 3, recoveryRounds: 1, maxRecoveryAttempts: 1 }, goalAgent: { feedbackEmptySearchStreak: 1 } });
  const dir = mkdtempSync(join(tmpdir(), 'mineclaw-progress-')), db = join(dir, 'state.db'), f = fixture(), events: string[] = [];
  let store = new GoalAgentSessionStore(db), loop = f.loop(store, 'search', events);
  try {
    loop.create(f.state);
    await loop.run(f.state.sessionId); const before = await loop.run(f.state.sessionId);
    assert.equal(before.progress?.emptySearchStreak, 2);
    assert.equal(events.filter(value => value === 'goalagent.owner.feedback').length, 1);
    loop.dispose(); store.close();
    store = new GoalAgentSessionStore(db); loop = f.loop(store, 'search', events);
    const recovery = await loop.run(f.state.sessionId);
    assert.equal(recovery.progress?.mode, 'recovery');
    assert.equal(recovery.progress?.emptySearchStreak, 3);
    assert.equal(recovery.budget.recoveries, 1);
    const failed = await loop.run(f.state.sessionId);
    assert.equal(failed.terminal?.outcome, 'failed');
    assert.equal(failed.progress?.emptySearchStreak, 4);
    assert.equal(events.filter(value => value === 'goalagent.owner.feedback').length, 1);
  } finally { loop.dispose(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('U16: persisted progress and waiting budgets cannot be reset by a later checkpoint', () => {
  const f = fixture(), store = new GoalAgentSessionStore(':memory:');
  try {
    const p = goalProgress(f.state); p.rounds = 4; p.totalNoProgressRounds = 4; p.recoveryAttempts = 1; p.sentFeedbackKinds = ['blocked']; p.waitStartedAt = f.now();
    store.create(f.state);
    for (const mutate of [
      (s: any) => delete s.progress, (s: any) => s.progress.rounds = 0, (s: any) => s.progress.recoveryAttempts = 0,
      (s: any) => s.progress.sentFeedbackKinds = [], (s: any) => s.progress.waitStartedAt = null,
    ]) {
      const changed = structuredClone(f.state); changed.revision = 1; mutate(changed);
      assert.throws(() => store.commit({ expectedRevision: 0, expectedEpoch: 1, state: changed }), /cannot/);
    }
  } finally { store.close(); }
});

test('U17: known waiting uses bounded observation-only wakeups and a real semantic change resumes the model', async () => {
  const f = fixture(), store = new GoalAgentSessionStore(':memory:'), loop = f.loop(store); f.wait();
  try {
    loop.create(f.state); await loop.run(f.state.sessionId); let state = await loop.run(f.state.sessionId);
    assert.equal(state.progress?.mode, 'waiting_world');
    for (let index = 0; index < 5; index++) await loop.run(f.state.sessionId);
    assert.equal(f.calls(), 2); assert.equal(f.observations(), 2);
    f.advance(100); state = await loop.run(f.state.sessionId);
    assert.equal(state.progress?.waiting?.checks, 1); assert.equal(f.calls(), 2); assert.equal(f.observations(), 3);
    f.stage(1); f.advance(100); state = await loop.run(f.state.sessionId);
    assert.equal(state.progress?.waiting, null); assert.equal(f.calls(), 3);
    assert.equal(state.terminal, null);
  } finally { loop.dispose(); store.close(); }
});

test('U17: wait window expiry fails without another observation, and owner stop cancels a pending wait', async () => {
  for (const cancel of [false, true]) {
    const f = fixture(), store = new GoalAgentSessionStore(':memory:'), loop = f.loop(store); f.wait();
    try {
      loop.create(f.state); await loop.run(f.state.sessionId); await loop.run(f.state.sessionId);
      f.advance(1000);
      const state = cancel ? await loop.cancel(f.state.sessionId, 'stop') : await loop.run(f.state.sessionId);
      assert.equal(state.terminal?.outcome, cancel ? 'cancelled' : 'failed');
      assert.equal(state.progress?.waiting, null);
      assert.equal(f.calls(), 2); assert.equal(f.observations(), 2);
    } finally { loop.dispose(); store.close(); }
  }
});

test('U17: a hung wait observation can be cancelled; late data cannot revive or mutate the stored terminal', async () => {
  const f = fixture(), store = new GoalAgentSessionStore(':memory:'); f.wait();
  let started!: () => void, complete!: (world: WorldStateView) => void;
  const reading = new Promise<void>(resolve => { started = resolve; });
  const original = f.tools.perception.observe;
  f.tools.perception.observe = async () => f.observations() < 2 ? original() : new Promise<WorldStateView>(resolve => { complete = resolve; started(); });
  const loop = f.loop(store);
  try {
    loop.create(f.state); await loop.run(f.state.sessionId); await loop.run(f.state.sessionId);
    f.advance(100); const poll = loop.run(f.state.sessionId); await reading;
    const cancelled = await loop.cancel(f.state.sessionId, 'stop while observing'); await poll;
    assert.equal(cancelled.terminal?.outcome, 'cancelled'); assert.equal(cancelled.progress?.waiting, null);
    complete({ ...f.world, inventory: { ...f.world.inventory, items: [{ name: 'wheat', count: 1, slot: 0 }] } });
    await Promise.resolve(); await Promise.resolve();
    assert.deepEqual(store.get(f.state.sessionId), cancelled);
  } finally { loop.dispose(); store.close(); }
});

test('U18: code-evidenced owner choices pause, missing executors fail, and hot thresholds apply immediately', async () => {
  for (const kind of ['needs_owner', 'unsupported'] as const) {
    const f = fixture(), store = new GoalAgentSessionStore(':memory:'), loop = f.loop(store);
    f.guidance(kind === 'needs_owner' ? { kind, reason: 'two_fields', question: '你指的是左边还是右边这块田？', evidenceRefs: ['observed:two-fields'] }
      : { kind, reason: 'missing_executor:sow', evidenceRefs: ['catalog:sow:unavailable'] });
    try {
      loop.create(f.state); await loop.run(f.state.sessionId);
      __setTuningOverride({ goalProgress: { noProgressRounds: 1 } });
      const stopped = await loop.run(f.state.sessionId);
      assert.equal(stopped.phase, kind === 'needs_owner' ? 'paused_owner' : 'failed');
      if (kind === 'needs_owner') {
        const root = stopped.rootGoal, count = stopped.progress!.totalNoProgressRounds;
        const resumed = await loop.resumeOwner(f.state.sessionId, '左边');
        assert.deepEqual(resumed.rootGoal, root); assert.equal(resumed.progress?.totalNoProgressRounds, count);
      } else assert.match(stopped.terminal!.summary, /unsupported_capability:missing_executor/);
    } finally { loop.dispose(); store.close(); __setTuningOverride({ goalProgress: { noProgressRounds: 2 } }); }
  }
});

/** Exercise the actual submission/lifecycle API; the observer is the only fake world boundary. */
function submittedWaitAgent(observe?: (read: number, world: WorldStateView) => Promise<WorldStateView>) {
  __setTuningOverride({ goalProgress: { noProgressRounds: 2, waitPollMs: 50, maxWaitMs: 5000, maxWaitChecks: 50 } });
  const f = fixture(); f.wait();
  let calls = 0, reads = 0;
  const waiters: Array<{ matches: (state: Readonly<GoalAgentStateV1>) => boolean; resolve: (state: Readonly<GoalAgentStateV1>) => void }> = [];
  const agent = new GoalAgent({ profileId: 'wait-public-test', stateDbPath: ':memory:', maxRoundsPerRun: 1,
    modelClient: { callWithTools: async () => {
      calls++;
      return { content: '', toolCalls: calls === 1 ? [
        { id: 'select-wheat', name: 'goal_get_target', arguments: { registryId: 'minecraft:wheat' } },
        { id: 'create-wheat', name: 'goal_create', arguments: { outcome: 'obtain', target: { kind: 'item', surface: '小麦', registryId: 'minecraft:wheat', quantity: 1 } } },
        { id: 'observe-first', name: 'world_observe', arguments: {} },
      ] : [{ id: `observe-${calls}`, name: 'world_observe', arguments: {} }] };
    } },
    tools: { ...f.tools,
      progress: { ...f.policy, project: (state: Readonly<GoalAgentStateV1>) => ({ inventory: state.world.latest?.inventory.items ?? [] }) },
      knowledge: new InMemoryGoalKnowledgePort([{ kind: 'item', registryId: 'minecraft:wheat', aliases: ['小麦'], taskFamilies: ['agriculture'] }]),
      perception: { observe: async () => {
        reads++; f.world.timestamp = Date.now(); f.world.tick++;
        return observe ? observe(reads, structuredClone(f.world)) : structuredClone(f.world);
      } },
    },
    onState: state => {
      for (const waiter of [...waiters]) if (waiter.matches(state)) {
        waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(structuredClone(state));
      }
    },
  });
  const submitted = agent.submit(f.state.request);
  assert.equal(submitted.accepted, true);
  const sessionId = String(submitted.details!.sessionId);
  return { agent, sessionId, requestId: f.state.requestId, calls: () => calls, reads: () => reads,
    until: (matches: (state: Readonly<GoalAgentStateV1>) => boolean) => {
      const current = agent.snapshot(sessionId);
      if (current && matches(current)) return Promise.resolve(current);
      return new Promise<Readonly<GoalAgentStateV1>>(resolve => waiters.push({ matches, resolve }));
    },
  };
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('public GoalAgent lifecycle did not settle')), 8000);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

test('I04/A03: submit creates a real goal; waiting polls facts without model rounds and independently verifies completion', async () => {
  const f = submittedWaitAgent(async (read, world) => read >= 4
    ? { ...world, inventory: { ...world.inventory, items: [{ name: 'wheat', count: 1, slot: 0 }] } } : world);
  try {
    const waiting = await bounded(f.until(state => !!state.progress?.waiting || !!state.terminal));
    assert.equal(waiting.terminal, null);
    assert.equal(waiting.rootGoal?.successCriteria[0].type, 'inventory');
    assert.match(f.agent.inspect({ sessionId: f.sessionId, requestId: f.requestId }).stage, /^waiting_world:/);
    assert.equal(f.calls(), 2);
    const terminal = await bounded(f.until(state => !!state.terminal));
    assert.equal(terminal.terminal?.outcome, 'completed');
    assert.equal(f.calls(), 2); assert.equal(f.reads(), 4);
    await new Promise(resolve => setTimeout(resolve, 120));
    assert.equal(f.reads(), 4);
    assert.equal(f.agent.activeCount(), 0);
  } finally { f.agent.close(); }
});

test('A03: a relevant non-terminal fact resumes the model through the public production lifecycle', async () => {
  const f = submittedWaitAgent(async (read, world) => read < 3 ? world : {
    ...world, inventory: { ...world.inventory, items: [{ name: read === 3 ? 'wheat_seeds' : 'wheat', count: 1, slot: 0 }] },
  });
  try {
    const waiting = await bounded(f.until(state => !!state.progress?.waiting || !!state.terminal));
    assert.equal(waiting.terminal, null);
    assert.equal(f.calls(), 2);
    const terminal = await bounded(f.until(state => !!state.terminal));
    assert.equal(terminal.terminal?.outcome, 'completed');
    assert.equal(f.calls(), 3); assert.equal(f.reads(), 4);
    assert.equal(terminal.progress?.waiting, null);
  } finally { f.agent.close(); }
});

test('A03: public cancelRequest cancels an in-flight wait; late facts cannot revive or rewrite the terminal', async () => {
  let started!: () => void, complete!: (world: WorldStateView) => void, pendingWorld!: WorldStateView;
  const reading = new Promise<void>(resolve => { started = resolve; });
  const f = submittedWaitAgent(async (read, world) => read < 3 ? world : new Promise(resolve => {
    pendingWorld = world; complete = resolve; started();
  }));
  try {
    await bounded(reading);
    assert.equal(f.agent.cancelRequest(f.requestId, 'stop while observing'), true);
    const terminal = await bounded(f.until(state => !!state.terminal));
    assert.equal(terminal.terminal?.outcome, 'cancelled');
    assert.equal(terminal.progress?.waiting, null);
    const checkpoint = f.agent.snapshot(f.sessionId);
    complete({ ...pendingWorld, inventory: { ...pendingWorld.inventory, items: [{ name: 'wheat', count: 1, slot: 0 }] } });
    await new Promise(resolve => setTimeout(resolve, 120));
    assert.deepEqual(f.agent.snapshot(f.sessionId), checkpoint);
    assert.equal(f.calls(), 2); assert.equal(f.reads(), 3);
    assert.equal(f.agent.activeCount(), 0);
  } finally { f.agent.close(); }
});

test('A03: public close stops scheduled observations and rejects new submissions', async () => {
  const f = submittedWaitAgent();
  try {
    const waiting = await bounded(f.until(state => !!state.progress?.waiting || !!state.terminal));
    assert.equal(waiting.terminal, null);
    f.agent.close();
    const reads = f.reads(), calls = f.calls();
    await new Promise(resolve => setTimeout(resolve, 120));
    assert.equal(f.reads(), reads); assert.equal(f.calls(), calls);
    assert.deepEqual(f.agent.submit(waiting.request), { accepted: false, reason: 'goal_agent_closed' });
  } finally { f.agent.close(); }
});
