import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Goal } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/contracts/goalTypes.js';
import { StrategyMatcher, type MatcherDeps } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/strategy/strategyMatcher.js';
import { newLifecycle, type Strategy } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/strategy/strategyTypes.js';

function strategy(id:string,over?:Partial<Strategy>):Strategy {
  return {
    id,name:id,description:'走到目标面前用近战武器攻击直到死亡',params:['target'],
    applicability:{appliesTo:['hostile_entity','player'],excludes:['owner','friendly']},
    bt:{type:'action',atomic:'attack',args:{entity:'{target}'}},
    lifecycle:{...newLifecycle(1000),state:'trusted',confidence:0.9},
    ...over,
  };
}

function itemStrategy(id:string,item:string,appliesTo:string[]=[item]):Strategy {
  return strategy(id,{
    description:`制作 ${item}`,params:['item','count'],
    applicability:{appliesTo,excludes:[]},
    bt:{type:'action',atomic:'craft',args:{item:'{item}',count:'{count}'}},
  });
}

const world = {self:{position:{x:0,y:0,z:0}},entities:[],inventory:{items:[]}} as never;

test('命中后只做确定性抽参，不调用独立 LLM', async () => {
  const deps:MatcherDeps={usable:()=>[strategy('attack-hostile')],categorizeTarget:()=>['hostile_entity']};
  const goal:Goal={goalText:'教训那个僵尸',successCriteria:[{type:'entity_dead',entityId:'99'}]};
  const result=await new StrategyMatcher(deps).resolve(goal,world);
  assert.equal(result?.strategy.id,'attack-hostile');
  assert.equal(result?.bind.target,'99');
  assert.equal('semanticPick' in deps,false);
});

test('库空返回 null', async () => {
  assert.equal(await new StrategyMatcher({usable:()=>[]}).resolve({goalText:'x'},world),null);
});

test('owner 安全闸拒绝攻击策略', async () => {
  const matcher=new StrategyMatcher({usable:()=>[strategy('attack')],categorizeTarget:()=>['owner']});
  assert.equal(await matcher.resolve({goalText:'攻击朋友',successCriteria:[{type:'entity_dead',entityName:'qxy'}]},world),null);
});

test('前置谓词不满足时拒绝', async () => {
  const matcher=new StrategyMatcher({
    usable:()=>[strategy('attack',{applicability:{preconditions:['has_melee_weapon'],excludes:[]}})],
    checkPredicate:()=>false,categorizeTarget:()=>['hostile_entity'],
  });
  assert.equal(await matcher.resolve({goalText:'攻击僵尸',successCriteria:[{type:'entity_dead',entityId:'1'}]},world),null);
});

test('声明前置谓词但生产检查器缺失时失败关闭', async () => {
  const matcher=new StrategyMatcher({
    usable:()=>[strategy('attack',{applicability:{preconditions:['has_melee_weapon'],excludes:[]}})],
    categorizeTarget:()=>['hostile_entity'],
  });
  assert.equal(await matcher.resolve({goalText:'攻击僵尸',successCriteria:[{type:'entity_dead',entityId:'1'}]},world),null);
});

test('block_placed 目标按策略 BT 的硬编码物品作用域过滤', async () => {
  const hardcodedTorch=strategy('deliver-torch',{
    description:'deliver torch',
    applicability:{appliesTo:['player'],excludes:[]},
    bt:{type:'action',atomic:'toss_item',args:{itemName:'torch',count:1}},
  });
  const matcher=new StrategyMatcher({usable:()=>[hardcodedTorch],categorizeTarget:()=>['player']});
  assert.equal(await matcher.resolve({
    goalText:'在主人附近放一个工作台',
    successCriteria:[{type:'block_placed',item:'crafting_table',count:1,relativeTo:'owner',relation:'near'}],
  },world),null);
});

test('BUG-CROSS-54 · inventory 物品失配在候选生成前被硬过滤', async () => {
  const matcher=new StrategyMatcher({usable:()=>[itemStrategy('craft-pickaxe','minecraft:iron_pickaxe')]});
  const result=await matcher.resolve({
    goalText:'为了最终制作铁镐，先准备材料',context:'父目标是制作 minecraft:iron_pickaxe',
    successCriteria:[{type:'inventory',item:'minecraft:iron_ingot',count:3}],
  },world);
  assert.equal(result,null);
});

test('BUG-CROSS-54 · inventory 精确物品作用域可命中并绑定当前叶子', async () => {
  const matcher=new StrategyMatcher({usable:()=>[
    itemStrategy('craft-shield','minecraft:shield'),
    itemStrategy('craft-pickaxe','minecraft:iron_pickaxe'),
  ]});
  const result=await matcher.resolve({
    goalText:'制作铁镐',successCriteria:[{type:'inventory',item:'iron_pickaxe',count:1}],
  },world);
  assert.equal(result?.strategy.id,'craft-pickaxe');
  assert.deepEqual(result?.bind,{item:'iron_pickaxe',count:1});
});

test('BUG-CROSS-54 · 实体 category 逻辑不受物品作用域硬门影响', async () => {
  const mixed=itemStrategy('mixed','minecraft:iron_pickaxe',['minecraft:iron_pickaxe','hostile_entity']);
  const matcher=new StrategyMatcher({usable:()=>[mixed],categorizeTarget:()=>['hostile_entity']});
  const result=await matcher.resolve({
    goalText:'攻击僵尸',successCriteria:[{type:'entity_dead',entityId:'zombie-1'}],
  },world);
  assert.equal(result?.strategy.id,'mixed');
});

test('BUG-CROSS-54 · 多 inventory 判据任一作用域命中即可进入候选', async () => {
  const matcher=new StrategyMatcher({usable:()=>[itemStrategy('craft-pickaxe','minecraft:iron_pickaxe')]});
  const result=await matcher.resolve({
    goalText:'准备铁锭并制作铁镐',successCriteria:[
      {type:'inventory',item:'minecraft:iron_ingot',count:3},
      {type:'inventory',item:'minecraft:iron_pickaxe',count:1},
    ],
  },world);
  assert.equal(result?.strategy.id,'craft-pickaxe');
  assert.deepEqual(result?.bind,{item:'minecraft:iron_pickaxe',count:1});
});
