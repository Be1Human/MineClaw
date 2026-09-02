import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildDefaultToolRegistry, buildMainBrainToolRegistry, ToolRegistry } from '../../../../../../../apps/minecraft-companion/src/bot/v2/decision/tools/index.js';
import type { ToolContext, ToolDeps } from '../../../../../../../apps/minecraft-companion/src/bot/v2/decision/tools/types.js';

function makeDeps(): ToolDeps {
  const world = {
    tick: 0,
    timestamp: Date.now(),
    self: { position:{x:0,y:64,z:0}, yaw:0, pitch:0, health:20, maxHealth:20, food:20, isOnGround:true },
    owner: null,
    environment: { dimension:'overworld', timeOfDay:6000, isDay:true, isRaining:false },
    inventory: { items:[], held:null, freeSlots:36 },
    entities: [],
    taskContext: null,
  };
  return {
    bus: { publish:()=>{}, on:()=>()=>{}, onLevel:()=>()=>{}, onAny:()=>()=>{}, drain:()=>[] } as never,
    perception: { getWorldState:()=>world, perceive:()=>world } as never,
    tasks: { list:()=>[], active:()=>null } as never,
    game: { chat:()=>{} } as never,
    resolver: {
      resolve:()=>({ requirement:{kind:'item',name:'hoe'}, candidates:[] }),
      register:()=>{},
    } as never,
    policy: { decide:()=>({kind:'no_solution',reason:'test'}) } as never,
    ownerName: 'testOwner',
  };
}

describe('MainBrain tool boundary', () => {
  it('only exposes conversation, memory and the single GoalAgent port', () => {
    const registry = buildMainBrainToolRegistry({
      ...makeDeps(),
      goalAgentPort: { request:()=>({outcome:'consumed'} as never) },
    });
    const names = registry.toLLMSchemas().map(schema=>schema.function.name).sort();
    assert.deepEqual(names, ['ask_master','get_goal_status','save_memory','say','stay_silent','submit_goal_request']);
    for (const forbidden of [
      'decompose_task','create_task','start_task','complete_task','create_plan','submit_goals',
      'get_world_state','get_inventory','invoke_strategy',
    ]) assert.equal(registry.has(forbidden), false, forbidden);
  });

  it('forwards one intact task to GoalAgent without decomposing it', () => {
    const calls: unknown[] = [];
    const registry = buildMainBrainToolRegistry({
      ...makeDeps(),
      goalAgentPort: { request:input=>{ calls.push(input); return {outcome:'consumed'} as never; } },
    });
    const result = registry.call({
      tool:'submit_goal_request',
      input:{requestKind:'task',requestText:'从零开始制作一把铁镐',constraints:['保留在背包']},
    });
    assert.equal(result.ok, true);
    assert.deepEqual(calls, [{
      requestKind:'task', requestText:'从零开始制作一把铁镐',
      constraints:['保留在背包'],
    }]);
  });

  it('reads status without submitting a second goal', () => {
    let submitted = 0;
    const snapshot = {sessionId:'s1',requestId:'r1',state:'executing' as const,evidence:[],observedAt:'now'};
    const registry = buildMainBrainToolRegistry({
      ...makeDeps(),
      goalAgentPort: {
        request:()=>{submitted+=1;return {outcome:'consumed'} as never;},
        getCurrentStatus:()=>snapshot,
      },
    });
    assert.equal(registry.call({tool:'get_goal_status',input:{}}).ok, true);
    assert.equal(submitted, 0);
  });
});

describe('legacy direct task tools are absent', () => {
  it('does not register old queue, planner or TaskRuntime mutation tools anywhere', () => {
    const registry = buildDefaultToolRegistry(makeDeps());
    for (const name of [
      'decompose_task','create_task','start_task','update_task','complete_task','cancel_task',
      'pause_task','create_plan','submit_goals',
    ]) assert.equal(registry.has(name), false, name);
  });

  it('keeps non-agent capability utilities available to internal callers', () => {
    const registry = buildDefaultToolRegistry(makeDeps());
    assert.equal(registry.call({tool:'get_world_state',input:{}}).ok, true);
    assert.equal(registry.call({tool:'get_inventory',input:{}}).ok, true);
    assert.equal(registry.call({tool:'resolve_resource',input:{kind:'item',name:'hoe'}}).ok, true);
    assert.equal(registry.call({tool:'decide_with_policy',input:{}}).ok, true);
  });
});

describe('ToolRegistry contract', () => {
  function context(): ToolContext {
    return {...makeDeps(),lastResolution:null,speak:()=>{},recentOwnerText:()=>''};
  }

  it('rejects duplicate names and aliases', () => {
    const registry = new ToolRegistry(context());
    const definition = (name:string,callAliases?:string[]) => ({
      name, callAliases, description:'test', parameters:{type:'object' as const,properties:{}}, execute:()=>({ok:true}),
    });
    registry.register(definition('one'));
    assert.throws(()=>registry.register(definition('one')), /duplicate tool/);
    assert.throws(()=>registry.register(definition('two',['one'])), /duplicate tool/);
  });

  it('keeps schemas and registered implementations aligned', () => {
    const registry = buildDefaultToolRegistry(makeDeps());
    for (const schema of registry.toLLMSchemas()) {
      const definition = registry.get(schema.function.name);
      assert.ok(definition);
      assert.notEqual(definition.hidden, true);
    }
  });
});
