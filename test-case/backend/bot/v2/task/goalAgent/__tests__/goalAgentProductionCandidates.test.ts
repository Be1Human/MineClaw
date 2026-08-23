import assert from 'node:assert/strict';
import test from 'node:test';

import type { GoalRequestV2 } from '../../../../../../../apps/minecraft-companion/src/bot/v2/decision/goalAgentPort/contracts.js';
import { GOAL_CONTRACT_SCHEMA_V1 } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/contracts/goalContract.js';
import type { GoalSuccessCriterion } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/contracts/goalTypes.js';
import type { WorldStateView } from '../../../../../../../apps/minecraft-companion/src/bot/v2/types.js';
import { createGoalAgentState, type GoalAgentStateV1 } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/goalAgent/goalAgentState.js';
import {
  GoalAgentProductionExecutionPort,
  GoalAgentProductionVerificationPort,
} from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/goalAgent/production/goalAgentProductionPorts.js';
import { EventBusV2 } from '../../../../../../../apps/minecraft-companion/src/bot/v2/infra/eventBus.js';
import { MemoryV2 } from '../../../../../../../apps/minecraft-companion/src/bot/v2/infra/memory.js';
import { TaskRuntime } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/taskRuntime.js';

function request(): GoalRequestV2 {
  return {
    meta: {
      schemaVersion: 2,
      sessionId: 'interaction-candidates',
      messageId: 'request-candidates',
      correlationId: 'correlation-candidates',
      conversationId: 'conversation-candidates',
      sequence: 1,
      emittedAt: '2026-08-20T00:00:00.000Z',
      idempotencyKey: 'request-candidates',
    },
    origin: 'player_message',
    originalText: 'collect one oak log',
    requestText: 'collect one oak log',
    requestKind: 'task',
    constraints: [],
  };
}

function world(): WorldStateView {
  return {
    tick: 1,
    timestamp: 1,
    self: {
      position: { x: 0, y: 64, z: 0 }, yaw: 0, pitch: 0,
      health: 20, maxHealth: 20, food: 20, isOnGround: true,
    },
    owner: null,
    environment: {} as WorldStateView['environment'],
    entities: [],
    inventory: { items: [], held: null, freeSlots: 36 },
    taskContext: null,
  };
}

function state(criteria: GoalSuccessCriterion[], goalText = 'collect one oak log'): GoalAgentStateV1 {
  const value = createGoalAgentState({
    sessionId: 'goal-candidates', interactionSessionId: 'interaction-candidates', request: request(),
  });
  value.rootGoal = {
    schema: GOAL_CONTRACT_SCHEMA_V1,
    goalId: 'root-candidates',
    profileId: 'profile-candidates',
    goalText,
    successCriteria: criteria,
    createdAt: '2026-08-20T00:00:00.000Z',
  };
  value.world.latest = world();
  value.plan = {
    revision: 1,
    activeNodeId: 'task-1',
    history: [],
    graph: {
      id: 'plan-candidates', goalId: 'root-candidates', provenance: ['test'], edges: [],
      budget: { maxNodes: 8, maxGraphReplans: 3 },
      nodes: [{
        id: 'task-1', state: 'ready', preconditions: [], planRecoveryRefs: [], provenance: ['test'],
        postconditions: criteria.map(criterion => JSON.stringify(criterion)),
        estimatedCost: { actions: 1, durationMs: 1_000, llmRounds: 1, risk: 0 },
        goal: {
          id: 'root-candidates:task-1', goalText, taskFamily: 'gathering',
          successCriteria: criteria.map(criterion => JSON.stringify(criterion)),
          metadata: { structuredSuccessCriteria: criteria },
        },
      }],
    },
  };
  return value;
}

function executionPort(recipes: Array<{ result: { name: string; count: number }; ingredients: never[]; requiresTable: boolean }> = []) {
  return new GoalAgentProductionExecutionPort({
    atomicContext: () => ({
      game: {
        getCraftRecipes: () => recipes,
        getItemSource: (item: string) => item === 'oak_log' ? { block: 'oak_log', requiredTool: null } : null,
      },
    } as never),
    behaviors: {
      list: () => ['follow', 'farm', 'flee', 'gather_block', 'craft_one', 'combat'].map(id => ({ id })),
    } as never,
    tasks: {} as never,
    parentTaskId: () => null,
    resolveGatherTargets: () => Array.from({ length: 20 }, (_, index) => ({
      blockName: 'oak_log', pos: { x: index + 1, y: 64, z: 0 },
    })),
  });
}

test('inventory gather goal exposes only bounded relevant gather candidates', async () => {
  const candidates = await executionPort().listCandidates({
    state: state([{ type: 'inventory', item: 'oak_log', count: 1 }]),
    planNodeId: 'task-1',
    signal: new AbortController().signal,
  });
  assert.equal(candidates.length, 5);
  assert.deepEqual(candidates[0], {
    id: 'task:gather_material:oak_log', kind: 'task', source: 'registered_task', action: 'invoke_task',
    description: 'Run the registered gathering task for oak_log, including bounded exploration',
    fixedArgs: { taskKind: 'gather_material', params: { material: 'oak_log', count: 1 } },
    argumentSchema: { type: 'object', properties: {}, required: ['taskKind', 'params'], additionalProperties: false },
    evidenceRefs: ['task-capability:gather_material'],
  });
  assert.ok(candidates.slice(1).every(candidate => candidate.id.startsWith('behavior:gather_block:')));
  assert.ok(candidates.slice(1).every(candidate => candidate.action === 'invoke_behavior'));
  assert.ok(candidates.every(candidate => !/combat|follow|farm|flee|sleep|attack|toss/.test(candidate.id)));
});

test('BUG-CROSS-74 · gather task stays available when no resource block is currently visible', async () => {
  const port = new GoalAgentProductionExecutionPort({
    atomicContext: () => ({
      game: {
        getCraftRecipes: () => [],
        getItemSource: () => ({ block: 'oak_log', requiredTool: null }),
      },
    } as never),
    behaviors: { list: () => [{ id: 'gather_block' }] } as never,
    tasks: {} as never,
    parentTaskId: () => null,
    resolveGatherTargets: () => [],
  });
  const candidates = await port.listCandidates({
    state: state([{ type: 'inventory', item: 'oak_log', count: 1 }]),
    planNodeId: 'task-1', signal: new AbortController().signal,
  });
  assert.deepEqual(candidates.map(candidate => candidate.id), ['task:gather_material:oak_log']);
});

test('craftable inventory goal exposes managed task plus bounded direct craft candidates', async () => {
  const candidates = await executionPort([{
    result: { name: 'oak_planks', count: 4 }, ingredients: [], requiresTable: false,
  }]).listCandidates({
    state: state([{ type: 'inventory', item: 'oak_planks', count: 4 }]),
    planNodeId: 'task-1',
    signal: new AbortController().signal,
  });
  assert.deepEqual(candidates.map(candidate => candidate.id), [
    'task:craft_item:oak_planks', 'behavior:craft_one', 'atomic:craft',
  ]);
  assert.deepEqual(candidates[0]?.fixedArgs, {
    taskKind: 'craft_item', params: { item: 'oak_planks', count: 4 },
  });
  assert.ok(candidates.slice(1).every(candidate => candidate.fixedArgs.itemName === 'oak_planks'
    || (candidate.fixedArgs.behaviorParams as { item?: string }).item === 'oak_planks'));
});

test('BUG-CROSS-64 · chest as crafted output is not mistaken for a container source', async () => {
  const recipes = [{
    result: { name: 'chest', count: 1 }, ingredients: [], requiresTable: true,
  }];
  for (const goalText of ['Craft a chest from oak planks', 'Obtain a chest', '拿木板做箱子']) {
    const candidates = await executionPort(recipes).listCandidates({
      state: state([{ type: 'inventory', item: 'chest', count: 1 }], goalText),
      planNodeId: 'task-1',
      signal: new AbortController().signal,
    });
    assert.deepEqual(
      candidates.map(candidate => candidate.id),
      ['task:craft_item:chest', 'behavior:craft_one', 'atomic:craft'],
      goalText,
    );
  }
});

test('candidate cap is deterministic and applied after applicability filtering', async () => {
  const port = new GoalAgentProductionExecutionPort({
    atomicContext: () => ({ game: { getCraftRecipes: () => [] } } as never),
    behaviors: { list: () => [{ id: 'gather_block' }] } as never,
    tasks: {} as never,
    parentTaskId: () => null,
    maxCandidates: 2,
    resolveGatherTargets: () => Array.from({ length: 4 }, (_, index) => ({
      blockName: 'oak_log', pos: { x: index + 1, y: 64, z: 0 },
    })),
  });
  const candidates = await port.listCandidates({
    state: state([{ type: 'inventory', item: 'oak_log', count: 1 }]),
    planNodeId: 'task-1',
    signal: new AbortController().signal,
  });
  assert.deepEqual(candidates.map(candidate => candidate.id), [
    'behavior:gather_block:1',
    'behavior:gather_block:2',
  ]);
});

test('FEAT-CROSS-19 · capability provider binds one registered Behavior candidate without a core ID branch', async () => {
  const port = new GoalAgentProductionExecutionPort({
    atomicContext: () => ({ game: { getCraftRecipes: () => [], getItemSource: () => null } } as never),
    behaviors: {
      list: () => [{ id: 'harvest_mature_crops' }],
      get: (id: string) => id === 'harvest_mature_crops' ? { id, plan: () => [] } : undefined,
    } as never,
    tasks: {} as never,
    parentTaskId: () => null,
    actionProviders: [{
      id: 'agriculture.harvest',
      list: ({ criteria }) => criteria.some(criterion => criterion.predicate === 'agriculture.harvest_to_chest')
        ? [{
          id: 'behavior:harvest_mature_crops',
          kind: 'behavior' as const,
          source: 'registered_behavior' as const,
          action: 'invoke_behavior',
          description: 'Harvest mature crops',
          fixedArgs: { behavior: 'harvest_mature_crops', behaviorParams: { cropId: 'wheat' } },
          evidenceRefs: ['crop-fact:wheat:mature'],
        }]
        : [],
    }],
  });
  const criteria = [{ type: 'predicate', predicate: 'agriculture.harvest_to_chest' }] as GoalSuccessCriterion[];
  const candidates = await port.listCandidates({
    state: state(criteria, '收割成熟农田并放进箱子'),
    planNodeId: 'task-1',
    signal: new AbortController().signal,
  });
  assert.deepEqual(candidates.map(candidate => candidate.id), ['behavior:harvest_mature_crops']);
  assert.deepEqual(candidates[0]?.fixedArgs, {
    behavior: 'harvest_mature_crops', behaviorParams: { cropId: 'wheat' },
  });
});

test('FEAT-CROSS-19 · capability provider fails closed for missing facts, exceptions and unregistered actions', async () => {
  for (const list of [
    () => [],
    () => { throw new Error('world_fact_truncated'); },
    () => [{
      id: 'behavior:not_registered', kind: 'behavior' as const, source: 'registered_behavior' as const,
      action: 'invoke_behavior', description: 'invalid', fixedArgs: { behavior: 'not_registered' }, evidenceRefs: [],
    }],
  ]) {
    const port = new GoalAgentProductionExecutionPort({
      atomicContext: () => ({ game: { getCraftRecipes: () => [], getItemSource: () => null } } as never),
      behaviors: { list: () => [], get: () => undefined } as never,
      tasks: {} as never,
      parentTaskId: () => null,
      actionProviders: [{ id: 'test.provider', list }],
    });
    const criteria = [{ type: 'predicate', predicate: 'agriculture.harvest_to_chest' }] as GoalSuccessCriterion[];
    assert.deepEqual(await port.listCandidates({
      state: state(criteria), planNodeId: 'task-1', signal: new AbortController().signal,
    }), []);
  }
});

test('BUG-CROSS-59 · chest retrieval exposes only grounded withdraw behavior candidates', async () => {
  const torchStrategy = {
    id: 'strat-deliver-torch', name: 'deliver_torch_to_friend', description: 'deliver a torch to friend', params: [],
    applicability: { appliesTo: ['friend'] },
    bt: { type: 'action', atomic: 'toss_item', args: { itemName: 'torch', count: 1 } },
    lifecycle: { state: 'trusted', confidence: 1, trialRuns: 3, cleanSuccess: 3, deps: [], ownerVerdict: null },
  };
  const port = new GoalAgentProductionExecutionPort({
    atomicContext: () => ({ game: { getCraftRecipes: () => [] } } as never),
    behaviors: { list: () => [{ id: 'withdraw_from_chest' }] } as never,
    tasks: {} as never,
    parentTaskId: () => null,
    resolveChestTargets: () => [{ pos: { x: 9, y: 64, z: 4 }, relation: 'left', distance: 3 }],
    strategyStore: { usable: () => [torchStrategy] } as never,
  });
  const candidates = await port.listCandidates({
    state: state([{ type: 'inventory', item: 'iron_pickaxe', count: 1 }], 'Go to the chest on my left and bring me an iron pickaxe'),
    planNodeId: 'task-1',
    signal: new AbortController().signal,
  });
  assert.deepEqual(candidates.map(candidate => candidate.id), ['behavior:withdraw_from_chest:9:64:4']);
  assert.deepEqual(candidates[0].fixedArgs, {
    behavior: 'withdraw_from_chest',
    behaviorParams: { chestPos: { x: 9, y: 64, z: 4 }, item: 'iron_pickaxe', count: 1 },
  });
  assert.ok(candidates.every(candidate => !candidate.id.includes('torch')));
});

test('BUG-CROSS-60 · delivery exposes only the grounded owner handoff behavior', async () => {
  const deliveryState = state([{ type: 'item_delivered', item: 'iron_pickaxe', count: 1, since: 100 }], 'Deliver the iron pickaxe to the user');
  deliveryState.world.latest = {
    ...world(),
    owner: { username: 'owner', position: { x: 4, y: 64, z: 0 }, distance: 4, entityId: 7, isVisible: true },
    inventory: { items: [{ name: 'iron_pickaxe', count: 1, slot: 0 }], held: null, freeSlots: 35 },
  };
  const port = new GoalAgentProductionExecutionPort({
    atomicContext: () => ({ game: { getCraftRecipes: () => [] } } as never),
    behaviors: { list: () => [{ id: 'deliver_to_owner' }] } as never,
    tasks: {} as never,
    parentTaskId: () => null,
  });

  const candidates = await port.listCandidates({
    state: deliveryState,
    planNodeId: 'task-1',
    signal: new AbortController().signal,
  });

  assert.deepEqual(candidates.map(candidate => candidate.id), ['behavior:deliver_to_owner:iron_pickaxe']);
  assert.deepEqual(candidates[0].fixedArgs, {
    behavior: 'deliver_to_owner',
    behaviorParams: { item: 'iron_pickaxe', count: 1 },
  });
});

test('BUG-CROSS-69 · inventory milestone prefers the nearest exact grounded item', async () => {
  const pickupState = state([{ type: 'inventory', item: 'iron_pickaxe', count: 1 }], 'Pick up the iron pickaxe from the ground');
  pickupState.world.latest = {
    ...world(),
    entities: [
      { id: 42, name: 'item', type: 'object', position: { x: 7, y: 64, z: 0 }, distance: 7, category: 'item', droppedItem: { name: 'iron_pickaxe', count: 1 } },
      { id: 41, name: 'item', type: 'object', position: { x: 5, y: 64, z: 0 }, distance: 5, category: 'item', droppedItem: { name: 'iron_pickaxe', count: 1 } },
      { id: 40, name: 'item', type: 'object', position: { x: 2, y: 64, z: 0 }, distance: 2, category: 'item', droppedItem: { name: 'stone_pickaxe', count: 1 } },
    ],
  };
  const port = new GoalAgentProductionExecutionPort({
    atomicContext: () => ({ game: { getCraftRecipes: () => [{ result: { name: 'iron_pickaxe', count: 1 } }] } } as never),
    behaviors: { list: () => [{ id: 'pickup_ground_item' }, { id: 'craft_one' }, { id: 'gather_block' }] } as never,
    tasks: {} as never,
    parentTaskId: () => null,
    resolveGatherTargets: () => [{ pos: { x: 9, y: 64, z: 0 }, blockName: 'iron_ore' }],
  });

  const candidates = await port.listCandidates({
    state: pickupState,
    planNodeId: 'task-1',
    signal: new AbortController().signal,
  });

  assert.deepEqual(candidates.map(candidate => candidate.id), ['behavior:pickup_ground_item:41']);
  assert.deepEqual(candidates[0].fixedArgs, {
    behavior: 'pickup_ground_item',
    behaviorParams: {
      item: 'iron_pickaxe', count: 1, itemEntityId: 41,
      position: { x: 5, y: 64, z: 0 },
    },
  });
});

test('BUG-CROSS-69 · a different grounded item does not create a pickup candidate', async () => {
  const pickupState = state([{ type: 'inventory', item: 'iron_pickaxe', count: 1 }]);
  pickupState.world.latest = {
    ...world(),
    entities: [{ id: 40, name: 'item', type: 'object', position: { x: 2, y: 64, z: 0 }, distance: 2, category: 'item', droppedItem: { name: 'stone_pickaxe', count: 1 } }],
  };
  const port = new GoalAgentProductionExecutionPort({
    atomicContext: () => ({ game: { getCraftRecipes: () => [] } } as never),
    behaviors: { list: () => [{ id: 'pickup_ground_item' }] } as never,
    tasks: {} as never,
    parentTaskId: () => null,
  });

  assert.deepEqual(await port.listCandidates({
    state: pickupState,
    planNodeId: 'task-1',
    signal: new AbortController().signal,
  }), []);
});

test('BUG-CROSS-61 · deposit exposes only the grounded target-chest behavior', async () => {
  const depositState = state(
    [{ type: 'item_deposited', item: 'cobblestone', count: 16, since: 100 }],
    'Deposit 16 cobblestone into the left chest',
  );
  depositState.rootGoal!.goalText = 'Move cobblestone from the right chest into the left chest';
  depositState.world.latest = {
    ...world(),
    inventory: { items: [{ name: 'cobblestone', count: 32, slot: 0 }], held: null, freeSlots: 35 },
  };
  let resolverText = '';
  const port = new GoalAgentProductionExecutionPort({
    atomicContext: () => ({ game: { getCraftRecipes: () => [] } } as never),
    behaviors: { list: () => [{ id: 'deposit_to_chest' }] } as never,
    tasks: {} as never,
    parentTaskId: () => null,
    resolveChestTargets: (_item, _count, requestText) => {
      resolverText = requestText;
      return [{ pos: { x: 9, y: 64, z: 4 }, relation: 'left', distance: 3 }];
    },
  });
  const candidates = await port.listCandidates({
    state: depositState,
    planNodeId: 'task-1',
    signal: new AbortController().signal,
  });
  assert.equal(resolverText, 'Deposit 16 cobblestone into the left chest');
  assert.deepEqual(candidates.map(candidate => candidate.id), ['behavior:deposit_to_chest:9:64:4']);
  assert.deepEqual(candidates[0].fixedArgs, {
    behavior: 'deposit_to_chest',
    behaviorParams: { chestPos: { x: 9, y: 64, z: 4 }, item: 'cobblestone', count: 16 },
  });
});

test('BUG-CROSS-61 · deposit candidate stays unavailable when inventory is insufficient', async () => {
  const depositState = state(
    [{ type: 'item_deposited', item: 'cobblestone', count: 16, since: 100 }],
    'Deposit 16 cobblestone into the left chest',
  );
  depositState.world.latest = {
    ...world(),
    inventory: { items: [{ name: 'cobblestone', count: 15, slot: 0 }], held: null, freeSlots: 35 },
  };
  const port = new GoalAgentProductionExecutionPort({
    atomicContext: () => ({ game: { getCraftRecipes: () => [] } } as never),
    behaviors: { list: () => [{ id: 'deposit_to_chest' }] } as never,
    tasks: {} as never,
    parentTaskId: () => null,
    resolveChestTargets: () => [{ pos: { x: 9, y: 64, z: 4 }, relation: 'left', distance: 3 }],
  });
  const candidates = await port.listCandidates({
    state: depositState,
    planNodeId: 'task-1',
    signal: new AbortController().signal,
  });
  assert.deepEqual(candidates, []);
});

test('BUG-CROSS-63 · block placement exposes only the grounded reference-relative behavior', async () => {
  const criteria: GoalSuccessCriterion[] = [{
    type: 'block_placed', item: 'crafting_table', count: 1, since: 100,
    relativeTo: 'owner', relation: 'near', radius: 1.5,
  }];
  const placementState = state(criteria, 'Place a crafting table near the owner');
  placementState.world.latest = {
    ...world(),
    owner: { username: 'owner', position: { x: 4.5, y: 64, z: 0.5 }, distance: 4, entityId: 7, isVisible: true, yaw: 0 },
    inventory: { items: [{ name: 'crafting_table', count: 1, slot: 0 }], held: null, freeSlots: 35 },
  };
  const port = new GoalAgentProductionExecutionPort({
    atomicContext: () => ({ game: { getCraftRecipes: () => [] } } as never),
    behaviors: { list: () => [{ id: 'place_relative' }] } as never,
    tasks: {} as never,
    parentTaskId: () => null,
  });
  const candidates = await port.listCandidates({
    state: placementState, planNodeId: 'task-1', signal: new AbortController().signal,
  });
  assert.deepEqual(candidates.map(candidate => candidate.id), [
    'behavior:place_relative:owner:crafting_table:near',
  ]);
  assert.deepEqual(candidates[0].fixedArgs, {
    behavior: 'place_relative',
    behaviorParams: { item: 'crafting_table', count: 1, relativeTo: 'owner', relation: 'near', radius: 1.5 },
  });
});

test('BUG-CROSS-74 · self-relative placement stays executable without a nearby owner', async () => {
  const placementState = state([{
    type: 'block_placed', item: 'crafting_table', count: 1, since: 100,
    relativeTo: 'self', relation: 'near', radius: 1.5,
  }], 'Place a crafting table at your own feet');
  placementState.world.latest = {
    ...world(), owner: null,
    inventory: { items: [{ name: 'crafting_table', count: 1, slot: 0 }], held: null, freeSlots: 35 },
  };
  const port = new GoalAgentProductionExecutionPort({
    atomicContext: () => ({ game: { getCraftRecipes: () => [] } } as never),
    behaviors: { list: () => [{ id: 'place_relative' }] } as never,
    tasks: {} as never, parentTaskId: () => null,
  });
  const candidates = await port.listCandidates({
    state: placementState, planNodeId: 'task-1', signal: new AbortController().signal,
  });
  assert.deepEqual(candidates.map(candidate => candidate.id), [
    'behavior:place_relative:self:crafting_table:near',
  ]);
  assert.deepEqual(candidates[0].fixedArgs, {
    behavior: 'place_relative',
    behaviorParams: { item: 'crafting_table', count: 1, relativeTo: 'self', relation: 'near', radius: 1.5 },
  });
});

test('BUG-CROSS-74 · satisfied craft milestone cannot hide an underfoot placement candidate', async () => {
  const criteria = [
    { type: 'inventory', item: 'crafting_table', count: 1 },
    { type: 'block_placed', item: 'crafting_table', count: 1, since: 100,
      relativeTo: 'owner', relation: 'underfoot', radius: 1.5 },
  ] as unknown as GoalSuccessCriterion[];
  const placementState = state(criteria, 'Craft a crafting table and place it underfoot');
  placementState.world.latest = {
    ...world(),
    owner: { username: 'owner', position: { x: 4.5, y: 64, z: 0.5 }, distance: 4, entityId: 7, isVisible: true, yaw: 0 },
    inventory: { items: [{ name: 'crafting_table', count: 1, slot: 0 }], held: null, freeSlots: 35 },
  };
  const port = new GoalAgentProductionExecutionPort({
    atomicContext: () => ({ game: { getCraftRecipes: () => [] } } as never),
    behaviors: { list: () => [{ id: 'place_relative' }] } as never,
    tasks: {} as never,
    parentTaskId: () => null,
  });
  const candidates = await port.listCandidates({
    state: placementState, planNodeId: 'task-1', signal: new AbortController().signal,
  });
  assert.deepEqual(candidates.map(candidate => candidate.id), [
    'behavior:place_relative:owner:crafting_table:near',
  ]);
  assert.deepEqual(candidates[0]?.fixedArgs, {
    behavior: 'place_relative',
    behaviorParams: { item: 'crafting_table', count: 1, relativeTo: 'owner', relation: 'near', radius: 1.5 },
  });
});

test('BUG-CROSS-66 · placement on a front block preserves top-surface semantics', async () => {
  const criteria:GoalSuccessCriterion[]=[{
    type:'block_placed',item:'torch',count:1,since:100,
    relativeTo:'owner',relation:'front',radius:1.5,
  }];
  const placementState=state(criteria,'把火把插在我面前这块石头上');
  placementState.world.latest={
    ...world(),
    owner:{username:'owner',position:{x:60.5,y:-60,z:37.5},distance:5,entityId:7,isVisible:true,yaw:Math.PI/2},
    inventory:{items:[{name:'torch',count:1,slot:0}],held:null,freeSlots:35},
  };
  const port=new GoalAgentProductionExecutionPort({
    atomicContext:()=>({game:{getCraftRecipes:()=>[]}} as never),
    behaviors:{list:()=>[{id:'place_relative'}]} as never,
    tasks:{} as never,parentTaskId:()=>null,
  });
  const candidates=await port.listCandidates({
    state:placementState,planNodeId:'task-1',signal:new AbortController().signal,
  });
  assert.deepEqual(candidates.map(candidate=>candidate.id),[
    'behavior:place_relative:owner:torch:front:top',
  ]);
  assert.deepEqual(candidates[0].fixedArgs,{
    behavior:'place_relative',
    behaviorParams:{item:'torch',count:1,relativeTo:'owner',relation:'front',radius:1.5,surface:'top'},
  });
});

test('BUG-CROSS-67 · owner-relative reached binds the latest owner position to move_to',async()=>{
  const criteria:GoalSuccessCriterion[]=[{type:'reached',relativeTo:'owner',radius:2}];
  const movementState=state(criteria,'过来我身边');
  movementState.world.latest={
    ...world(),
    owner:{username:'owner',position:{x:60.5,y:-60,z:37.5},distance:8,entityId:7,isVisible:true},
  };
  const candidates=await executionPort().listCandidates({
    state:movementState,planNodeId:'task-1',signal:new AbortController().signal,
  });
  const move=candidates.find(candidate=>candidate.id==='atomic:move_to');
  assert.ok(move);
  assert.deepEqual(move.fixedArgs,{position:{x:60.5,y:-60,z:37.5}});
});

test('action recovery excludes the exact candidate that just failed', async () => {
  const recovering = state([{ type: 'inventory', item: 'oak_log', count: 1 }]);
  recovering.verdict = {
    decision: 'revise_action', summary: 'try a different target', machineCriteriaSatisfied: false,
    ownerActionable: false, retryable: true, evidenceRefs: ['nav:path'],
  };
  recovering.action = {
    proposal: {
      source: 'registered_behavior', action: 'invoke_behavior', rationale: 'first target',
      args: {
        behavior: 'gather_block',
        behaviorParams: { blockName: 'oak_log', pos: { x: 1, y: 64, z: 0 } },
      },
    },
    result: {
      executionSessionId: 'execution-1', idempotencyKey: 'action-1', ok: false, detail: 'path stopped',
      startedAt: '2026-08-20T00:00:00.000Z', completedAt: '2026-08-20T00:00:01.000Z',
      evidenceRefs: ['nav:path'],
      failure: {
        code: 'atomic.path', origin: 'behavior', stage: 'executing', category: 'transient',
        retryable: true, ownerActionable: false, evidenceRefs: ['nav:path'], detail: 'path stopped',
      },
    },
    executionSessionId: 'execution-1', idempotencyKey: 'action-1',
  };
  const candidates = await executionPort().listCandidates({
    state: recovering,
    planNodeId: 'task-1',
    signal: new AbortController().signal,
  });
  assert.deepEqual(candidates.map(candidate => candidate.id), [
    'task:gather_material:oak_log',
    'behavior:gather_block:2',
    'behavior:gather_block:3',
    'behavior:gather_block:4',
  ]);
});

test('BUG-CROSS-74 · invoke_task waits for TaskRuntime completion and returns a structured receipt', async () => {
  const harness = managedTaskHarness();
  try {
    const controller = new AbortController();
    const execution = harness.port.execute({
      sessionId: 'goal-candidates', epoch: 1, idempotencyKey: 'managed-complete',
      proposal: {
        source: 'registered_task', action: 'invoke_task',
        args: { taskKind: 'gather_material', params: { material: 'oak_log', count: 1 } },
      },
      state: state([{ type: 'inventory', item: 'oak_log', count: 1 }]),
      signal: controller.signal,
    });
    const child = harness.tasks.list().find(task => task.parentId === harness.rootId)!;
    assert.equal(child.kind, 'gather_material');
    assert.equal(child.state, 'running');
    harness.tasks.complete(child.id);
    const result = await execution;
    assert.equal(result.ok, true);
    assert.match(result.detail, new RegExp(`gather_material:${child.id}:completed`));
  } finally { harness.memory.close(); }
});

test('BUG-CROSS-74 · invoke_task propagates TaskRuntime failure and cancels the child on abort', async () => {
  const failed = managedTaskHarness();
  try {
    const failurePromise = failed.port.execute({
      sessionId: 'goal-candidates', epoch: 1, idempotencyKey: 'managed-failed',
      proposal: {
        source: 'registered_task', action: 'invoke_task',
        args: { taskKind: 'gather_material', params: { material: 'oak_log', count: 1 } },
      },
      state: state([{ type: 'inventory', item: 'oak_log', count: 1 }]),
      signal: new AbortController().signal,
    });
    const child = failed.tasks.list().find(task => task.parentId === failed.rootId)!;
    failed.tasks.fail(child.id, { code: 'no_resource_found', detail: 'no oak logs in explored area' });
    const result = await failurePromise;
    assert.equal(result.ok, false);
    assert.match(result.detail, /no_resource_found/);
    assert.ok(result.failure);
  } finally { failed.memory.close(); }

  const aborted = managedTaskHarness();
  try {
    const controller = new AbortController();
    const abortPromise = aborted.port.execute({
      sessionId: 'goal-candidates', epoch: 1, idempotencyKey: 'managed-aborted',
      proposal: {
        source: 'registered_task', action: 'invoke_task',
        args: { taskKind: 'craft_item', params: { item: 'crafting_table', count: 1 } },
      },
      state: state([{ type: 'inventory', item: 'crafting_table', count: 1 }]),
      signal: controller.signal,
    });
    const child = aborted.tasks.list().find(task => task.parentId === aborted.rootId)!;
    controller.abort();
    const result = await abortPromise;
    assert.equal(result.ok, false);
    assert.equal(aborted.tasks.getById(child.id)?.state, 'cancelled');
    assert.match(result.detail, /cancelled/);
  } finally { aborted.memory.close(); }
});

test('BUG-CROSS-58 · production verifier accepts only delivery receipts at or after goal acceptance', () => {
  const criteria: GoalSuccessCriterion[] = [{ type: 'item_delivered', item: 'torch', count: 8, since: 100 }];
  const deliveryState = state(criteria);
  const before = new GoalAgentProductionVerificationPort(() => [
    { item: 'torch', count: 8, at: 99, ref: 'old-delivery' },
  ]);
  assert.equal(before.verifyTask({ state: deliveryState, planNodeId: 'task-1' }).ok, false);
  assert.equal(before.verifyRoot({ state: deliveryState }).ok, false);

  const after = new GoalAgentProductionVerificationPort(() => [
    { item: 'torch', count: 3, at: 100, ref: 'delivery-1' },
    { item: 'torch', count: 5, at: 101, ref: 'delivery-2' },
  ]);
  assert.equal(after.verifyTask({ state: deliveryState, planNodeId: 'task-1' }).ok, true);
  assert.equal(after.verifyRoot({ state: deliveryState }).ok, true);
});

test('BUG-CROSS-61 · production verifier accepts only deposit receipts at or after goal acceptance', () => {
  const criteria: GoalSuccessCriterion[] = [{ type: 'item_deposited', item: 'cobblestone', count: 16, since: 100 }];
  const depositState = state(criteria);
  const position = { x: 9, y: 64, z: 4 };
  const before = new GoalAgentProductionVerificationPort(
    () => [],
    () => [{ item: 'cobblestone', count: 16, at: 99, position, ref: 'old-deposit' }],
  );
  assert.equal(before.verifyTask({ state: depositState, planNodeId: 'task-1' }).ok, false);
  assert.equal(before.verifyRoot({ state: depositState }).ok, false);

  const after = new GoalAgentProductionVerificationPort(
    () => [],
    () => [
      { item: 'cobblestone', count: 8, at: 100, position, ref: 'deposit-1' },
      { item: 'cobblestone', count: 8, at: 101, position, ref: 'deposit-2' },
    ],
  );
  assert.equal(after.verifyTask({ state: depositState, planNodeId: 'task-1' }).ok, true);
  assert.equal(after.verifyRoot({ state: depositState }).ok, true);
});

test('BUG-CROSS-63 · production verifier requires a current owner-relative placement receipt', () => {
  const criteria: GoalSuccessCriterion[] = [{
    type: 'block_placed', item: 'crafting_table', count: 1, since: 100,
    relativeTo: 'owner', relation: 'near', radius: 1.5,
  }];
  const placementState = state(criteria);
  const referencePosition = { x: 10.5, y: 64, z: 10.5 };
  const position = { x: 11, y: 64, z: 10 };
  const before = new GoalAgentProductionVerificationPort(
    () => [], () => [],
    () => [{ item: 'crafting_table', count: 1, at: 99, position, relativeTo: 'owner', referencePosition, relation: 'near' }],
  );
  assert.equal(before.verifyRoot({ state: placementState }).ok, false);
  const after = new GoalAgentProductionVerificationPort(
    () => [], () => [],
    () => [{ item: 'crafting_table', count: 1, at: 101, position, relativeTo: 'owner', referencePosition, relation: 'near' }],
  );
  assert.equal(after.verifyTask({ state: placementState, planNodeId: 'task-1' }).ok, true);
  assert.equal(after.verifyRoot({ state: placementState }).ok, true);
});

function managedTaskHarness(): {
  memory: MemoryV2;
  tasks: TaskRuntime;
  rootId: string;
  port: GoalAgentProductionExecutionPort;
} {
  const memory = new MemoryV2(':memory:');
  const bus = new EventBusV2();
  const tasks = new TaskRuntime(memory, bus);
  const root = tasks.createTask('goal_exec', { goalAgentSessionId: 'goal-candidates' });
  tasks.startEmergency(root.id);
  const port = new GoalAgentProductionExecutionPort({
    atomicContext: () => ({
      bus,
      game: {
        getCraftRecipes: () => [],
        getItemSource: () => ({ block: 'oak_log', requiredTool: null }),
      },
    } as never),
    behaviors: { list: () => [] } as never,
    tasks,
    parentTaskId: () => root.id,
  });
  return { memory, tasks, rootId: root.id, port };
}
