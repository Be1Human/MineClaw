import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { RecipeInfo, ItemSource } from '../../../../../../../apps/minecraft-companion/src/bot/adapter/types.js';
import { ContextEncoder } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/planner/contextEncoder.js';
import { PlanGraphBuilder } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/planner/planGraphBuilder.js';
import { RecipeMilestonePlanner, type RecipeMilestoneKnowledge } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/planner/recipeMilestonePlanner.js';
import type { PlannerExperienceBundle } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/planner/experience/plannerExperienceProvider.js';

describe('FEAT-CROSS-14 · generic recipe cold-start milestones', () => {
  test('空背包铁镐展开工具等级、设施、熔炼和最终目标，且每个叶子有机器判据', () => {
    const planner = new RecipeMilestonePlanner(knowledge());
    const steps = planner.plan(goal(), new ContextEncoder().encode({ capabilities:['goal_agent'] }));
    assert.ok(steps && steps.length > 8);
    const stages = steps.map(value => value.stage);
    assertBefore(stages, 'obtain:wooden_pickaxe', 'obtain:cobblestone');
    assertBefore(stages, 'obtain:stone_pickaxe', 'obtain:raw_iron');
    assertBefore(stages, 'obtain:furnace', 'obtain:iron_ingot');
    assert.equal(stages.at(-1), 'complete:iron_pickaxe');
    assert.ok(steps.every(value => value.structuredSuccessCriteria?.length === 1));
    assert.deepEqual(steps.at(-1)?.structuredSuccessCriteria, [{ type:'inventory', item:'iron_pickaxe', count:1 }]);
    const cobblestone = steps.find(value => value.stage === 'obtain:cobblestone');
    assert.match(cobblestone?.goalText ?? '', /stone/);
    assert.match(cobblestone?.goalText ?? '', /cobblestone/);
    assert.match(cobblestone?.goalText ?? '', /wooden_pickaxe/);
    const rawIron = steps.find(value => value.stage === 'obtain:raw_iron');
    assert.match(rawIron?.goalText ?? '', /iron_ore/);
    assert.match(rawIron?.goalText ?? '', /stone_pickaxe/);
  });

  test('交付已有石镐只生成 deliver 叶子，不生成 obtain 叶子或库存持有完成判据',()=>{
    const delivery={id:'deliver',goalText:'给我一把石镐',taskFamily:'interaction',successCriteria:['delivered'],metadata:{targetId:'minecraft:stone_pickaxe',structuredSuccessCriteria:[{type:'item_delivered',item:'stone_pickaxe',count:1,since:100}]}};
    const context=new ContextEncoder().encode({inventory:{stone_pickaxe:2},capabilities:['goal_agent']});
    const steps=new RecipeMilestonePlanner(knowledge()).plan(delivery,context);
    assert.deepEqual(steps?.map(step=>step.stage),['deliver:stone_pickaxe']);
    assert.deepEqual(steps?.[0]?.structuredSuccessCriteria,[{type:'item_delivered',item:'stone_pickaxe',count:1,since:100}]);
  });

  test('Production Planner 无可信 Bundle 时使用通用知识多节点图，可信经验存在时优先使用经验', () => {
    const context = new ContextEncoder().encode({ capabilities:['goal_agent'] });
    const builder = new PlanGraphBuilder(new RecipeMilestonePlanner(knowledge()));
    const cold = builder.planFrozen(goal(), context, null, 'plan-cold');
    assert.ok(cold.nodes.length > 8);
    assert.ok(cold.nodes.every(node => node.goal.metadata?.structuredSuccessCriteria));
    assert.ok(cold.provenance.includes('novel_planner'));

    const bundle: PlannerExperienceBundle = {
      bundleId:'bundle:trusted',contentHash:'hash',policySnapshotId:'policy-fast@1',policyId:'policy-fast',policyIds:['policy-fast'],mode:'production' as const,
      policyVersion:1,policyRevision:1,confidenceLowerBound:.9,frozenAt:new Date(0).toISOString(),
      selectionManifestId:'manifest:trusted',selectionManifest:{id:'manifest:trusted',planRunId:'plan-trusted',query:{goalSignature:'obtain:item:minecraft:iron_pickaxe:1',contextSignatureHash:'ctx'},selected:[{experienceId:'schema:fast',policyId:'policy-fast',type:'task_schema' as const,score:1,reasons:['exact'],evidenceRefs:['episode:1']}],rejected:[]},
      taskSchemas:[{id:'schema:fast',stages:[{stage:'complete:iron_pickaxe',goalText:'快速制作铁镐',structuredSuccessCriteria:[{type:'inventory',item:'iron_pickaxe',count:1}]}]}],
      planFragments:[],planRecoveryPatterns:[],metaPolicies:[],applicability:[],evidenceRefs:['episode:1'],
    };
    const learned = builder.planFrozen(goal(), context, bundle, 'plan-trusted');
    assert.equal(learned.nodes.length, 1);
    assert.equal(learned.nodes[0]?.goal.goalText, '快速制作铁镐');
    assert.equal(learned.policySnapshotId, 'policy-fast@1');
  });

  test('只有失败恢复经验时保留通用冷启动结构，不把父任务压缩成单叶子', () => {
    const context = new ContextEncoder().encode({ capabilities:['goal_agent'] });
    const builder = new PlanGraphBuilder(new RecipeMilestonePlanner(knowledge()));
    const bundle: PlannerExperienceBundle = {
      bundleId:'bundle:recovery-only',contentHash:'hash-recovery',policySnapshotId:'candidate-iron@1',policyId:'candidate-iron',policyIds:['candidate-iron'],mode:'experiment',
      policyVersion:0,policyRevision:0,confidenceLowerBound:0,frozenAt:new Date(0).toISOString(),
      selectionManifestId:'manifest:recovery-only',selectionManifest:{id:'manifest:recovery-only',planRunId:'plan-recovery',query:{goalSignature:'obtain:item:minecraft:iron_pickaxe:1',contextSignatureHash:'ctx'},selected:[
        {experienceId:'schema:generic',policyId:'candidate-iron',type:'task_schema',score:1,reasons:['candidate_trial'],evidenceRefs:['failure:1']},
        {experienceId:'recovery:navigation',policyId:'candidate-iron',type:'recovery_pattern',score:1,reasons:['candidate_trial'],evidenceRefs:['failure:1']},
      ],rejected:[]},
      taskSchemas:[{id:'schema:generic',stages:['inspect_recipe','prepare_facilities','prepare_materials','craft','verify_inventory']}],
      planFragments:[],planRecoveryPatterns:[{id:'recovery:navigation',after:'navigation.failed'}],metaPolicies:[],applicability:[],evidenceRefs:['failure:1'],
      candidateId:'candidate-iron',candidateGeneration:1,candidateContentHash:'candidate-hash',experimentId:'experiment-1',experimentSplit:'selection',experimentAuthorizationId:'authorization-1',validationSpecId:'validation-1',
    };

    const planned = builder.planFrozen(goal(), context, bundle, 'plan-recovery');
    assert.ok(planned.nodes.length > 8);
    assert.ok(planned.nodes.every(node => node.goal.metadata?.structuredSuccessCriteria));
    assert.ok(planned.nodes.every(node => node.planRecoveryRefs.includes('recovery:navigation')));
    assert.ok(planned.nodes.every(node => !(node.experienceRefs??[]).includes('schema:generic')));
    assert.equal(planned.policySnapshotId, 'candidate-iron@1');
  });
});

function goal() {
  return {
    id:'goal-iron-pickaxe',
    goalText:'从空背包开始制作一把铁镐',
    taskFamily:'crafting',
    successCriteria:['iron_pickaxe >= 1'],
    metadata:{targetId:'minecraft:iron_pickaxe',structuredSuccessCriteria:[{type:'inventory',item:'iron_pickaxe',count:1}]},
  };
}

function knowledge(): RecipeMilestoneKnowledge {
  const recipes: Record<string, RecipeInfo[]> = {
    oak_planks:[recipe('oak_planks',4,[['oak_log',1]],false)],
    stick:[recipe('stick',4,[['oak_planks',2]],false)],
    crafting_table:[recipe('crafting_table',1,[['oak_planks',4]],false)],
    wooden_pickaxe:[recipe('wooden_pickaxe',1,[['oak_planks',3],['stick',2]],true)],
    stone_pickaxe:[recipe('stone_pickaxe',1,[['cobblestone',3],['stick',2]],true)],
    furnace:[recipe('furnace',1,[['cobblestone',8]],true)],
    iron_pickaxe:[recipe('iron_pickaxe',1,[['iron_ingot',3],['stick',2]],true)],
  };
  const sources: Record<string, ItemSource> = {
    oak_log:{block:'oak_log',requiredTool:null},
    cobblestone:{block:'stone',requiredTool:'wooden_pickaxe'},
    raw_iron:{block:'iron_ore',requiredTool:'stone_pickaxe'},
  };
  return {
    getCraftRecipes:item => recipes[item] ?? [],
    getItemSource:item => sources[item] ?? null,
    isMaterialNearby:() => true,
    isFacilityNearby:() => false,
  };
}

function recipe(result:string,count:number,ingredients:Array<[string,number]>,requiresTable:boolean):RecipeInfo {
  return {result:{name:result,count},ingredients:ingredients.map(([name,value])=>({name,count:value})),requiresTable};
}

function assertBefore(values:string[],left:string,right:string):void {
  const leftIndex=values.indexOf(left),rightIndex=values.indexOf(right);
  assert.ok(leftIndex>=0,`missing ${left}`);assert.ok(rightIndex>=0,`missing ${right}`);assert.ok(leftIndex<rightIndex,`${left} must precede ${right}`);
}
