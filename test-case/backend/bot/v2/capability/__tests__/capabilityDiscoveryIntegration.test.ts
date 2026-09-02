import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createDefaultAtomicContractRegistry } from '../../../../../../apps/minecraft-companion/src/bot/v2/atomic/contracts/defaultContracts.js';
import { createRuntimeCapabilityKnowledge } from '../../../../../../apps/minecraft-companion/src/bot/v2/capabilities/capabilityRuntimeProjection.js';
import { CapabilityPackageRegistry } from '../../../../../../apps/minecraft-companion/src/bot/v2/capabilities/capabilityPackageRegistry.js';
import { defaultGoalCapabilities } from '../../../../../../apps/minecraft-companion/src/bot/v2/decision/goalAgentPort/goalCapabilityRouter.js';
import { TaskRegistry } from '../../../../../../apps/minecraft-companion/src/bot/v2/knowledge/taskRegistry.js';
import { GoalAgentRoundToolRuntime } from '../../../../../../apps/minecraft-companion/src/bot/v2/task/goalAgent/goalAgentRoundTools.js';
import { createGoalAgentState } from '../../../../../../apps/minecraft-companion/src/bot/v2/task/goalAgent/goalAgentState.js';
import { AgentSkillRegistry } from '../../../../../../apps/minecraft-companion/src/bot/v2/skills/skillRegistry.js';
import { GoalAgentSkillKnowledgeAdapter } from '../../../../../../apps/minecraft-companion/src/bot/v2/skills/goalAgentSkillKnowledge.js';
import type { CapabilityCatalogEntry } from '../../../../../../apps/minecraft-companion/src/bot/v2/capabilities/capabilityCatalog.js';
import { GoalAgentProductionExecutionPort } from '../../../../../../apps/minecraft-companion/src/bot/v2/task/goalAgent/production/goalAgentProductionPorts.js';

const applicationRoot = new URL('../../../../../../apps/minecraft-companion/', import.meta.url);

function setup() {
  const tasks = new TaskRegistry(); tasks.loadAll(fileURLToPath(new URL('src/bot/v2/knowledge/tasks/', applicationRoot)));
  const packages = new CapabilityPackageRegistry({ atomicIds: [], behaviorIds: [], skillNames: [], knowledgeIds: [] });
  const capabilities = createRuntimeCapabilityKnowledge(() => ({
    snapshot: packages.snapshot(), routes: defaultGoalCapabilities(), tasks: tasks.listAll(),
    atomics: createDefaultAtomicContractRegistry().list(),
    behaviors: [{ id: 'farm_one_plot', kind: 'sequence', compile: () => { throw new Error('must not execute'); } }],
    strategies: [{ id: 'farm_strategy', name: 'FarmStrategy', kind: 'fsm' }], services: [],
    adapters: [{ id: 'GameAdapter', summary: 'internal' }],
  }));
  const runtime = new GoalAgentRoundToolRuntime({ profileId: 'capability-test', tools: {}, capabilities });
  const state = createGoalAgentState({ sessionId: 'catalog-goal', interactionSessionId: 'catalog-interaction', request: {
    meta: { schemaVersion: 2, sessionId: 'catalog-interaction', messageId: 'catalog-request', correlationId: 'catalog-correlation',
      conversationId: 'catalog-conversation', sequence: 1, emittedAt: '2026-08-31T00:00:00.000Z', idempotencyKey: 'catalog-request' },
    origin: 'player_message', originalText: '帮我把这个田种一下', requestText: '帮我把这个田种一下', requestKind: 'task', constraints: [],
  } });
  const call = (name: string, args: Record<string, unknown>) => runtime.execute({ id: `call-${name}`, name, arguments: args }, state, new AbortController().signal);
  return { capabilities, runtime, state, call };
}

test('I01: production discovery tools work before rootGoal and expose layers rather than just routes', async () => {
  const { capabilities, state, call } = setup();
  assert.equal(state.rootGoal, null);
  const found = await call('capability_search', { query: '种田' });
  assert.equal(found.content.ok, true);
  const entries = found.content.capabilities as CapabilityCatalogEntry[];
  assert.equal(entries.find(x => x.id === 'task:farm')?.layer, 'L6');
  assert.equal(entries.find(x => x.id === 'task:farm')?.resource?.registered, true);
  assert.equal((capabilities.get('atomic:dig') as CapabilityCatalogEntry).layer, 'L3');
  assert.equal((capabilities.get('behavior:farm_one_plot') as CapabilityCatalogEntry).layer, 'L4');
  assert.equal((capabilities.get('strategy:farm_strategy') as CapabilityCatalogEntry).layer, 'L5');
  assert.equal((capabilities.get('adapter:GameAdapter') as CapabilityCatalogEntry).availability.state, 'unavailable');
  assert.ok(state.cognition.knowledgeRefs.some(ref => ref.startsWith('capability:task:farm@sha256:')));
  assert.equal(state.rootGoal, null);
  const rejected = await call('action_execute', { candidateId: 'behavior:farm_one_plot' });
  assert.equal(rejected.content.ok, false);
});

test('I01: missing Guard wiring is found from real YAML; a class name does not become a data strategy', async () => {
  const { call } = setup();
  const found = await call('capability_search', { query: 'GuardStrategy' });
  const entry = (found.content.capabilities as CapabilityCatalogEntry[]).find(x => x.id === 'strategy:GuardStrategy');
  assert.ok(entry);
  assert.deepEqual(entry.availability.reasons, ['not_registered']);
  assert.deepEqual(entry.invocation, []);
  const loaded = await call('capability_get', { id: entry.id, expectedVersion: entry.version });
  assert.deepEqual(loaded.content.capability, entry);
  const stale = await call('capability_get', { id: entry.id, expectedVersion: 'old-version' });
  assert.equal(stale.content.ok, false);
});

test('I01: lifecycle routes retain exact IDs and top-level tool permission set is unchanged', async () => {
  const { runtime, call } = setup();
  assert.equal(runtime.names().length, 19);
  assert.equal(runtime.names().includes('invoke_behavior'), false);
  const loaded = await call('capability_get', { id: 'follow_owner' });
  const entry = loaded.content.capability as CapabilityCatalogEntry;
  assert.equal(entry.entryKind, 'route');
  assert.equal(entry.route?.handler, 'task_runtime.follow_owner');
});

test('I01/I02: production candidates bind the registered operation/version and discovery cannot bypass code-owned execution support', async () => {
  const contracts = createDefaultAtomicContractRegistry();
  const packages = new CapabilityPackageRegistry({ atomicIds: contracts.list().map(value => value.action), behaviorIds: [], skillNames: [], knowledgeIds: [] });
  packages.register({
    manifest: { schema: 'mineclaw/capability-manifest@2', id: 'test.move', version: 3, description: 'move test',
      goalTargets: [], skills: [], knowledge: [], requires: { atomics: ['move_to'] }, operations: [{
        id: 'test.move', title: 'move test', summary: 'registered operation', aliases: [], kind: 'atomic', mode: 'one_shot',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        executorRef: { kind: 'atomic', id: 'move_to' }, actionProviderId: 'test.move_candidates',
        preconditions: [], effects: [], verificationRefs: ['test.arrived'], worldFactRefs: [],
        lifecycle: { cancellation: 'cooperative', resumable: false },
      }] },
    actionProviders: [{ id: 'test.move_candidates', list: () => [{
      id: 'test.move:target', kind: 'atomic', source: 'slow_llm', action: 'move_to', description: 'move',
      fixedArgs: { position: { x: 1, y: 64, z: 1 } }, evidenceRefs: [],
      authorization: { status: 'blocked', reasons: ['missing_resources:test'] },
    }] }],
    predicateEvaluators: [{ id: 'test.arrived', evaluate: () => ({ ok: false, detail: 'not reached' }) }],
  });
  const snapshot = packages.snapshot();
  let safe = false;
  const capabilities = createRuntimeCapabilityKnowledge(() => ({
    snapshot, routes: defaultGoalCapabilities(), atomics: contracts.list(), behaviors: [], tasks: [], strategies: [], services: [],
    executionSupport: [{ kind: 'atomic', id: 'move_to', controlledCancellation: safe }],
  }));
  const execution = new GoalAgentProductionExecutionPort({
    game:{} as never,bus:{} as never,getWorld:()=>{throw new Error('must not observe');},
    body:{executeGoal:async()=>{throw new Error('blocked candidate must not execute body');},drainTask:async()=>{throw new Error('must not drain');}},
    actionLedger:{begin:()=>{throw new Error('must not begin');},complete:()=>{throw new Error('must not complete');}},
    behaviors: { list: () => [], get: () => undefined } as never, tasks: {} as never, parentTaskId: () => null,
    actionProviders: snapshot.actionProviders, operations: snapshot.operations,
  });
  const { state } = setup();
  state.rootGoal = { schema: 'mineclaw.goal/v1', goalId: 'test-goal', profileId: 'test', goalText: 'move test',
    createdAt: '2026-08-31T00:00:00.000Z', successCriteria: [{ type: 'predicate', predicate: 'test.arrived' }] };
  state.world.latest = { inventory: { items: [] }, entities: [] } as never;
  const runtime = new GoalAgentRoundToolRuntime({ profileId: 'test', capabilities, tools: { execution } });
  const call = (name: string, args: Record<string, unknown>) => runtime.execute({ id: name, name, arguments: args }, state, new AbortController().signal);
  const entry = (await call('capability_get', { id: 'test.move' })).content.capability as CapabilityCatalogEntry;
  const list = await call('action_list', { includeUnavailable: true });
  const candidate = (list.content.candidates as any[])[0]!;
  assert.equal(list.content.catalogVersion, entry.catalogVersion);
  assert.deepEqual(candidate.operationRef, { id: entry.id, version: entry.packageVersion });
  assert.deepEqual(candidate.authorization.reasons, ['controlled_execution_not_connected']);
  assert.equal((await call('action_execute', { candidateHandle: candidate.candidateHandle })).content.ok, false);
  safe = true;
  assert.match(String((await call('action_execute', { candidateHandle: candidate.candidateHandle })).content.error), /stale/);
  const refreshed = ((await call('action_list', { includeUnavailable: true })).content.candidates as any[])[0]!;
  assert.deepEqual(refreshed.authorization.reasons, ['missing_resources:test']);
  assert.match(String((await call('action_execute', { candidateHandle: refreshed.candidateHandle })).content.error), /missing_resources/);
  assert.equal(state.budget.actions, 0);
});

test('U02: unsupported Skill references are diagnosed without disclosing stale executable instructions', () => {
  const registry = new AgentSkillRegistry(() => {});
  registry.register({ meta: { name: '旧种田', description: '种田说明', agent: 'goal', uses: ['start_task'] }, body: 'STALE BODY', dir: '.', source: 'local' });
  let names = ['world_observe'];
  const adapter = new GoalAgentSkillKnowledgeAdapter(registry, () => names);
  const entry = adapter.catalog()[0]!;
  assert.deepEqual(entry.toolCompatibility, { state: 'unsupported_tools', missingTools: ['start_task'] });
  assert.deepEqual(adapter.get({ ref: entry.ref }), { ok: false, reason: 'unsupported_tools', ref: entry.ref, missingTools: ['start_task'] });
  names = ['start_task'];
  assert.equal(adapter.get({ ref: entry.ref }).ok, true);
});

test('U02: shipped GoalAgent Skills reference current real tools; MainBrain memory stays outside GoalAgent', () => {
  const registry = new AgentSkillRegistry(() => {}); registry.loadLocalDir(fileURLToPath(new URL('skills/', applicationRoot)));
  const runtime = new GoalAgentRoundToolRuntime({ profileId: 'skill-ci', tools: {} });
  const adapter = new GoalAgentSkillKnowledgeAdapter(registry, () => runtime.names());
  const entries = adapter.catalog({ limit: 64 });
  assert.equal(entries.length, 13);
  assert.equal(entries.some(entry => entry.name === '主人记忆'), false);
  for (const entry of entries) {
    assert.equal(entry.toolCompatibility?.state, 'compatible', `${entry.name}: ${entry.toolCompatibility?.missingTools}`);
    assert.equal(adapter.get({ ref: entry.ref }).ok, true, entry.name);
  }
});
