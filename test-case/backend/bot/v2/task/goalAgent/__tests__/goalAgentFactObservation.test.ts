import assert from 'node:assert/strict';
import test from 'node:test';
import { GoalAgentProductionPerceptionPort } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/goalAgent/production/goalAgentProductionPorts.js';
import { GoalAgentRoundToolRuntime } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/goalAgent/goalAgentRoundTools.js';
import { createGoalAgentState } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/goalAgent/goalAgentState.js';
import { __setTuningOverride } from '../../../../../../../apps/minecraft-companion/src/bot/v2/infra/tuning.js';
import type { CapabilityWorldFactProvider } from '../../../../../../../apps/minecraft-companion/src/bot/v2/capabilities/types.js';
import type { WorldStateView } from '../../../../../../../apps/minecraft-companion/src/bot/v2/types.js';

function world(): WorldStateView {
  return { tick: 1, timestamp: Date.now(), self: { position: { x: 0, y: 64, z: 0 }, yaw: 0, pitch: 0, health: 20, maxHealth: 20, food: 20, isOnGround: true },
    owner: null, environment: { dimension: 'overworld', timeOfDay: 1000, isDay: true, isRaining: false },
    entities: [], inventory: { items: [], held: null, freeSlots: 36 }, taskContext: null };
}
const request = { providerId: 'test.fact', version: '1', params: { radius: 2 } };
function harness(observe?: CapabilityWorldFactProvider['observe']) {
  let scans = 0;
  const snapshot = world();
  const provider: CapabilityWorldFactProvider = { id: 'test.fact', version: '1',
    inputSchema: { type: 'object', properties: { radius: { type: 'integer', minimum: 1, maximum: 4 } }, required: ['radius'], additionalProperties: false },
    observe: observe ?? (({ world: current, params }) => { scans += 1; return {
      providerId: 'test.fact', version: '1', observedAt: current.timestamp, complete: true, truncated: false,
      bounds: { dimension: current.environment.dimension, radius: params!.radius }, value: { scans }, evidenceRefs: [`test:scan:${scans}`],
    }; }),
  };
  return { port: new GoalAgentProductionPerceptionPort(() => snapshot, () => [provider]), scans: () => scans, snapshot };
}

test('U07/I02: typed fact queries are read-only, detached, cancellable and fail closed before scanning an invalid batch', async () => {
  const h = harness(), signal = new AbortController().signal;
  for (const invalid of [
    { ...request, version: '2' }, { ...request, providerId: 'not_registered' },
    { ...request, params: { radius: 999 } }, { ...request, params: { radius: 2, executor: 'dig' } },
  ]) await assert.rejects(h.port.observe(signal, [request, invalid]));
  assert.equal(h.scans(), 0);
  const observed = await h.port.observe(signal, [request]);
  assert.equal(h.scans(), 1); assert.equal(h.snapshot.capabilityFacts, undefined);
  assert.equal(observed.capabilityFacts?.[0]?.version, '1');
  const abort = new AbortController(); abort.abort();
  await assert.rejects(h.port.observe(abort.signal, [request])); assert.equal(h.scans(), 1);
  __setTuningOverride({ goalEvidence: { maxFactPayloadBytes: 1 } });
  try { await assert.rejects(h.port.observe(signal, [request]), /payload_limit/); }
  finally { __setTuningOverride(null); }
});

test('U07: provider cancellation while awaiting rejects late observations', async () => {
  const controller = new AbortController();
  const h = harness(async () => {
    controller.abort();
    return { providerId: 'test.fact', version: '1', observedAt: Date.now(), complete: true, truncated: false,
      bounds: {}, value: {}, evidenceRefs: ['late'] };
  });
  await assert.rejects(h.port.observe(controller.signal, [request]));
});

test('I02: real world_observe accepts preregistered facts before a root and refreshes saved requests on subsequent observations', async () => {
  const h = harness();
  const shared = createGoalAgentState({ sessionId: 'facts', interactionSessionId: 'interaction', request: {
    meta: { schemaVersion: 2, sessionId: 'interaction', messageId: 'request', correlationId: 'correlation', conversationId: 'conversation',
      sequence: 1, emittedAt: new Date().toISOString(), idempotencyKey: 'request' },
    origin: 'player_message', originalText: '看看农田', requestText: '看看农田', requestKind: 'task', constraints: [],
  } });
  const runtime = new GoalAgentRoundToolRuntime({ profileId: 'test', tools: { perception: h.port } });
  const call = (argumentsValue: Record<string, unknown>) => runtime.execute({ id: 'observe', name: 'world_observe', arguments: argumentsValue }, shared, new AbortController().signal);
  const first = await call({ factRequests: [request] });
  assert.equal(first.content.ok, true); assert.equal(shared.rootGoal, null);
  assert.equal((first.content.world as any).capabilityFacts[0].value.scans, 1);
  assert.equal((await call({})).content.ok, true); assert.equal(h.scans(), 2);
  assert.deepEqual(shared.world.factRequests, [request]);
  await call({ factRequests: [] }); await call({}); assert.equal(h.scans(), 2);
  assert.equal(shared.world.factRequests, undefined);
  assert.equal((await call({ factRequests: [request, request] })).content.ok, false); assert.equal(h.scans(), 2);
});
