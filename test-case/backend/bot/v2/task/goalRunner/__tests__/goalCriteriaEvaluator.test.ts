import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { WorldStateView } from '../../../../../../../apps/minecraft-companion/src/bot/v2/types.js';
import type { Goal } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/contracts/goalTypes.js';
import { evaluateGoalCriteria } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/goalRunner/goalCriteriaEvaluator.js';

function world(overrides: Partial<WorldStateView> = {}): WorldStateView {
  return {
    tick: 1,
    timestamp: Date.now(),
    self: { position: { x: 10, y: 64, z: 10 }, yaw: 0, pitch: 0, health: 20, maxHealth: 20, food: 20, isOnGround: true },
    owner: null,
    environment: { dimension: 'overworld', timeOfDay: 1000, isDay: true, isRaining: false },
    entities: [],
    inventory: { items: [], held: null, freeSlots: 36 },
    taskContext: null,
    ...overrides,
  };
}

function evaluate(goal: Goal, snapshot: WorldStateView | null = world()) {
  return evaluateGoalCriteria(goal, snapshot);
}

describe('BUG-CROSS-38 · Goal 成功判据 fail closed', () => {
  it('空判据和无世界快照均不得通过', () => {
    assert.equal(evaluate({ goalText: '做点事' }).ok, false);
    assert.match(evaluate({ goalText: '拿木头', successCriteria: [{ type: 'inventory', item: 'oak_log', count: 1 }] }, null).detail, /无世界快照/);
  });

  it('inventory 达成与未达成返回真实数量', () => {
    const goal: Goal = { goalText: '拿木头', successCriteria: [{ type: 'inventory', item: 'oak_log', count: 4 }] };
    const snapshot = world({ inventory: { items: [{ name: 'oak_log', count: 3, slot: 0 }], held: null, freeSlots: 35 } });
    assert.deepEqual(evaluate(goal, snapshot), { ok: false, detail: '判据 1：背包 oak_log 3/4' });
    snapshot.inventory.items[0]!.count = 4;
    assert.equal(evaluate(goal, snapshot).ok, true);
  });

  it('inventory_decrease 只在物品相对提交基线真实减少后通过',()=>{
    const goal:Goal={goalText:'给我一把石镐',successCriteria:[{type:'inventory_decrease',item:'stone_pickaxe',from:2,count:1}]};
    const before=world({inventory:{items:[{name:'stone_pickaxe',count:2,slot:0}],held:null,freeSlots:35}});
    assert.match(evaluate(goal,before).detail,/尚未减少/);
    const after=world({inventory:{items:[{name:'stone_pickaxe',count:1,slot:0}],held:null,freeSlots:35}});
    assert.equal(evaluate(goal,after).ok,true);
  });

  it('item_delivered 只接受提交时间后的 toss_item 成功证据',()=>{
    const goal:Goal={goalText:'给我一把石镐',successCriteria:[{type:'item_delivered',item:'stone_pickaxe',count:1,since:100}]};
    assert.match(evaluateGoalCriteria(goal,world(),{deliveries:[]}).detail,/尚无 toss_item 成功证据/);
    assert.match(evaluateGoalCriteria(goal,world(),{deliveries:[{item:'stone_pickaxe',count:1,at:99}]}).detail,/尚无/);
    assert.equal(evaluateGoalCriteria(goal,world(),{deliveries:[{item:'stone_pickaxe',count:1,at:101,ref:'atomic-1'}]}).ok,true);
  });

  it('BUG-CROSS-61 · item_deposited 只接受提交时间后的实际 deposit 数量',()=>{
    const goal:Goal={goalText:'把十六块圆石放进左箱',successCriteria:[{type:'item_deposited',item:'cobblestone',count:16,since:100}]};
    const position={x:9,y:64,z:4};
    assert.match(evaluateGoalCriteria(goal,world(),{deposits:[]}).detail,/尚无 deposit 成功证据/);
    assert.match(evaluateGoalCriteria(goal,world(),{deposits:[{item:'cobblestone',count:16,at:99,position}]}).detail,/尚无/);
    assert.match(evaluateGoalCriteria(goal,world(),{deposits:[{item:'cobblestone',count:15,at:101,position}]}).detail,/15\/16/);
    const result=evaluateGoalCriteria(goal,world(),{deposits:[{item:'cobblestone',count:16,at:101,position,ref:'deposit-1'}]});
    assert.equal(result.ok,true);
    assert.deepEqual(result.evidenceRefs,['criterion:item_deposited:cobblestone:16']);
  });

  it('BUG-CROSS-63 · block_placed 只接受本次且满足主人相对位置的稳定收据',()=>{
    const goal:Goal={goalText:'把工作台放在我脚边',successCriteria:[{
      type:'block_placed',item:'crafting_table',count:1,since:100,
      relativeTo:'owner',relation:'near',radius:1.5,
    }]};
    const base={
      item:'crafting_table',count:1,position:{x:11,y:64,z:10},
      relativeTo:'owner' as const,referencePosition:{x:10.5,y:64,z:10.5},relation:'near' as const,
    };
    assert.match(evaluateGoalCriteria(goal,world(),{placements:[{...base,at:99}]}).detail,/尚无满足位置/);
    assert.match(evaluateGoalCriteria(goal,world(),{placements:[{...base,at:101,item:'furnace'}]}).detail,/尚无满足位置/);
    assert.match(evaluateGoalCriteria(goal,world(),{placements:[{...base,at:101,position:{x:14,y:64,z:10}}]}).detail,/尚无满足位置/);
    const result=evaluateGoalCriteria(goal,world(),{placements:[{...base,at:101,ref:'place-1'}]});
    assert.equal(result.ok,true);
    assert.deepEqual(result.evidenceRefs,['criterion:block_placed:crafting_table:1:near']);
  });

  it('BUG-CROSS-74 · self-relative placement requires a matching self receipt, not inventory alone',()=>{
    const goal:Goal={goalText:'把工作台放在你脚下',successCriteria:[{
      type:'block_placed',item:'crafting_table',count:1,since:100,
      relativeTo:'self',relation:'near',radius:1.5,
    }]};
    assert.equal(evaluateGoalCriteria(goal, world(), { placements: [] }).ok, false);
    const receipt={
      item:'crafting_table',count:1,at:101,position:{x:11,y:64,z:10},
      relativeTo:'self' as const,referencePosition:{x:10.5,y:64,z:10.5},relation:'near' as const,
    };
    assert.equal(evaluateGoalCriteria(goal, world(), { placements: [{...receipt,relativeTo:'owner'}] }).ok, false);
    assert.equal(evaluateGoalCriteria(goal, world(), { placements: [receipt] }).ok, true);
  });

  it('reached 达成、未达成和自身位置缺失分别处理', () => {
    const goal: Goal = { goalText: '走过去', successCriteria: [{ type: 'reached', position: { x: 12, y: 64, z: 10 }, radius: 2 }] };
    assert.equal(evaluate(goal).ok, true);
    const far = world({ self: { ...world().self, position: { x: 0, y: 64, z: 0 } } });
    assert.match(evaluate(goal, far).detail, /距目标点/);
    const missing = { ...world(), self: null } as unknown as WorldStateView;
    assert.match(evaluateGoalCriteria(goal, missing).detail, /自身位置缺失/);
  });

  it('BUG-CROSS-67 · owner-relative reached 使用最新主人位置并在主人缺失时拒绝',()=>{
    const goal:Goal={goalText:'过来我身边',successCriteria:[{type:'reached',relativeTo:'owner',radius:2}]};
    const near=world({
      owner:{username:'owner',position:{x:11.5,y:64,z:10},distance:1.5,entityId:7,isVisible:true},
    });
    const result=evaluate(goal,near);
    assert.equal(result.ok,true);
    assert.deepEqual(result.evidenceRefs,['criterion:reached:owner:2']);
    const far=world({
      owner:{username:'owner',position:{x:20,y:64,z:10},distance:10,entityId:7,isVisible:true},
    });
    assert.match(evaluate(goal,far).detail,/距目标点/);
    assert.match(evaluate(goal,world()).detail,/reached 字段非法/);
  });

  it('entity_dead 仅在目标不再存活时通过', () => {
    const goal: Goal = { goalText: '击败僵尸', successCriteria: [{ type: 'entity_dead', entityName: 'zombie' }] };
    const alive = world({ entities: [{ id: 7, name: 'zombie', type: 'mob', position: { x: 11, y: 64, z: 10 }, distance: 1, category: 'hostile' }] });
    assert.match(evaluate(goal, alive).detail, /还活着/);
    const dead = evaluate(goal);
    assert.equal(dead.ok, true);
    assert.deepEqual(dead.evidenceRefs, ['criterion:entity_dead:zombie']);
    assert.match(dead.detail, /criterion:entity_dead:zombie/);
  });

  it('predicate、未知类型和多判据后项失败均 fail closed', () => {
    assert.match(evaluate({ goalText: '照亮', successCriteria: [{ type: 'predicate', predicate: 'area_lit_up' }] }).detail, /没有已注册机器验证器/);
    const unknown = { goalText: '未知', successCriteria: [{ type: 'magic' }] } as unknown as Goal;
    assert.match(evaluate(unknown).detail, /不支持的判据类型/);
    const andGoal: Goal = { goalText: '拿木头并到达', successCriteria: [
      { type: 'inventory', item: 'oak_log', count: 1 },
      { type: 'reached', position: { x: 30, y: 64, z: 10 }, radius: 1 },
    ] };
    const snapshot = world({ inventory: { items: [{ name: 'oak_log', count: 1, slot: 0 }], held: null, freeSlots: 35 } });
    assert.match(evaluate(andGoal, snapshot).detail, /^判据 2：距目标点/);
  });

  it('FEAT-CROSS-19 · registered predicate evaluator returns stable evidence and exceptions fail closed', () => {
    const goal: Goal = {
      goalText: '收割成熟农田并归仓',
      successCriteria: [{ type: 'predicate', predicate: 'agriculture.harvest_to_chest' }],
    };
    const passed = evaluateGoalCriteria(goal, world(), {
      predicateEvaluators: [{
        id: 'agriculture.harvest_to_chest',
        evaluate: () => ({
          ok: true,
          detail: 'mature=0,deposited=96,residue=0',
          evidenceRefs: ['crop:wheat:mature:0', 'deposit:wheat:96', 'ground:harvest:0'],
        }),
      }],
    });
    assert.equal(passed.ok, true);
    assert.deepEqual(passed.evidenceRefs, [
      'crop:wheat:mature:0', 'deposit:wheat:96', 'ground:harvest:0',
    ]);

    const thrown = evaluateGoalCriteria(goal, world(), {
      predicateEvaluators: [{
        id: 'agriculture.harvest_to_chest',
        evaluate: () => { throw new Error('block_fact_truncated'); },
      }],
    });
    assert.equal(thrown.ok, false);
    assert.match(thrown.detail, /block_fact_truncated/);
  });
});
