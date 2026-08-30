import assert from 'node:assert/strict';
import test from 'node:test';

import type { RegisteredProactiveTickCapability } from '../../../../../../apps/minecraft-companion/src/bot/v2/proactive/contracts.js';
import { ProactiveCapabilityStateStore } from '../../../../../../apps/minecraft-companion/src/bot/v2/proactive/proactiveCapabilityStateStore.js';
import { ProactiveGoalLeaseRegistry } from '../../../../../../apps/minecraft-companion/src/bot/v2/proactive/proactiveGoalLeaseRegistry.js';
import { ProactiveIntentArbiter } from '../../../../../../apps/minecraft-companion/src/bot/v2/proactive/proactiveIntentArbiter.js';
import { ProactiveTickScheduler } from '../../../../../../apps/minecraft-companion/src/bot/v2/proactive/proactiveTickScheduler.js';
import { resolveProactiveCapabilityCatalog } from '../../../../../../apps/minecraft-companion/src/bot/v2/proactive/contracts.js';
import { TickRate } from '../../../../../../apps/minecraft-companion/src/bot/v2/infra/tickRegistry.js';

function capability(id: string, priority: number, evaluate: RegisteredProactiveTickCapability['implementation']['evaluate']): RegisteredProactiveTickCapability {
  return {
    packageId: `test.${id}`,
    manifest: {
      id,
      label: id,
      description: `${id} description`,
      goalTarget: 'mineclaw:test',
      defaultEnabled: false,
      rate: 'fast',
      priority,
      decisionMode: 'deterministic',
      conflictGroups: ['movement'],
      configSchema: {},
    },
    implementation: { id, evaluate },
  };
}

test('disabled plugins do not evaluate and hot enable applies on the next run', async () => {
  let calls = 0;
  const entry = capability('auto_test', 10, () => {
    calls += 1;
    return { kind: 'idle', reason: 'observed' };
  });
  const stateStore = new ProactiveCapabilityStateStore();
  const scheduler = new ProactiveTickScheduler({
    profileId: 'p1', capabilities: [entry], stateStore,
    arbiter: new ProactiveIntentArbiter(), leases: new ProactiveGoalLeaseRegistry(),
    isForegroundBusy: () => false, onArbitration: () => undefined,
  });
  await scheduler.run({ tick: TickRate.FAST, rate: TickRate.FAST, world: null });
  assert.equal(calls, 0);
  assert.equal(stateStore.get('auto_test')?.state, 'disabled');

  scheduler.setPreferences({ auto_test: { enabled: true } });
  await scheduler.run({ tick: TickRate.FAST, rate: TickRate.FAST, world: null });
  assert.equal(calls, 1);
  assert.equal(stateStore.get('auto_test')?.reason, 'observed');
});

test('arbiter chooses one stable winner and records lower-priority suppression', async () => {
  const high = capability('high', 20, () => ({
    kind: 'candidate', candidate: { requestText: 'high', evidenceRefs: ['high'], idempotencyKey: 'high:1' },
  }));
  const low = capability('low', 10, () => ({
    kind: 'candidate', candidate: { requestText: 'low', evidenceRefs: ['low'], idempotencyKey: 'low:1' },
  }));
  const stateStore = new ProactiveCapabilityStateStore();
  const decisions: string[] = [];
  const scheduler = new ProactiveTickScheduler({
    profileId: 'p1', capabilities: [low, high], preferences: { low: { enabled: true }, high: { enabled: true } },
    stateStore, arbiter: new ProactiveIntentArbiter(), leases: new ProactiveGoalLeaseRegistry(),
    isForegroundBusy: () => false,
    onArbitration: decision => { decisions.push(`${decision.kind}:${'winner' in decision ? decision.winner.capabilityId : '-'}`); },
  });
  await scheduler.run({ tick: 1, rate: TickRate.FAST, world: null });
  assert.deepEqual(decisions, ['accept:high']);
  assert.deepEqual(stateStore.get('low'), {
    id: 'low', enabled: true, state: 'suppressed', reason: 'lower_priority_than:high', lastEvaluationAt: stateStore.get('low')!.lastEvaluationAt,
  });
});

test('foreground work suppresses every proactive candidate', async () => {
  const entry = capability('auto_test', 10, () => ({
    kind: 'candidate', candidate: { requestText: 'test', evidenceRefs: [], idempotencyKey: 'test:1' },
  }));
  const stateStore = new ProactiveCapabilityStateStore();
  let decision = '';
  const scheduler = new ProactiveTickScheduler({
    profileId: 'p1', capabilities: [entry], preferences: { auto_test: { enabled: true } },
    stateStore, arbiter: new ProactiveIntentArbiter(), leases: new ProactiveGoalLeaseRegistry(),
    isForegroundBusy: () => true,
    onArbitration: value => { decision = value.kind; },
  });
  await scheduler.run({ tick: 1, rate: TickRate.FAST, world: null });
  assert.equal(decision, 'none');
  assert.equal(stateStore.get('auto_test')?.reason, 'foreground_busy');
});

test('plugin timeout is isolated into backoff and other plugins still arbitrate', async () => {
  let slowCalls = 0;
  const slow = capability('slow', 20, async () => {
    slowCalls += 1;
    await new Promise(resolve => setTimeout(resolve, 50));
    return { kind: 'idle', reason: 'late' };
  });
  const healthy = capability('healthy', 10, () => ({
    kind: 'candidate', candidate: { requestText: 'healthy', evidenceRefs: [], idempotencyKey: 'healthy:1' },
  }));
  const stateStore = new ProactiveCapabilityStateStore();
  const winners: string[] = [];
  let now = 100;
  const scheduler = new ProactiveTickScheduler({
    profileId: 'p1', capabilities: [slow, healthy], preferences: { slow: { enabled: true }, healthy: { enabled: true } },
    stateStore, arbiter: new ProactiveIntentArbiter(), leases: new ProactiveGoalLeaseRegistry(),
    isForegroundBusy: () => false, evaluationTimeoutMs: 5, errorBackoffMs: 100, now: () => now,
    onArbitration: value => { if ('winner' in value) winners.push(value.winner.capabilityId); },
  });
  await scheduler.run({ tick: 1, rate: TickRate.FAST, world: null });
  assert.equal(stateStore.get('slow')?.state, 'backoff');
  assert.deepEqual(winners, ['healthy']);
  now = 150;
  await scheduler.run({ tick: 2, rate: TickRate.FAST, world: null });
  assert.equal(slowCalls, 1);
  assert.equal(stateStore.get('slow')?.backoffUntil, 200);
});

test('lease registry uses two-phase release and rejects stale ownership', () => {
  const leases = new ProactiveGoalLeaseRegistry();
  assert.deepEqual(leases.evaluate({ capabilityId: 'follow', idempotencyKey: 'follow:1', priority: 10 }), { kind: 'grantable' });
  const granted = leases.grant({ capabilityId: 'follow', idempotencyKey: 'follow:1', priority: 10 }, 'activation-1', 100);
  assert.equal(leases.evaluate({ capabilityId: 'follow', idempotencyKey: 'follow:1', priority: 10 }).kind, 'retained');
  assert.equal(leases.evaluate({ capabilityId: 'stockpile', idempotencyKey: 'stockpile:1', priority: 20 }).kind, 'replace_required');
  assert.equal(leases.requestRelease('stockpile', granted.activationId), null);
  assert.equal(leases.snapshot().active?.activationId, 'activation-1');
  assert.equal(leases.requestRelease('follow', 'activation-1')?.activationId, 'activation-1');
  assert.throws(() => leases.grant({ capabilityId: 'stockpile', idempotencyKey: 'stockpile:1', priority: 20 }, 'activation-2', 101), /releasing/);
  assert.equal(leases.confirmReleased('stale'), null);
  assert.equal(leases.confirmReleased('activation-1')?.activationId, 'activation-1');
  assert.equal(leases.grant({ capabilityId: 'stockpile', idempotencyKey: 'stockpile:1', priority: 20 }, 'activation-2', 102).activationId, 'activation-2');
});

test('a restarted lease registry never restores an old activation', () => {
  const beforeRestart = new ProactiveGoalLeaseRegistry();
  beforeRestart.grant({ capabilityId: 'follow', idempotencyKey: 'follow:1', priority: 10 }, 'activation-old', 100);

  const afterRestart = new ProactiveGoalLeaseRegistry();
  assert.deepEqual(afterRestart.snapshot(), { active: null, releasing: null });
  assert.deepEqual(
    afterRestart.evaluate({ capabilityId: 'follow', idempotencyKey: 'follow:2', priority: 10 }),
    { kind: 'grantable' },
  );
});

test('disabling an active plugin emits a release evaluation without calling it again', async () => {
  let calls = 0;
  const entry = capability('auto_test', 10, () => {
    calls += 1;
    return { kind: 'candidate', candidate: { requestText: 'test', evidenceRefs: [], idempotencyKey: 'test:1' } };
  });
  const stateStore = new ProactiveCapabilityStateStore();
  const leases = new ProactiveGoalLeaseRegistry();
  const releases: string[] = [];
  const scheduler = new ProactiveTickScheduler({
    profileId: 'p1', capabilities: [entry], preferences: { auto_test: { enabled: true } },
    stateStore, arbiter: new ProactiveIntentArbiter(), leases, isForegroundBusy: () => false,
    onArbitration: (_decision, evaluations) => {
      const evaluation = evaluations.get('auto_test');
      if (evaluation?.kind === 'release') releases.push(evaluation.reason);
    },
  });
  leases.grant({ capabilityId: 'auto_test', idempotencyKey: 'test:1', priority: 10 }, 'activation-1', 1);
  scheduler.setPreferences({ auto_test: { enabled: false } });
  await scheduler.run({ tick: 1, rate: TickRate.FAST, world: null });
  assert.equal(calls, 0);
  assert.deepEqual(releases, ['disabled']);
});

test('catalog snapshot is immutable and contains only read models', () => {
  const entry = capability('auto_test', 10, () => ({ kind: 'idle', reason: 'test' }));
  const catalog = resolveProactiveCapabilityCatalog([entry], { auto_test: { enabled: true } });
  assert.equal(catalog[0]?.enabled, true);
  assert.equal(Object.isFrozen(catalog), true);
  assert.equal(Object.isFrozen(catalog[0]), true);
});
