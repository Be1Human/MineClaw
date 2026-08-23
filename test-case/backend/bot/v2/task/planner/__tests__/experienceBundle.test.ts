import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlannerPolicyStore, type PlannerPolicyContent } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/planner/evolution/policyStore.js';
import { PlannerExperienceProvider } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/planner/experience/plannerExperienceProvider.js';
import type { ContextSignature, GoalSignature } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/planner/plannerContracts.js';
import { EvolutionGraphStore } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/planner/evolution/evolutionGraphStore.js';
import { EvolutionProjector } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/planner/evolution/evolutionProjector.js';

describe('FEAT-CROSS-14-006-002 · trusted graph to frozen bundle', () => {
  test('同族目标级 Policy 共存并按最终目标组合可信依赖经验', () => {
    const store = new PlannerPolicyStore(':memory:');
    promote(store, 'policy-workbench', 1, content('minecraft:crafting_table', 'fragment:workbench', true), .82);
    promote(store, 'policy-pickaxe', 2, content('minecraft:iron_pickaxe', 'fragment:pickaxe', true), .84);
    promote(store, 'policy-rail', 3, content('minecraft:rail', 'fragment:rail'), .91);
    assert.deepEqual(store.listTrustedForTaskFamily('crafting').map(value => value.id).sort(), [
      'policy-pickaxe', 'policy-rail', 'policy-workbench',
    ]);

    const provider = new PlannerExperienceProvider(store);
    const first = provider.freeze(request());
    assert.equal(first.status, 'frozen');
    if (first.status !== 'frozen') return;
    assert.deepEqual([...first.bundle.policyIds].sort(), ['policy-pickaxe', 'policy-rail', 'policy-workbench']);
    assert.equal(first.bundle.planFragments.length, 3);
    assert.ok(first.bundle.selectionManifest.selected.some(value => value.experienceId === 'fragment:workbench'));
    assert.ok(first.bundle.selectionManifest.selected.some(value => value.experienceId === 'fragment:pickaxe'));
    assert.ok(first.bundle.selectionManifest.selected.some(value => value.experienceId === 'fragment:rail'));
    assert.equal(Object.isFrozen(first.bundle), true);

    const second = provider.freeze(request());
    assert.equal(second.status, 'frozen');
    if (second.status === 'frozen') {
      assert.equal(second.bundle.bundleId, first.bundle.bundleId);
      assert.equal(second.bundle.contentHash, first.bundle.contentHash);
      assert.equal(second.bundle.selectionManifestId, first.bundle.selectionManifestId);
    }
    store.close();
  });

  test('硬过滤发生在排序前，生产 Bundle 不含未信任、过期、低置信或运行时控制数据', () => {
    const store = new PlannerPolicyStore(':memory:');
    promote(store, 'trusted-rail', 1, content('minecraft:rail', 'fragment:trusted'), .9);
    store.createCandidate({ id:'candidate-rail', version:2, content:content('minecraft:rail','fragment:candidate'), evidenceIds:['e-c'], confidenceLowerBound:.99 });
    promote(store, 'expired-rail', 3, content('minecraft:expired_rail','fragment:expired',true,{expiresAt:'2020-01-01T00:00:00.000Z'}), .99);
    promote(store, 'unsafe-rail', 4, {
      ...content('minecraft:unsafe_rail','fragment:unsafe',true),
      planFragments:[{id:'fragment:unsafe',preparedAction:{name:'craft'}}],
    }, .99);
    promote(store, 'weak-rail', 5, content('minecraft:weak_rail','fragment:weak',true), .2);

    const result = new PlannerExperienceProvider(store).freeze(request());
    assert.equal(result.status, 'frozen');
    if (result.status !== 'frozen') return;
    assert.deepEqual(result.bundle.policyIds, ['trusted-rail']);
    const reasons = new Map(result.bundle.selectionManifest.rejected.map(value => [value.policyId, value.reason]));
    assert.equal(reasons.get('candidate-rail'), 'not_trusted');
    assert.equal(reasons.get('expired-rail'), 'expired');
    assert.equal(reasons.get('unsafe-rail'), 'unsafe');
    assert.equal(reasons.get('weak-rail'), 'low_confidence');
    store.close();
  });

  test('无匹配、低置信和损坏图谱均返回显式冷启动原因', () => {
    const empty = new PlannerPolicyStore(':memory:');
    assert.equal(new PlannerExperienceProvider(empty).freeze(request()).status, 'cold_start');
    const weak = new PlannerPolicyStore(':memory:');
    promote(weak, 'weak', 1, content('minecraft:rail','fragment:weak'), .1);
    const weakResult = new PlannerExperienceProvider(weak).freeze(request());
    assert.deepEqual({ status:weakResult.status, reason:weakResult.status==='cold_start'?weakResult.reason:null }, { status:'cold_start', reason:'low_confidence' });
    const corrupt = new PlannerPolicyStore(':memory:');
    promote(corrupt, 'corrupt', 1, { ...content('minecraft:rail','fragment:bad'), planFragments:null } as unknown as PlannerPolicyContent, .9);
    const corruptResult = new PlannerExperienceProvider(corrupt).freeze(request());
    assert.deepEqual({ status:corruptResult.status, reason:corruptResult.status==='cold_start'?corruptResult.reason:null }, { status:'cold_start', reason:'graph_corrupt' });
    empty.close();weak.close();corrupt.close();
  });

  test('生产 Provider 以知识图谱投影作为可信经验硬门，缺图或断边时 fail closed', () => {
    const root=mkdtempSync(join(tmpdir(),'planner-graph-retrieval-')),dbPath=join(root,'evolution.db');
    const policies=new PlannerPolicyStore(dbPath),graph=new EvolutionGraphStore(dbPath);
    try{
      promote(policies,'policy-rail',1,content('minecraft:rail','fragment:rail'),.9);
      const withoutProjection=new PlannerExperienceProvider(policies,undefined,graph).freeze(request());
      assert.deepEqual({status:withoutProjection.status,reason:withoutProjection.status==='cold_start'?withoutProjection.reason:null},{status:'cold_start',reason:'graph_corrupt'});

      const projector=new EvolutionProjector(graph);
      projector.projectPolicy(policies.get('policy-rail')!);
      const frozen=new PlannerExperienceProvider(policies,undefined,graph).freeze(request());
      assert.equal(frozen.status,'frozen');
      if(frozen.status==='frozen'){
        assert.ok(frozen.bundle.selectionManifest.selected.every(entry=>entry.reasons.includes('knowledge_graph_verified')));
        assert.ok(graph.getNode(`policy:${frozen.bundle.policyId}`));
        assert.ok(graph.getNode('fragment:rail'));
      }
    }finally{graph.close();policies.close();rmSync(root,{recursive:true,force:true});}
  });

  test('长期证据只嵌入有界引用，完整历史不复制到每个 Bundle', () => {
    const store=new PlannerPolicyStore(':memory:');
    const evidenceIds=Array.from({length:100},(_,index)=>`evidence:${index+1}`);
    const created=store.createCandidate({id:'bounded-rail',version:1,content:content('minecraft:rail','fragment:bounded'),evidenceIds,confidenceLowerBound:.9});
    assert.equal(created.evidenceIds.length,32);
    store.promote(created.id,created.revision,{decision:'promote',selectionDelta:.1,hiddenRegression:false,safetyViolations:0,evaluationId:'eval:bounded'});
    const result=new PlannerExperienceProvider(store).freeze(request());
    assert.equal(result.status,'frozen');
    if(result.status==='frozen'){
      assert.ok(result.bundle.evidenceRefs.length<=32);
      assert.ok(result.bundle.selectionManifest.selected.every(entry=>entry.evidenceRefs.length<=8));
      assert.equal(new Set(result.bundle.evidenceRefs).size,result.bundle.evidenceRefs.length);
    }
    store.close();
  });
});

function content(targetId:string,fragmentId:string,dependency=false,extra:Record<string,unknown>={}):PlannerPolicyContent {
  return {
    taskSchemas:[{id:`schema:${targetId}`,stages:['inspect_recipe','prepare_materials','craft','verify_inventory']}],
    planFragments:[{id:fragmentId,action:fragmentId}],planRecoveryPatterns:[],metaPolicies:[],
    applicability:[{taskFamily:'crafting',targetId,...(dependency?{role:'dependency',supportsTargets:['minecraft:rail']}:{}),...extra}],
  };
}
function promote(store:PlannerPolicyStore,id:string,version:number,value:PlannerPolicyContent,confidenceLowerBound:number):void {
  const candidate=store.createCandidate({id,version,content:value,evidenceIds:[`episode:${id}`],confidenceLowerBound});
  store.promote(id,candidate.revision,{decision:'promote',selectionDelta:.1,hiddenRegression:false,safetyViolations:0,evaluationId:`eval:${id}`});
}
function request(){return {planRunId:'plan-rail-1',goalSignature:signature(),context:context(),mode:'production' as const};}
function signature():GoalSignature{return {key:'obtain:item:minecraft:rail:16',outcome:'obtain',targetKind:'item',targetId:'minecraft:rail',quantity:16,constraintsHash:'none',compatibleTaskFamilies:['crafting'],schemaVersion:1};}
function context():ContextSignature{return {inventory:{},capabilities:['goal_queue','goal_agent','atomic_registry'],nearbyFacilities:[],nearbyResources:[],timeBucket:'day',dangerLevel:0,positionRegion:'region:0,0',worldRevision:'tick:1'};}
