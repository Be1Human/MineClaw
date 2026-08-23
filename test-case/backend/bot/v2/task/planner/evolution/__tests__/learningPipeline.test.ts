import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EpisodeLedger } from '../../../../../../../../apps/minecraft-companion/src/bot/v2/task/planner/evolution/episodeLedger.js';
import { EvolutionGraphStore } from '../../../../../../../../apps/minecraft-companion/src/bot/v2/task/planner/evolution/evolutionGraphStore.js';
import { PlannerPolicyStore } from '../../../../../../../../apps/minecraft-companion/src/bot/v2/task/planner/evolution/policyStore.js';
import { PlannerLearningStore, type CandidateValidationRun } from '../../../../../../../../apps/minecraft-companion/src/bot/v2/task/planner/evolution/learningStore.js';
import { EvolutionProjector } from '../../../../../../../../apps/minecraft-companion/src/bot/v2/task/planner/evolution/evolutionProjector.js';
import { PlannerEvolutionEngine } from '../../../../../../../../apps/minecraft-companion/src/bot/v2/task/planner/evolution/plannerEvolutionEngine.js';
import { ExperienceAttributor } from '../../../../../../../../apps/minecraft-companion/src/bot/v2/task/planner/evolution/attributor.js';
import { EvalGate, type PolicyMetrics } from '../../../../../../../../apps/minecraft-companion/src/bot/v2/task/planner/evolution/evalGate.js';
import { PlannerExperienceProvider } from '../../../../../../../../apps/minecraft-companion/src/bot/v2/task/planner/experience/plannerExperienceProvider.js';
import { PlanGraphBuilder } from '../../../../../../../../apps/minecraft-companion/src/bot/v2/task/planner/planGraphBuilder.js';
import { ContextEncoder } from '../../../../../../../../apps/minecraft-companion/src/bot/v2/task/planner/contextEncoder.js';
import { canonicalGoalText, inferPlannerTaskFamily } from '../../../../../../../../apps/minecraft-companion/src/bot/v2/task/planner/evolution/goalCanonicalizer.js';
import { EXECUTION_FACT_SCHEMA_V1, type ExecutionFactEnvelopeV1, type FailureEnvelopeV1 } from '../../../../../../../../apps/minecraft-companion/src/bot/v2/task/planner/evolution/contracts/executionFactsV1.js';
import { candidateIdentity } from '../../../../../../../../apps/minecraft-companion/src/bot/v2/task/planner/evolution/candidateIdentity.js';
import { ResearchAgenda } from '../../../../../../../../apps/minecraft-companion/src/bot/v2/task/planner/evolution/researchAgenda.js';

const tempDirs: string[] = [];
afterEach(() => { for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive:true, force:true }); });

describe('FEAT-CROSS-14 · learning pipeline', () => {
  test('ResearchAgenda 刷新与重启不补满已消费的重试预算', () => {
    const dir=mkdtempSync(join(tmpdir(),'agenda-budget-'));tempDirs.push(dir);
    const db=join(dir,'evolution.db');
    const candidate={
      id:'candidate:agenda-budget',taskFamily:'crafting',goalPattern:'制作测试物品',
      content:{taskSchemas:[{id:'schema:test'}],planFragments:[],planRecoveryPatterns:[],metaPolicies:[],applicability:[]},
      evidenceIds:['episode:seed'],positiveEpisodeIds:['episode:seed'],negativeEpisodeIds:[],
      confidenceLowerBound:.4,status:'candidate' as const,
      validationSpec:{id:'validation:test',validatorId:'inventory',primaryMetric:'success_rate' as const,minimumSelectionSamples:2,minimumHiddenSamples:1,pairing:'snapshot_pair' as const,treatmentField:'planner_policy'},
    };
    let store=new PlannerLearningStore(db);store.upsertCandidate(candidate);
    let agenda=new ResearchAgenda(store);
    assert.equal(agenda.schedule([candidate])[0]?.retryBudget,2);
    assert.equal(agenda.settle(candidate.id,'inconclusive').retryBudget,1);
    assert.equal(agenda.schedule([candidate])[0]?.retryBudget,1);
    store.close();

    store=new PlannerLearningStore(db);agenda=new ResearchAgenda(store);
    assert.equal(agenda.schedule([candidate])[0]?.retryBudget,1);
    const exhausted=agenda.settle(candidate.id,'inconclusive');
    assert.equal(exhausted.retryBudget,0);assert.equal(exhausted.status,'backlog');
    const refreshed=agenda.schedule([candidate])[0]!;
    assert.equal(refreshed.retryBudget,0);assert.equal(refreshed.status,'backlog');assert.equal(refreshed.reason,'retry_exhausted');
    store.close();
  });

  test('结构化 FailureEnvelope 被隔离为六类责任，取消和缺终态保持 confounded', () => {
    const attributor = new ExperienceAttributor();
    const cases: Array<[FailureEnvelopeV1['origin'], string]> = [
      ['decision','planning_error'], ['navigation','execution_error'], ['perception','perception_error'],
      ['environment','environment_impossible'], ['infra','infra_failure'], ['safety','safety_violation'],
    ];
    for (const [origin, expected] of cases) {
      const ledger = new EpisodeLedger(':memory:');
      ledger.appendFact(started('s', 1));
      const terminalFact=terminal('s',2,'failed',failure(origin));
      ledger.appendFact(origin==='navigation'?{...terminalFact,payload:{...terminalFact.payload,handoff:'none'}}:terminalFact);
      const episode = ledger.getEpisode('s');
      assert.ok(episode);
      assert.equal(attributor.classify(episode).category, expected);
      ledger.close();
    }
    const graphLedger=new EpisodeLedger(':memory:');
    graphLedger.appendFact(started('graph-handoff',1));
    graphLedger.appendFact(terminal('graph-handoff',2,'failed',{...failure('navigation'),origin:'behavior'}));
    const graphAttribution=attributor.classify(graphLedger.getEpisode('graph-handoff')!);
    assert.equal(graphAttribution.category,'planning_error');
    assert.equal(graphAttribution.learnable,true);
    assert.equal(graphAttribution.reason,'graph_replan:navigation.failure');
    assert.equal(graphAttribution.failure?.origin,'behavior');
    graphLedger.close();
  });

  test('已预先满足且明确无进展的成功 Episode 不进入学习，并回收仅由其支撑的候选', async () => {
    const m = modules();
    const source = new MutableSource();
    source.push(
      started('pre-satisfied', 1),
      proposed('pre-satisfied', 2, 'combat'),
      base('pre-satisfied', 3, 'execution.progress.observed', { meaningful:false, changedCriteria:[], worldEffects:[] }),
      terminal('pre-satisfied', 4, 'succeeded'),
    );
    await m.engine.catchUp(source);

    const episode = m.ledger.getEpisode('pre-satisfied')!;
    assert.deepEqual(
      (({ category, learnable, reason }) => ({ category, learnable, reason }))(new ExperienceAttributor().classify(episode)),
      { category:'success', learnable:false, reason:'goal_pre_satisfied_no_progress' },
    );
    assert.equal(m.learning.listCandidates().length, 0);

    const pollutedId = 'candidate:legacy-pre-satisfied';
    m.learning.upsertCandidate({
      id:pollutedId,
      taskFamily:'combat',
      goalPattern:'清理僵尸',
      content:{ taskSchemas:[], planFragments:[], planRecoveryPatterns:[], metaPolicies:[], applicability:[] },
      evidenceIds:['pre-satisfied-3'],
      positiveEpisodeIds:['pre-satisfied'],
      negativeEpisodeIds:[],
      confidenceLowerBound:1,
      status:'candidate',
    });
    m.learning.upsertAgenda({
      candidateId:pollutedId,
      status:'queued',
      expectedInformationGain:1,
      uncertainty:0,
      impactScope:1,
      estimatedCost:1,
      safetyRisk:0,
      headroom:0,
      retryBudget:2,
    });
    m.engine.refreshCandidates();
    assert.equal(m.learning.getCandidate(pollutedId)?.status, 'backlog');
    assert.equal(m.learning.listAgenda().find(item => item.candidateId === pollutedId)?.reason, 'candidate_evidence_no_longer_learning_eligible');

    source.push(
      started('meaningful-success', 1),
      proposed('meaningful-success', 2, 'combat'),
      base('meaningful-success', 3, 'execution.progress.observed', { meaningful:true, changedCriteria:['0:entity_dead'], worldEffects:['relevant_entities_changed'] }),
      terminal('meaningful-success', 4, 'succeeded'),
    );
    await m.engine.catchUp(source);
    assert.equal(new ExperienceAttributor().classify(m.ledger.getEpisode('meaningful-success')!).learnable, true);
    assert.ok(m.learning.listCandidates().some(candidate => candidate.positiveEpisodeIds.includes('meaningful-success')));
    m.close();
  });

  test('执行事实自动形成 Episode、归因、候选、图谱与研究议程', async () => {
    const m = modules();
    const source = new ArraySource([
      started('success',1), proposed('success',2,'gather'), terminal('success',3,'succeeded'),
      started('planning',1), terminal('planning',2,'failed',failure('decision')),
      started('infra',1), terminal('infra',2,'failed',failure('infra')),
    ]);
    const summary = await m.engine.catchUp(source);
    assert.equal(summary.finalized, 3);
    assert.equal(summary.projectedEpisodes, 3);
    assert.equal(summary.candidates, 1);
    assert.equal(m.learning.listCandidates()[0]?.positiveEpisodeIds.length, 1);
    assert.equal(m.learning.listCandidates()[0]?.negativeEpisodeIds.length, 1);
    assert.equal(m.learning.listAgenda()[0]?.status, 'queued');
    assert.ok(m.graph.listNodes({types:['episode']}).length === 3);
    assert.ok(m.graph.listNodes({types:['failure_pattern']}).some(node => node.data.category === 'infra_failure'));
    m.close();
  });

  test('父 PlanGraph 只有全部叶子成功才形成正经验，并沉淀实际粗目标顺序',async()=>{
    const m=modules();const source=new MutableSource();source.push(
      planStarted('p1-a',1,'plan-p1','node-1','准备原料'),planBound('p1-a',2,'plan-p1','node-1'),planTerminal('p1-a',3,'plan-p1','node-1','succeeded'),
      planStarted('p1-b',1,'plan-p1','node-2','合成铁镐'),planBound('p1-b',2,'plan-p1','node-2'),planTerminal('p1-b',3,'plan-p1','node-2','failed',failure('decision')),
    );await m.engine.catchUp(source);
    let candidate=m.learning.listCandidates()[0];assert.ok(candidate);assert.equal(candidate.goalPattern,'从原始资源开始制作铁镐');assert.equal(candidate.positiveEpisodeIds.length,0);assert.equal(candidate.negativeEpisodeIds.length,1);
    source.push(
      planStarted('p2-a',1,'plan-p2','node-1','准备原料'),planBound('p2-a',2,'plan-p2','node-1'),planTerminal('p2-a',3,'plan-p2','node-1','succeeded'),
      planStarted('p2-b',1,'plan-p2','node-2','合成铁镐'),planBound('p2-b',2,'plan-p2','node-2'),planTerminal('p2-b',3,'plan-p2','node-2','succeeded'),
    );await m.engine.catchUp(source);
    candidate=m.learning.listCandidates()[0]!;assert.equal(candidate.positiveEpisodeIds.length,1);assert.deepEqual((candidate.content.taskSchemas[0] as {stages:string[]}).stages,['准备原料','合成铁镐']);
    source.push(
      withRevision(planStarted('p3-a-r1',1,'plan-p3','node-1','准备原料'),1),withRevision(planBound('p3-a-r1',2,'plan-p3','node-1'),1),withRevision(planTerminal('p3-a-r1',3,'plan-p3','node-1','failed',failure('decision')),1),
      withRevision(planStarted('p3-a-r2',1,'plan-p3','node-1','准备原料'),2),withRevision(planBound('p3-a-r2',2,'plan-p3','node-1'),2),withRevision(planTerminal('p3-a-r2',3,'plan-p3','node-1','succeeded'),2),
      withRevision(planStarted('p3-b-r2',1,'plan-p3','node-2','合成铁镐'),2),withRevision(planBound('p3-b-r2',2,'plan-p3','node-2'),2),withRevision(planTerminal('p3-b-r2',3,'plan-p3','node-2','succeeded'),2),
    );await m.engine.catchUp(source);
    candidate=m.learning.listCandidates()[0]!;assert.equal(candidate.positiveEpisodeIds.length,2,'较新 revision 成功应覆盖同节点旧失败');assert.equal(candidate.negativeEpisodeIds.length,1);
    assert.equal(m.graph.listNodes({types:['plan_graph']}).length,3);assert.equal(m.graph.listNodes({types:['plan_node']}).length,6);m.close();
  });

  test('未执行完整个 PlanGraph 的结构化图级失败仍形成负经验，部分成功不伪装为正经验',async()=>{
    const m=modules();const source=new MutableSource();
    source.push(
      planStarted('partial-success',1,'plan-partial-success','node-1','准备原料'),
      planBound('partial-success',2,'plan-partial-success','node-1'),
      planTerminal('partial-success',3,'plan-partial-success','node-1','succeeded'),
    );
    await m.engine.catchUp(source);
    assert.equal(m.learning.listCandidates().length,0,'只有前缀成功且后继未执行时不能生成候选');

    source.push(
      planStarted('partial-failure',1,'plan-partial-failure','node-1','准备原料'),
      planBound('partial-failure',2,'plan-partial-failure','node-1'),
      planTerminal('partial-failure',3,'plan-partial-failure','node-1','failed',failure('decision')),
    );
    await m.engine.catchUp(source);
    const candidate=m.learning.listCandidates()[0]!;
    assert.equal(candidate.positiveEpisodeIds.length,0);
    assert.equal(candidate.negativeEpisodeIds.length,1);
    assert.equal(candidate.content.planRecoveryPatterns.length,1);
    const recovery=m.graph.listNodes({types:['plan_recovery_pattern']})[0];
    assert.ok(recovery,'负例候选的恢复模式必须进入知识图谱');
    const graphEdges=m.graph.listEdges();
    assert.ok(graphEdges.some(edge=>edge.from===candidate.id&&edge.to===`episode:${candidate.negativeEpisodeIds[0]}`&&edge.type==='learned_from_failure'));
    assert.ok(graphEdges.some(edge=>edge.from===candidate.id&&edge.to===recovery.id&&edge.type==='contains'));
    assert.ok(graphEdges.some(edge=>edge.from===recovery.id&&edge.type==='handles'));
    m.close();
  });

  test('成功多叶子事实提炼为有机器判据的中间里程碑并保留最终父目标',async()=>{
    const m=modules();const planRunId='plan-structured';const graph={id:planRunId,goalId:'goal-structured',nodes:[
      {id:'node-1',goal:{id:'g1',goalText:'采集木材',metadata:{targetId:'minecraft:iron_pickaxe',structuredSuccessCriteria:[{type:'inventory',item:'oak_log',count:3}]}},state:'ready'},
      {id:'node-2',goal:{id:'g2',goalText:'准备矿物',metadata:{targetId:'minecraft:iron_pickaxe',structuredSuccessCriteria:[{type:'inventory',item:'raw_iron',count:3}]}},state:'pending'},
      {id:'node-3',goal:{id:'g3',goalText:'制作铁镐',metadata:{targetId:'minecraft:iron_pickaxe',structuredSuccessCriteria:[{type:'inventory',item:'iron_pickaxe',count:1}]}},state:'pending'},
    ],edges:[{from:'node-1',to:'node-2',type:'requires'},{from:'node-2',to:'node-3',type:'requires'}],budget:{maxNodes:8,maxGraphReplans:2},provenance:['cold']};
    const bound=(sessionId:string,nodeId:string)=>planBase(sessionId,2,'execution.plan.bound',planRunId,nodeId,{parentGoalText:'从零开始制作一把铁镐',goalSignature:'obtain:item:minecraft:iron_pickaxe:1',experienceMode:null,planGraph:graph});
    await m.engine.catchUp(new ArraySource([
      planStarted('structured-a',1,planRunId,'node-1','采集木材'),bound('structured-a','node-1'),
      planBase('structured-a',3,'execution.action.proposed',planRunId,'node-1',{proposal:{action:'craft',args:{itemName:'wooden_pickaxe'}}}),
      planBase('structured-a',4,'execution.progress.observed',planRunId,'node-1',{inventoryDelta:{oak_log:3}}),
      planBase('structured-a',5,'execution.progress.observed',planRunId,'node-1',{inventoryDelta:{oak_log:-3}}),
      planTerminal('structured-a',6,planRunId,'node-1','succeeded'),
      planStarted('structured-b',1,planRunId,'node-2','准备矿物'),bound('structured-b','node-2'),
      planBase('structured-b',3,'execution.action.proposed',planRunId,'node-2',{proposal:{action:'smelt',args:{itemName:'raw_iron'}}}),
      planBase('structured-b',4,'execution.progress.observed',planRunId,'node-2',{inventoryDelta:{raw_iron:3}}),
      planTerminal('structured-b',5,planRunId,'node-2','succeeded'),
      planStarted('structured-c',1,planRunId,'node-3','制作铁镐'),bound('structured-c','node-3'),
      planBase('structured-c',3,'execution.progress.observed',planRunId,'node-3',{inventoryDelta:{iron_pickaxe:1,seeds:2}}),
      planTerminal('structured-c',4,planRunId,'node-3','succeeded'),
    ]));
    const candidate=m.learning.listCandidates()[0]!;
    const stages=(candidate.content.taskSchemas[0] as {stages:Array<{stage:string;structuredSuccessCriteria:Array<Record<string,unknown>>}>}).stages;
    assert.deepEqual(stages.map(stage=>stage.stage),['obtain:oak_log','obtain:raw_iron','complete:iron_pickaxe']);
    assert.deepEqual(stages[0].structuredSuccessCriteria,[{type:'inventory',item:'oak_log',count:3}]);
    assert.equal(stages.some(stage=>stage.stage.includes('seeds')),false,'未消费且未引用的副产物不得成为计划节点');

    const provider=new PlannerExperienceProvider(m.policies,m.learning,m.graph);const signature={key:'obtain:item:minecraft:iron_pickaxe:1',outcome:'obtain' as const,targetKind:'item' as const,targetId:'minecraft:iron_pickaxe',quantity:1,constraintsHash:'none',compatibleTaskFamilies:['crafting'],schemaVersion:1 as const};
    const context=new ContextEncoder().encode({capabilities:['goal_agent']});
    const candidateSnapshot=candidateIdentity(candidate);
    const frozen=provider.freezeExperiment({planRunId:'trial-structured',goalSignature:signature,context,mode:'experiment'},{schema:'mineclaw.planner-experiment-authorization/v1',experimentId:'experiment:structured',candidateId:candidate.id,candidateGeneration:candidateSnapshot.generation,candidateContentHash:candidateSnapshot.contentHash,validationSpec:candidate.validationSpec!,split:'selection',budget:{authorizationId:'authorization:structured',maxPlanRuns:1,maxEstimatedActions:120,authorized:true},contextComparable:true});
    assert.equal(frozen.status,'frozen');if(frozen.status==='frozen'){
      assert.ok(frozen.bundle.selectionManifest.selected.every(entry=>entry.reasons.includes('knowledge_graph_verified')));
      const planned=new PlanGraphBuilder().planFrozen({id:'root',goalText:'从零开始制作一把铁镐',taskFamily:'crafting',successCriteria:['iron_pickaxe>=1'],metadata:{targetId:'minecraft:iron_pickaxe',structuredSuccessCriteria:[{type:'inventory',item:'iron_pickaxe',count:1}]}},context,frozen.bundle,'trial-structured');
      assert.equal(planned.nodes.length,3);assert.deepEqual(planned.nodes.at(-1)?.goal.metadata?.structuredSuccessCriteria,[{type:'inventory',item:'iron_pickaxe',count:1}]);
    }
    m.close();
  });

  test('EvalGate 严格改善才晋升，平局、hidden 回归、infra 和 safety 均不过闸', () => {
    const gate = new EvalGate();
    const base = track(metrics(0.5), metrics(0.5));
    assert.equal(gate.decide(base, track(metrics(0.7), metrics(0.6))).decision, 'promote');
    assert.equal(gate.decide(base, track(metrics(0.5), metrics(0.6))).decision, 'reject');
    assert.equal(gate.decide(base, track(metrics(0.7), metrics(0.4))).decision, 'reject');
    assert.equal(gate.decide(base, {...track(metrics(0.7),metrics(0.6)),infraFailure:true}).decision, 'inconclusive');
    assert.equal(gate.decide(base, track(metrics(0.7,1),metrics(0.6))).decision, 'blacklist');
    assert.equal(gate.decide(base,track({...metrics(0.8),medianLlmRounds:9},metrics(0.8))).decision,'promote');
    assert.deepEqual(gate.decide(base,track(metrics(0.8),{...metrics(0.5),medianRecoveryCount:1})).reasons,['hidden_regression']);
    const learnsToComplete=gate.decide(
      track({...metrics(0),medianDurationMs:100,medianActions:1},{...metrics(0),medianDurationMs:100,medianActions:1}),
      track({...metrics(1),medianDurationMs:1000,medianActions:20},{...metrics(1),medianDurationMs:1000,medianActions:20}),
    );
    assert.equal(learnsToComplete.decision,'promote');
    assert.equal(learnsToComplete.selectionDelta,1);
    assert.equal(gate.decide(
      track({...metrics(1),medianLlmRounds:10},{...metrics(1),medianLlmRounds:10}),
      track({...metrics(1),medianLlmRounds:8},{...metrics(1),medianLlmRounds:10}),
    ).decision,'promote');
    const hiddenTail=gate.decide(
      track({...metrics(1),p95DurationMs:1000},{...metrics(1),p95DurationMs:1000}),
      track({...metrics(1),medianDurationMs:800,p95DurationMs:1400},{...metrics(1),p95DurationMs:1000}),
    );
    assert.equal(hiddenTail.decision,'reject');
    assert.equal(hiddenTail.reasons.includes('selection_cost_regression'),true);
    const ceiling=track({...metrics(1),medianDurationMs:1000},{...metrics(1),medianDurationMs:1000});
    const faster=track({...metrics(1),medianDurationMs:800},{...metrics(1),medianDurationMs:1100});
    const ceilingDecision=gate.decide(ceiling,faster);
    assert.equal(ceilingDecision.decision,'promote');
    assert.equal(ceilingDecision.efficiencyImproved,true);
  });

  test('候选评测晋升为 Active Policy，曲线和谱系证据可追溯', async () => {
    const m = modules();
    await m.engine.catchUp(new ArraySource([
      started('success-a',1), proposed('success-a',2,'gather'), terminal('success-a',3,'succeeded'),
      started('success-b',1), proposed('success-b',2,'craft'), terminal('success-b',3,'succeeded'),
    ]));
    const candidate = m.learning.listCandidates()[0];
    assert.ok(candidate);
    const outcome = m.engine.evaluateCandidate({ candidateId:candidate.id, version:1, control:track(metrics(0.4),metrics(0.5)), treatment:track(metrics(0.8),metrics(0.7)) });
    assert.equal(outcome.decision.decision, 'promote');
    assert.equal(m.policies.active()?.id, outcome.policy.id);
    assert.equal(m.learning.listCurvePoints(outcome.policy.id).length, 2);
    assert.equal(m.graph.getNode(`policy:${outcome.policy.id}`)?.state, 'trusted');
    m.close();
  });

  test('同一任务的新生产结构形成 successor Candidate 并晋升为 V2', async () => {
    const m=modules();const source=new MutableSource();
    source.push(
      started('generation-1-a',1),proposed('generation-1-a',2,'gather'),terminal('generation-1-a',3,'succeeded'),
      started('generation-1-b',1),proposed('generation-1-b',2,'craft'),terminal('generation-1-b',3,'succeeded'),
    );
    await m.engine.catchUp(source);
    const first=m.learning.listCandidates()[0]!;
    const promoted=m.engine.evaluateCandidate({candidateId:first.id,version:1,control:track(metrics(.4),metrics(.4)),treatment:track(metrics(.8),metrics(.7))});
    const firstRun=m.learning.getValidationRun(first.id)!;
    m.learning.upsertValidationRun({...withoutRunTimestamps(firstRun),createdAt:firstRun.createdAt,status:'promoted'});

    source.push(started('generation-2-new',1),proposed('generation-2-new',2,'smelt'),terminal('generation-2-new',3,'succeeded'));
    await m.engine.catchUp(source);
    const lineage=m.learning.listCandidatesForLineage(first.lineageId!);
    assert.deepEqual(lineage.map(value=>value.generation),[1,2]);
    const second=lineage[1]!;
    assert.equal(second.evolvedFromCandidateId,first.id);
    assert.deepEqual(second.positiveEpisodeIds,['generation-2-new']);
    assert.equal(m.graph.listEdges({limit:1000}).some(edge=>edge.from===second.id&&edge.to===first.id&&edge.type==='evolved_from'),true);

    const evolved=m.engine.evaluateCandidate({candidateId:second.id,version:m.policies.nextVersionForContent(second.content),control:track(metrics(.7),metrics(.7)),treatment:track(metrics(.9),metrics(.8))});
    assert.equal(evolved.policy.version,2);
    assert.equal(evolved.policy.evolvedFrom,promoted.policy.id);
    assert.equal(m.policies.activeForContent(second.content)?.id,evolved.policy.id);
    m.close();
  });

  test('普通生产 Episode 只扩充 Control，不得伪装为 Selection/Hidden', async () => {
    const m = modules();
    const source = new MutableSource();
    source.push(started('baseline',1),terminal('baseline',2,'failed',failure('decision')));
    await m.engine.catchUp(source);
    let run=m.learning.listValidationRuns()[0];
    assert.deepEqual(run?.baselineEpisodeIds,['baseline']);
    assert.deepEqual(run?.selectionEpisodeIds,[]);

    let offset=60;
    for(const id of ['selection-a','selection-b','hidden-a']){
      source.push(retime(started(id,1),offset),retime(proposed(id,2,'gather'),offset),retime(terminal(id,3,'succeeded'),offset));
      await m.engine.catchUp(source);
      offset+=60;
    }
    run=m.learning.listValidationRuns()[0];
    assert.equal(run?.status,'collecting');
    assert.deepEqual(new Set(run?.baselineEpisodeIds),new Set(['baseline','selection-a','selection-b','hidden-a']));
    assert.deepEqual(run?.selectionEpisodeIds,[]);
    assert.deepEqual(run?.hiddenEpisodeIds,[]);
    assert.equal(m.policies.activeForTaskFamily('crafting'),null);
    assert.equal(m.learning.listCurvePoints().length,0);
    assert.equal(m.learning.listEvaluations().length,0);

    await m.engine.catchUp(source);
    assert.equal(m.learning.listCurvePoints().length,0,'重复同步不得把普通运行升级为实验');
    m.close();
  });

  test('同义目标归为一个候选，历史同刻样本保持在 baseline，召回不受注册表 ID 影响', async () => {
    const m = modules();
    const source = new MutableSource();
    source.push(started('plain',1,'采集1个橡木原木'),proposed('plain',2,'gather'),terminal('plain',3,'succeeded'));
    await m.engine.catchUp(source);
    source.push(started('with-id',1,'采集1个橡木原木(oak_log)'),proposed('with-id',2,'gather'),terminal('with-id',3,'succeeded'));
    await m.engine.catchUp(source);

    const candidates=m.learning.listCandidates();
    assert.equal(candidates.length,1);
    assert.deepEqual(new Set(candidates[0]?.positiveEpisodeIds),new Set(['plain','with-id']));
    const run=m.learning.listValidationRuns()[0];
    assert.deepEqual(new Set(run?.baselineEpisodeIds),new Set(['plain','with-id']));
    assert.deepEqual(run?.selectionEpisodeIds,[]);

    const provider=new PlannerExperienceProvider(m.policies,m.learning);
    assert.equal(provider.retrieve('收集一个橡木原木（oak_log）'),null);
    assert.equal(inferPlannerTaskFamily('采集原木（用于制作工作台）'),'gathering');
    assert.equal(inferPlannerTaskFamily('找到附近的树并砍下至少3个原木'),'gathering');
    assert.equal(canonicalGoalText('采集足够的橡木原木（至少1个）'),canonicalGoalText('采集1个原木'));
    assert.equal(canonicalGoalText('将原木合成为木板，再用木板合成1个工作台并保留在背包中'),canonicalGoalText('用原木合成木板，再用木板做出1个工作台并保留在背包里'));
    m.close();
  });

  test('未授权普通刷新不启动候选评测或重复生成版本', async () => {
    const m=modules();
    const source=new MutableSource();
    source.push(started('baseline',1),proposed('baseline',2,'gather'),terminal('baseline',3,'succeeded'));
    await m.engine.catchUp(source);
    let offset=60;
    for(const id of ['selection-a','selection-b','hidden-a']){
      source.push(retime(started(id,1),offset),retime(proposed(id,2,'gather'),offset),retime(terminal(id,3,'succeeded'),offset));
      await m.engine.catchUp(source);
      offset+=60;
    }
    let run=m.learning.listValidationRuns()[0];
    assert.equal(run?.attempt,1);
    assert.equal(run?.status,'collecting');
    assert.deepEqual(run?.consumedTrialEpisodeIds,[]);
    assert.deepEqual(new Set(run?.baselineEpisodeIds),new Set(['baseline','selection-a','selection-b','hidden-a']));
    assert.equal(m.policies.list().length,0);
    assert.equal(m.learning.listCurvePoints().length,0);
    assert.equal(m.learning.listAgenda()[0]?.status,'queued');

    m.engine.refreshCandidates();
    m.engine.refreshCandidates();
    m.engine.refreshCandidates();
    run=m.learning.listValidationRuns()[0];
    assert.equal(run?.attempt,1);
    assert.equal(m.policies.list().length,0);
    assert.equal(m.learning.listCurvePoints().length,0);
    assert.equal(m.learning.listAgenda()[0]?.status,'queued');
    m.close();
  });

  test('语义规则升级后旧候选退出当前视图但保留历史证据', async () => {
    const m=modules();
    const oldCandidate={
      id:'candidate:legacy-tree-goal', taskFamily:'exploration', goalPattern:'找到树并砍原木',
      content:{taskSchemas:[{id:'schema:legacy',goalPattern:'找到树并砍原木'}],planFragments:[],planRecoveryPatterns:[],metaPolicies:[],applicability:[]},
      evidenceIds:['legacy-evidence'],positiveEpisodeIds:['legacy-episode'],negativeEpisodeIds:[],confidenceLowerBound:0.2,
      status:'candidate' as const,
      validationSpec:{id:'validation:legacy',validatorId:'exploration-goal-verifier',primaryMetric:'success_rate' as const,minimumSelectionSamples:2,minimumHiddenSamples:1,pairing:'snapshot_pair' as const,treatmentField:'planner_policy'},
    };
    m.learning.upsertCandidate(oldCandidate);
    m.learning.upsertAgenda({candidateId:oldCandidate.id,status:'queued',expectedInformationGain:1,uncertainty:0.8,impactScope:1,estimatedCost:2,safetyRisk:0,headroom:0.8,retryBudget:2,validationSpec:oldCandidate.validationSpec});
    new EvolutionProjector(m.graph).projectCandidate(oldCandidate);
    const historicalAt=m.graph.getNode(oldCandidate.id)?.validFrom;
    assert.ok(historicalAt);

    await m.engine.catchUp(new ArraySource([
      started('current',1,'找到附近的树并砍下至少3个原木'),proposed('current',2,'gather'),terminal('current',3,'succeeded'),
    ]));

    assert.equal(m.learning.getCandidate(oldCandidate.id)?.status,'backlog');
    const oldAgenda=m.learning.listAgenda().find(item=>item.candidateId===oldCandidate.id);
    assert.equal(oldAgenda?.status,'closed');
    assert.equal(oldAgenda?.reason,'candidate_superseded_by_canonicalization');
    assert.ok(m.graph.getNode(oldCandidate.id)?.validTo);
    assert.equal(m.graph.listNodes().some(node=>node.id===oldCandidate.id),false);
    assert.equal(m.graph.listNodes({at:historicalAt}).some(node=>node.id===oldCandidate.id),true);
    assert.ok(m.ledger.getEpisode('current'));
    m.close();
  });
});

function modules() {
  const dir = mkdtempSync(join(tmpdir(),'planner-learning-')); tempDirs.push(dir);
  const db = join(dir,'evolution.db');
  const ledger = new EpisodeLedger(db), graph = new EvolutionGraphStore(db), policies = new PlannerPolicyStore(db), learning = new PlannerLearningStore(db);
  const engine = new PlannerEvolutionEngine(ledger,learning,policies,new EvolutionProjector(graph));
  return {ledger,graph,policies,learning,engine,close(){learning.close();policies.close();graph.close();ledger.close();}};
}

class ArraySource { private cursor=0; constructor(private readonly facts:unknown[]){} async readAfter(cursor:string|null,limit:number){this.cursor=cursor==null?0:Number(cursor); const facts=this.facts.slice(this.cursor,this.cursor+limit); this.cursor+=facts.length; return {facts,nextCursor:String(this.cursor)};} }
class MutableSource { private readonly facts:unknown[]=[]; push(...facts:unknown[]){this.facts.push(...facts);} async readAfter(cursor:string|null,limit:number){const start=cursor==null?0:Number(cursor);const facts=this.facts.slice(start,start+limit);return {facts,nextCursor:String(start+facts.length)};} }

function base(sessionId:string, sequence:number, eventType:string, payload:Record<string,unknown>):ExecutionFactEnvelopeV1 { return {schema:EXECUTION_FACT_SCHEMA_V1,eventId:`${sessionId}-${sequence}`,eventType,sessionId,runId:`run-${sessionId}`,planRunId:`plan-${sessionId}`,planRevision:1,nodeId:`node-${sessionId}`,sequence,occurredAt:new Date(Date.UTC(2026,7,2,0,0,sequence)).toISOString(),codeRevision:'test',configRevision:'test',correlationId:`corr-${sessionId}`,payload}; }
function started(sessionId:string,sequence:number,goal='制造铁轨'){return base(sessionId,sequence,'execution.session.started',{goalText:goal});}
function proposed(sessionId:string,sequence:number,action:string){return base(sessionId,sequence,'execution.action.proposed',{proposal:{action,args:{}}});}
function terminal(sessionId:string,sequence:number,outcome:'succeeded'|'failed',failureValue?:FailureEnvelopeV1){return base(sessionId,sequence,'execution.session.terminal',{outcome,handoff:outcome==='failed'?'graph_replan_required':'none',verdict:{ok:outcome==='succeeded',detail:outcome},...(failureValue?{failure:failureValue}:{})});}
function planBase(sessionId:string,sequence:number,eventType:string,planRunId:string,nodeId:string,payload:Record<string,unknown>):ExecutionFactEnvelopeV1{return {...base(sessionId,sequence,eventType,payload),planRunId,nodeId};}
function planStarted(sessionId:string,sequence:number,planRunId:string,nodeId:string,goalText:string){return planBase(sessionId,sequence,'execution.session.started',planRunId,nodeId,{goalText,parentGoalText:'从原始资源开始制作铁镐'});}
function planBound(sessionId:string,sequence:number,planRunId:string,nodeId:string){return planBase(sessionId,sequence,'execution.plan.bound',planRunId,nodeId,{parentGoalText:'从原始资源开始制作铁镐',policySnapshotId:null,experienceMode:null,planGraph:{id:planRunId,goalId:`goal-${planRunId}`,nodes:[{id:'node-1',goal:{id:'g1',goalText:'准备原料',successCriteria:['ready']},state:'ready'},{id:'node-2',goal:{id:'g2',goalText:'合成铁镐',successCriteria:['iron_pickaxe>=1']},state:'pending'}],edges:[{from:'node-1',to:'node-2',type:'requires'}],budget:{maxNodes:8,maxGraphReplans:2},provenance:['test']}});}
function planTerminal(sessionId:string,sequence:number,planRunId:string,nodeId:string,outcome:'succeeded'|'failed',failureValue?:FailureEnvelopeV1){return planBase(sessionId,sequence,'execution.session.terminal',planRunId,nodeId,{outcome,handoff:outcome==='failed'?'graph_replan_required':'none',verdict:{ok:outcome==='succeeded',detail:outcome},...(failureValue?{failure:failureValue}:{})});}
function withRevision(fact:ExecutionFactEnvelopeV1,planRevision:number):ExecutionFactEnvelopeV1{return {...fact,planRevision};}
function retime<T extends ExecutionFactEnvelopeV1>(fact:T,seconds:number):T{return {...fact,occurredAt:new Date(Date.parse(fact.occurredAt)+seconds*1000).toISOString()};}
function failure(origin:FailureEnvelopeV1['origin']):FailureEnvelopeV1 { return {code:`${origin}.failure`,origin,stage:origin==='perception'?'observing':'deciding',category:origin==='navigation'?'navigation':origin==='environment'?'environment':origin==='infra'?'transient':origin==='safety'?'fatal':'precondition',retryable:false,ownerActionable:false,evidenceRefs:[`${origin}-evidence`]}; }
function metrics(successRate:number,safetyViolations=0):PolicyMetrics{return {successRate,medianDurationMs:1000,medianActions:4,medianLlmRounds:2,interventionRate:0,safetyViolations,samples:3};}
function track(selection:PolicyMetrics,hidden:PolicyMetrics){return {selection,hidden,triggered:true,compliant:true,comparable:true};}
function withoutRunTimestamps(run:CandidateValidationRun):Omit<CandidateValidationRun,'createdAt'|'updatedAt'>{const {createdAt:_createdAt,updatedAt:_updatedAt,...rest}=run;return rest;}
