import test from 'node:test';
import assert from 'node:assert/strict';
import { FastBrainAdapter, type DecisionContext, type SelfObservation } from '../../../../../../apps/minecraft-companion/src/bot/v2/plugins/builtin/fastbrain/adapter.js';
import { fastBrainDecisionCatalog } from '../../../../../../apps/minecraft-companion/src/bot/v2/plugins/builtin/fastbrain/decisionContract.js';

function context(overrides: Partial<DecisionContext> = {}): DecisionContext {
  return { requestId: 'r1', sessionId: 's1', actor: 'bot', dimension: 'overworld',
    notBefore: 100, deadlineAt: 1000, signal: new AbortController().signal, isCurrent: () => true, ...overrides };
}
function observation(overrides: Partial<SelfObservation> = {}): SelfObservation {
  return { version: 'tick-1', observedAt: 100, actor: 'bot', dimension: 'overworld', scope: 'self_only',
    self: { position: { x: 1, y: 64, z: 2 } }, inventory: [{ name: 'oak_log', count: 1, slot: 36 }],
    targets: { status: 'unavailable', reason: 'visible_targets_contract_unavailable' }, evidenceRefs: ['world:tick:1'], ...overrides };
}
const observe = { type: 'call', skill: 'observe', args: {} };

test('fastbrain adapter publishes all eighteen schemas, independently of handler availability', () => {
  const adapter = new FastBrainAdapter({ isActive: () => true, now: () => 100, observeSelf: () => observation() });
  assert.deepEqual(adapter.catalog().map(x => [x.name, x.schema]), fastBrainDecisionCatalog().map(x => [x.name, x.schema]));
  assert.deepEqual(adapter.catalog().filter(x => x.available).map(x => x.name), ['observe']);
  const exposed = adapter.port() as unknown as Record<string, unknown>;
  assert.deepEqual(Object.keys(exposed).sort(), ['catalog', 'submit']);
  const first = adapter.catalog();
  first[0].schema.required = [];
  assert.notDeepEqual(adapter.catalog(), first);
});

test('observe returns identity-bound partial self observations, not a fully searched empty world', async () => {
  const source = observation();
  const adapter = new FastBrainAdapter({ isActive: () => true, now: () => 100, observeSelf: () => source });
  const result = await adapter.submit(observe, context());
  assert.equal(result.status, 'partial');
  assert.equal(result.requestId, 'r1');
  assert.equal(result.sessionId, 's1');
  assert.equal(result.decision, 'observe');
  assert.deepEqual(result.observation?.targets, source.targets);
  (source.inventory[0] as { count: number }).count = 99;
  assert.equal(result.observation?.inventory[0].count, 1);
});

test('untrusted host fields, malformed decisions and callable declarations cannot reach the observer', async () => {
  let reads = 0;
  const adapter = new FastBrainAdapter({ isActive: () => true, now: () => 100, observeSelf: () => { reads++; return observation(); } });
  for (const wire of [{ ...observe, request_id: 'spoof' }, { ...observe, args: { budget: 1000 } }, { type: 'call', skill: 'finish', args: {} }]) {
    assert.equal((await adapter.submit(wire, context())).status, 'error');
  }
  assert.equal(reads, 0);
});

test('missing production, visibility and control handlers return explicit blocked, never legacy aliases', async () => {
  const adapter = new FastBrainAdapter({ isActive: () => true, now: () => 100 });
  for (const wire of [observe,
    { type: 'call', skill: 'mine', args: { target_id: 'log1' } },
    { type: 'call', skill: 'pickup', args: { target_id: 'drop1' } },
    { type: 'call', skill: 'craft', args: { recipe: 'oak_planks', count: 1 } },
    { type: 'call', skill: 'smelt', args: { station_id: 'f1', input: 'raw_iron', count: 1, fuel: 'coal' } },
    { type: 'call', skill: 'collect_output', args: { station_id: 'f1', job_id: 'j1' } },
    { type: 'call', skill: 'cancel', args: { request_id: 'other' } },
    { type: 'finish' }, { type: 'report_blocked', reason: 'missing_tool' }]) {
    const result = await adapter.submit(wire, context());
    assert.equal(result.status, 'blocked');
    assert.match(result.reason!, /^capability_unavailable:/);
    assert.equal(result.observation, undefined);
    assert.equal(result.outcome, undefined);
  }
});

test('stale, wrong-actor and wrong-world observations do not enter history as current observations', async () => {
  for (const value of [observation({ observedAt: 99 }), observation({ actor: 'other' }), observation({ dimension: 'nether' })]) {
    const adapter = new FastBrainAdapter({ isActive: () => true, now: () => 100, observeSelf: () => value });
    const result = await adapter.submit(observe, context());
    assert.equal(result.status, 'blocked');
    assert.equal(result.observation, undefined);
  }
});

test('inactive, revoked and expired contexts do not start reads', async () => {
  let reads = 0;
  const source = () => { reads++; return observation(); };
  const signal = AbortSignal.abort();
  const active = new FastBrainAdapter({ isActive: () => true, now: () => 100, observeSelf: source });
  assert.equal((await active.submit(observe, context({ signal }))).status, 'cancelled');
  assert.equal((await active.submit(observe, context({ isCurrent: () => false }))).status, 'cancelled');
  assert.equal((await active.submit(observe, context({ notBefore: 0, deadlineAt: 100 }))).status, 'timeout');
  const inactive = new FastBrainAdapter({ isActive: () => false, now: () => 100, observeSelf: source });
  assert.equal((await inactive.submit(observe, context())).reason, 'adapter_not_active');
  assert.equal(reads, 0);
});

test('cancellation while observing returns promptly and discards a late observation', async () => {
  const abort = new AbortController();
  let finish!: (value: SelfObservation) => void;
  const adapter = new FastBrainAdapter({ isActive: () => true, now: () => 100, observeSelf: () => new Promise(resolve => { finish = resolve; }) });
  const pending = adapter.submit(observe, context({ signal: abort.signal }));
  abort.abort();
  const result = await pending;
  assert.equal(result.status, 'cancelled');
  assert.equal(result.observation, undefined);
  finish(observation());
});

test('deadline bounds an unresolved read without fabricating a snapshot', async () => {
  const start = Date.now();
  const adapter = new FastBrainAdapter({ isActive: () => true, observeSelf: () => new Promise(() => {}) });
  const result = await adapter.submit(observe, context({ notBefore: start, deadlineAt: start + 20 }));
  assert.equal(result.status, 'timeout');
  assert.equal(result.observation, undefined);
});

test('integration close revokes an in-flight read and all later submissions', async () => {
  const adapter = new FastBrainAdapter({ isActive: () => true, now: () => 100, observeSelf: () => new Promise(() => {}) });
  const pending = adapter.submit(observe, context());
  adapter.close();
  assert.equal((await pending).reason, 'adapter_not_active');
  assert.equal((await adapter.submit(observe, context())).reason, 'adapter_not_active');
});

test('terminal decisions use the independent verifier and cannot succeed from self-declared evidence', async () => {
  let claims = 0;
  for (const evidenceRefs of [[], ['independent:inventory']]) {
    const adapter = new FastBrainAdapter({ isActive: () => true, now: () => 100,
      verifier: { verify: async claim => { claims++; assert.equal(claim.type, 'finish'); return { verdict: 'completed', evidenceRefs }; } } });
    const result = await adapter.submit({ type: 'finish', evidence_refs: ['policy:untrusted'] }, context());
    assert.equal(result.status, evidenceRefs.length ? 'success' : 'blocked');
    assert.deepEqual(result.evidenceRefs, evidenceRefs);
  }
  assert.equal(claims, 2);
});

test('unknown verifier results and source errors remain unverified and do not leak exception data', async () => {
  const verifier = new FastBrainAdapter({ isActive: () => true, now: () => 100,
    verifier: { verify: async () => ({ verdict: 'unknown', evidenceRefs: [] }) } });
  const terminal = await verifier.submit({ type: 'finish' }, context());
  assert.equal(terminal.status, 'blocked');
  assert.equal(terminal.effectKnowledge, 'unknown');
  const observer = new FastBrainAdapter({ isActive: () => true, now: () => 100, observeSelf: () => { throw new Error('hidden-world-secret'); } });
  const result = await observer.submit(observe, context());
  assert.equal(result.status, 'error');
  assert.doesNotMatch(JSON.stringify(result), /hidden-world-secret/);
});
