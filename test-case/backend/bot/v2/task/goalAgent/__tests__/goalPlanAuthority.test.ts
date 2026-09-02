import assert from 'node:assert/strict';
import { test, beforeEach, afterEach } from 'node:test';
import { GoalPlanAuthority } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/goalAgent/goalPlanAuthority.js';
import { GoalDraftCompiler } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/goalAgent/goalDraftCompiler.js';
import { GoalAgentRoundToolRuntime } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/goalAgent/goalAgentRoundTools.js';
import { createGoalAgentState } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/goalAgent/goalAgentState.js';
import { CapabilityPackageRegistry } from '../../../../../../../apps/minecraft-companion/src/bot/v2/capabilities/capabilityPackageRegistry.js';
import { createRuntimeCapabilityKnowledge } from '../../../../../../../apps/minecraft-companion/src/bot/v2/capabilities/capabilityRuntimeProjection.js';
import { GoalAgentProductionExecutionPort, GoalAgentProductionVerificationPort } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/goalAgent/production/goalAgentProductionPorts.js';
import { __setTuningOverride } from '../../../../../../../apps/minecraft-companion/src/bot/v2/infra/tuning.js';
import type { GoalScopeBinding, PredicateRef } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/contracts/goalDraft.js';
import type { GoalOperationRequest } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/contracts/goalPlanOperation.js';
import type { GoalAgentActionCandidate } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/goalAgent/ports/executionPort.js';
import type { CapabilityOperationDefinition } from '../../../../../../../apps/minecraft-companion/src/bot/v2/capabilities/capabilityOperation.js';
import type { WorldStateView } from '../../../../../../../apps/minecraft-companion/src/bot/v2/types.js';

beforeEach(() => __setTuningOverride({ goalComposition: { enabled: true } }));
afterEach(() => __setTuningOverride(null));
const ref = (item: string, count: number): PredicateRef => ({ id: 'test.inventory', version: '1', args: { item, count } });

function fixture() {
  const now = Date.now(), at = new Date(now).toISOString();
  const state = createGoalAgentState({ sessionId: 'plan-test', interactionSessionId: 'interaction', request: {
    meta: { schemaVersion: 2, sessionId: 'interaction', messageId: 'request', correlationId: 'correlation', conversationId: 'conversation', sequence: 1, emittedAt: at, idempotencyKey: 'request' },
    origin: 'player_message', originalText: '从这个授权箱子取料做一件工具', requestText: '从这个授权箱子取料做一件工具', requestKind: 'task', constraints: [],
  } });
  const world: WorldStateView = { tick: 1, timestamp: now, self: { position: { x: 0, y: 64, z: 0 }, yaw: 0, pitch: 0, health: 20, maxHealth: 20, food: 20, isOnGround: true }, owner: null,
    environment: { dimension: 'overworld', timeOfDay: 0, isDay: true, isRaining: false }, inventory: { items: [], held: null, freeSlots: 36 }, entities: [], taskContext: null };
  state.world.latest = world;
  const bindings: GoalScopeBinding[] = [
    { id: 'self', version: '1', kind: 'self', summary: 'owned inventory', dimension: 'overworld', mutationAllowed: false, allowedAccess: ['use'], required: true, requiredPredicates: [ref('tool', 1)], evidenceRefs: ['owner-request'] },
    { id: 'chest:one', version: '1', kind: 'container', summary: 'authorized chest', dimension: 'overworld', position: { x: 3, y: 64, z: 1 }, mutationAllowed: false, allowedAccess: ['use'], required: false, requiredPredicates: [], evidenceRefs: ['authorized-container'] },
  ];
  const schema = { type: 'object', additionalProperties: false, properties: { item: { type: 'string', enum: ['wood', 'planks', 'tool', 'diamond'] }, count: { type: 'integer', minimum: 1, maximum: 8 }, containerRef: { type: 'string' } }, required: ['item', 'count', 'containerRef'] };
  const operation = (id: 'take' | 'craft'): CapabilityOperationDefinition => ({ id: `test.${id}`, title: id, summary: id, aliases: [], kind: 'atomic', mode: 'one_shot', inputSchema: schema,
    executorRef: { kind: 'atomic', id: id === 'take' ? 'take_test' : 'craft_test' }, actionProviderId: 'test.candidates',
    preconditions: id === 'craft' ? [{ id: 'test.inventory', args: {} }] : [], effects: [{ id: 'test.inventory', args: {} }], verificationRefs: ['test.inventory'], worldFactRefs: [], lifecycle: { cancellation: 'cooperative', resumable: false } });
  const registry = new CapabilityPackageRegistry({ atomicIds: ['take_test', 'craft_test'], behaviorIds: [], skillNames: [], knowledgeIds: [] });
  registry.register({ manifest: { schema: 'mineclaw/capability-manifest@2', id: 'test.recipes', version: 1, description: 'test registered recipes', goalTargets: [], skills: [], knowledge: [], requires: { atomics: ['take_test', 'craft_test'] }, operations: [operation('take'), operation('craft')] },
    actionProviders: [{ id: 'test.candidates', list: () => [] }], goalBindingProviders: [{ id: 'test.bindings', list: () => bindings }],
    predicateEvaluators: [{ id: 'test.inventory', version: '1', argumentSchema: { ...schema, properties: { item: schema.properties.item, count: schema.properties.count }, required: ['item', 'count'] }, evaluate: ({ criterion, world }) => {
      const count = world.inventory.items.find(value => value.name === criterion.args!.item)?.count ?? 0;
      return { status: count >= Number(criterion.args!.count) ? 'satisfied' : 'unsatisfied', detail: `inventory:${count}` };
    } }],
    operationSemantics: [
      { operationId: 'test.take', version: '1', resolve: ({ args }) => ({ requires: [], satisfies: [ref(String(args.item), Number(args.count))], accesses: [{ targetRef: 'self', mode: 'use' }, { targetRef: String(args.containerRef), mode: 'use' }], estimatedActions: 1 }) },
      { operationId: 'test.craft', version: '1', resolve: ({ args }) => {
        const recipe = args.item === 'tool' && args.count === 1 ? ref('planks', 2) : args.item === 'planks' && args.count === 2 ? ref('wood', 1) : null;
        if (!recipe) throw new Error('registered_recipe_quantity_invalid');
        return { requires: [recipe], satisfies: [ref(String(args.item), Number(args.count))], accesses: [{ targetRef: 'self', mode: 'use' }], estimatedActions: 1 };
      } },
    ],
  });
  const snapshot = registry.snapshot();
  const compiler = new GoalDraftCompiler({ predicates: () => snapshot.predicateEvaluators, bindings: () => bindings });
  const compiled = compiler.compile({ state, profileId: 'test', goalId: 'root', acceptedAt: at, draft: { schema: 'mineclaw.goal-draft/v1', requestRef: state.requestId, scope: { dimension: 'overworld', targetRefs: ['self', 'chest:one'] }, success: { allOf: [ref('tool', 1)] } } });
  state.schema = 'mineclaw.goal-agent-state/v2'; state.rootGoal = compiled.rootGoal; state.goal.definition = compiled.goal; state.goal.signature = compiled.signature;
  const authority = new GoalPlanAuthority({ snapshot: () => snapshot, bindings: () => bindings, now: () => now });
  const capabilities = createRuntimeCapabilityKnowledge(() => ({ snapshot, routes: [], atomics: [], behaviors: [], tasks: [], strategies: [], services: [], executionSupport: [{ kind: 'atomic', id: 'take_test', controlledCancellation: true }, { kind: 'atomic', id: 'craft_test', controlledCancellation: true }] }));
  let executions = 0, candidate: GoalAgentActionCandidate | null = null;
  const runtime = new GoalAgentRoundToolRuntime({ profileId: 'test', capabilities, now: () => at, tools: { goals: compiler, plans: authority,
    perception: { observe: async () => structuredClone(world) }, verification: new GoalAgentProductionVerificationPort(() => [], () => [], () => [], () => snapshot.predicateEvaluators),
    execution: { listCandidates: () => candidate ? [candidate] : [], execute: async input => {
      executions++; const { item, count } = input.proposal.args;
      world.inventory.items = [{ name: String(item), count: Number(count), slot: 0 }];
      return { ok: true, detail: 'test world changed', idempotencyKey: input.idempotencyKey, executionSessionId: 'test-exec', evidenceRefs: ['test-world'], startedAt: at, completedAt: at };
    } },
  } });
  const call = (name: string, args: Record<string, unknown> = {}) => runtime.execute({ id: name, name, arguments: args }, state, new AbortController().signal);
  const request = (id: string, item: string, count: number): GoalOperationRequest => ({ id: `test.${id}`, version: 1, args: { item, count, containerRef: 'chest:one' } });
  const task = (id: string, operation: GoalOperationRequest, dependsOn: string[]) => {
    const resolved = authority.inspect(state, operation);
    return { id, goalText: id, operation, requires: resolved.requires, satisfies: resolved.satisfies, dependsOn,
      successCriteria: resolved.satisfies.map(value => ({ type: 'predicate', predicate: value.id, predicateVersion: value.version, args: value.args })), estimatedActions: 999 };
  };
  const tasks = () => [task('wood', request('take', 'wood', 1), []), task('planks', request('craft', 'planks', 2), ['wood']), task('tool', request('craft', 'tool', 1), ['planks'])];
  const choose = (operation: GoalOperationRequest) => candidate = { id: `${operation.id}:bound`, kind: 'atomic', source: 'slow_llm', action: operation.id === 'test.take' ? 'take_test' : 'craft_test', description: 'code candidate',
    fixedArgs: structuredClone(operation.args), argumentSchema: schema, mutableArgumentPaths: ['/item', '/count'], operationRef: { id: operation.id, version: operation.version }, authorization: { status: 'ready', reasons: [] }, evidenceRefs: ['test-binding'] };
  return { state, world, bindings, snapshot, authority, call, task, tasks, request, choose, executions: () => executions };
}

test('U09/I03: discovered code recipe requirements drive a legal three-node no-template plan and real tool verification', async () => {
  const f = fixture(), root = structuredClone(f.state.rootGoal);
  await f.call('world_observe');
  const inspected = await f.call('capability_get', { id: 'test.craft', arguments: f.request('craft', 'tool', 1).args });
  assert.deepEqual((inspected.content.planning as any).requires, [ref('planks', 2)]);
  const tasks = f.tasks();
  assert.equal((await f.call('plan_commit', { tasks })).content.ok, true);
  assert.deepEqual(f.state.plan.graph!.nodes.map(value => value.estimatedCost.actions), [1, 1, 1]);
  for (const task of tasks) {
    assert.equal(f.state.plan.activeNodeId, task.id);
    f.choose(task.operation);
    const listed = await f.call('action_list');
    const executed = await f.call('action_execute', { candidateHandle: (listed.content.candidates as any[])[0].candidateHandle });
    assert.equal(executed.content.ok, true, JSON.stringify(executed.content));
  }
  assert.equal(f.executions(), 3);
  assert.equal(f.state.terminal?.outcome, 'completed');
  assert.deepEqual(f.state.rootGoal, root);
});

test('U10: cycles, node/depth/action budgets and unrelated effects reject the entire plan', async () => {
  for (const kind of ['cycle', 'unrelated', 'nodes', 'depth', 'actions', 'forged-effects', 'missing-requires']) {
    const f = fixture(); await f.call('world_observe'); const tasks = f.tasks();
    if (kind === 'cycle') tasks[0]!.dependsOn = ['tool'];
    if (kind === 'unrelated') { tasks.push(f.task('diamond', f.request('take', 'diamond', 1), [])); tasks[2]!.dependsOn.push('diamond'); }
    if (kind === 'nodes') __setTuningOverride({ goalComposition: { enabled: true, maxPlanNodes: 2 } });
    if (kind === 'depth') __setTuningOverride({ goalComposition: { enabled: true, maxPlanDepth: 2 } });
    if (kind === 'actions') f.state.budget.maxActions = 2;
    if (kind === 'forged-effects') tasks[0]!.satisfies = [ref('tool', 1)];
    if (kind === 'missing-requires') delete (tasks[1] as any).requires;
    const result = await f.call('plan_commit', { tasks });
    assert.equal(result.content.ok, false, kind);
    assert.equal(f.state.plan.graph, null, kind);
    assert.equal(f.executions(), 0);
    __setTuningOverride({ goalComposition: { enabled: true } });
  }
});

test('U09/U11: missing resources are typed, while recipe quantities and unbound or changed containers fail closed', async () => {
  const f = fixture(); await f.call('world_observe');
  const missing = await f.call('plan_commit', { tasks: [f.task('tool', f.request('craft', 'tool', 1), [])] });
  assert.match(String(missing.content.error), /precondition_unsatisfied/);
  assert.throws(() => f.task('tool', f.request('craft', 'tool', 8), []), /recipe_quantity/);
  const other = f.request('take', 'wood', 1); other.args.containerRef = 'chest:unknown';
  assert.throws(() => f.authority.inspect(f.state, other), /not_authorized/);
  (f.bindings[1] as any).position = { x: 99, y: 64, z: 1 };
  assert.throws(() => f.authority.inspect(f.state, f.request('take', 'wood', 1)), /binding_changed/);
  assert.equal(f.executions(), 0);
});

test('U14: final mutable business args must match the causal node; old plan handles expire', async () => {
  const f = fixture(); await f.call('world_observe');
  const operation = f.request('take', 'wood', 1); f.choose(operation);
  const noPlan = await f.call('action_list');
  assert.match(String((await f.call('action_execute', { candidateHandle: (noPlan.content.candidates as any[])[0].candidateHandle })).content.error), /requires_causal_plan/);
  assert.equal((await f.call('plan_commit', { tasks: f.tasks() })).content.ok, true);
  assert.match(String((await f.call('action_execute', { candidateHandle: (noPlan.content.candidates as any[])[0].candidateHandle })).content.error), /stale/);
  const list = await f.call('action_list'), handle = (list.content.candidates as any[])[0].candidateHandle;
  assert.match(String((await f.call('action_execute', { candidateHandle: handle, arguments: { item: 'diamond', count: 8 } })).content.error), /active_causal_plan/);
  assert.equal(f.executions(), 0);
  assert.equal((await f.call('action_execute', { candidateHandle: handle, arguments: { item: 'wood', count: 1 } })).content.ok, true);
});

test('U11: production dispatch cannot bypass composed authority with missing candidate or changed final args', async () => {
  const f = fixture(); await f.call('world_observe'); await f.call('plan_commit', { tasks: f.tasks() });
  const candidate = f.choose(f.request('take', 'wood', 1));
  let touched = false;
  const execution = new GoalAgentProductionExecutionPort({game:{} as never,bus:{} as never,getWorld:()=>{throw new Error('must not observe');},
    body:{executeGoal:async()=>{touched=true;throw new Error('must not dispatch');},drainTask:async()=>{throw new Error('must not drain');}},
    actionLedger:{begin:()=>{throw new Error('must not begin');},complete:()=>{throw new Error('must not complete');}},
    behaviors:{} as never,tasks:{} as never,parentTaskId:()=>null,plans:f.authority});
  const input = { sessionId: f.state.sessionId, epoch: f.state.epoch, idempotencyKey: 'unauthorized', state: f.state, signal: new AbortController().signal, proposal: { source: candidate.source, action: candidate.action, args: { ...candidate.fixedArgs, count: 8 }, rationale: 'test' } };
  assert.throws(() => execution.execute(input), /authority_required/);
  assert.throws(() => execution.execute({ ...input, candidate }), /active_causal_plan/);
  assert.equal(touched, false);
});

test('U11: unknown/stale preconditions and changed operation semantics stop an already committed plan', async () => {
  const f = fixture(); await f.call('world_observe'); await f.call('plan_commit', { tasks: f.tasks() });
  f.state.plan.activeNodeId = 'tool'; f.state.plan.graph!.nodes.forEach(node => node.state = node.id === 'tool' ? 'ready' : 'satisfied');
  const candidate = f.choose(f.request('craft', 'tool', 1));
  assert.throws(() => f.authority.authorize(f.state, candidate, candidate.fixedArgs), /precondition_unsatisfied/);
  f.state.world.latest!.timestamp -= 6000;
  assert.throws(() => f.authority.authorize(f.state, candidate, candidate.fixedArgs), /fresh_bound_world/);
  f.state.world.latest!.timestamp += 6000;
  const changed = new GoalPlanAuthority({ snapshot: () => ({ ...f.snapshot, operationSemantics: f.snapshot.operationSemantics.map(value => ({ ...value, version: 'new' })) }), bindings: () => f.bindings });
  assert.throws(() => changed.authorize(f.state, candidate, candidate.fixedArgs), /active_causal_plan/);
});

test('U11: effect positions and world mutation cannot escape code-bound resource permissions', async () => {
  const f = fixture(); await f.call('world_observe');
  for (const access of [
    { targetRef: 'chest:one', mode: 'use' as const, position: { x: 4, y: 64, z: 1 } },
    { targetRef: 'self', mode: 'modify' as const },
  ]) {
    const authority = new GoalPlanAuthority({ bindings: () => f.bindings, snapshot: () => ({ ...f.snapshot,
      operationSemantics: f.snapshot.operationSemantics.map(value => value.operationId === 'test.take'
        ? { ...value, resolve: input => ({ ...value.resolve(input), accesses: [access] }) } : value),
    }) });
    assert.throws(() => authority.inspect(f.state, f.request('take', 'wood', 1)), /outside_binding|not_authorized/);
  }
  f.state.world.latest!.environment.dimension = 'the_nether';
  assert.throws(() => f.authority.inspect(f.state, f.request('take', 'wood', 1)), /fresh_bound_world/);
  assert.equal(f.executions(), 0);
});
