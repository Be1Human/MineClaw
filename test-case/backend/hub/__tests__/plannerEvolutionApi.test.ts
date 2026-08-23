import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createHubServer } from '../../../../apps/minecraft-companion/src/hub/server.js';
import type { BotProfile } from '../../../../apps/minecraft-companion/src/hub/profileStore.js';
import { resolveRuntimePersistencePaths } from '../../../../apps/minecraft-companion/src/bot/runtimePersistence.js';
import { EvolutionGraphStore } from '../../../../apps/minecraft-companion/src/bot/v2/task/planner/evolution/evolutionGraphStore.js';
import { PlannerPolicyStore } from '../../../../apps/minecraft-companion/src/bot/v2/task/planner/evolution/policyStore.js';
import { PlannerLearningStore } from '../../../../apps/minecraft-companion/src/bot/v2/task/planner/evolution/learningStore.js';
import { EpisodeLedger } from '../../../../apps/minecraft-companion/src/bot/v2/task/planner/evolution/episodeLedger.js';
import { EXECUTION_FACT_SCHEMA_V1, type ExecutionFactEnvelopeV1 } from '../../../../apps/minecraft-companion/src/bot/v2/task/contracts/executionFactsV1.js';
import { plannerEvolutionRuntimeGate } from '../../../../apps/minecraft-companion/src/hub/plannerEvolutionReadService.js';

test('FEAT-CROSS-14-006-010 | 页面运行门准确解释 Candidate 为什么未进入实验', () => {
  const profileId='profile-evolution-lab';
  assert.deepEqual(plannerEvolutionRuntimeGate(profileId,{}),{
    evolutionMode:'observe',experimentMode:'off',profileAuthorized:true,candidateTrialsEnabled:false,reason:'evolution_not_active',
  });
  assert.equal(plannerEvolutionRuntimeGate(profileId,{PLANNER_EVOLUTION_MODE:'active'}).reason,'experiment_not_authorized');
  assert.equal(plannerEvolutionRuntimeGate(profileId,{PLANNER_EVOLUTION_MODE:'active',PLANNER_EXPERIMENT_MODE:'authorized',PLANNER_EXPERIMENT_PROFILE_IDS:'other'}).reason,'profile_not_allowlisted');
  assert.deepEqual(plannerEvolutionRuntimeGate(profileId,{PLANNER_EVOLUTION_MODE:'active',PLANNER_EXPERIMENT_MODE:'authorized',PLANNER_EXPERIMENT_PROFILE_IDS:`other, ${profileId}`}),{
    evolutionMode:'active',experimentMode:'authorized',profileAuthorized:true,candidateTrialsEnabled:true,reason:'authorized',
  });
});

test('FEAT-CROSS-12 | 图谱 API 按 Profile 返回摘要、受限子图和可信 Policy', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mineclaw-planner-evolution-api-'));
  const dataDir = join(root, 'data');
  const hub = createHubServer({ port: 0, host: '127.0.0.1', dataDir });
  try {
    await hub.listen();
    const profile = hub.profileStore.create(profileInput('Evolution API'));
    const dbPath = resolveRuntimePersistencePaths(dataDir, profile.id).plannerEvolutionDbPath;
    seedGraph(dbPath);

    const origin = `http://127.0.0.1:${(hub.httpServer.address() as AddressInfo).port}`;
    const summaryResponse = await fetch(`${origin}/api/bots/${profile.id}/planner-evolution/summary`);
    assert.equal(summaryResponse.status, 200);
    const summary = await summaryResponse.json() as {
      available: boolean;
      counts: { nodes: number; edges: number; evidence: number; knowledgeNodes:number; knowledgeEdges:number; runtimeEvidenceNodes:number; byType: Record<string, number> };
      activePolicy: {
        id: string;
        version: number;
        revision: number;
        confidenceLowerBound: number;
        updatedAt: string;
      } | null;
    };
    assert.equal(summary.available, true);
    assert.deepEqual(summary.counts, {
      nodes: 2,
      edges: 1,
      evidence: 2,
      knowledgeNodes: 2,
      knowledgeEdges: 1,
      runtimeEvidenceNodes: 0,
      byType: { goal_pattern: 1, plan_fragment: 1 },
    });
    assert.deepEqual(summary.activePolicy, {
      id: 'policy-rail-v1', version: 1, revision: 2,
      confidenceLowerBound: 0.82,
      updatedAt: summary.activePolicy?.updatedAt,
    });

    const graphResponse = await fetch(`${origin}/api/bots/${profile.id}/planner-evolution/graph?root=goal:rail&depth=2`);
    assert.equal(graphResponse.status, 200);
    const graph = await graphResponse.json() as { nodes: Array<{ id: string }>; edges: Array<{ id: string }>; truncated: boolean };
    assert.deepEqual(graph.nodes.map(node => node.id).sort(), ['fragment:smelt', 'goal:rail']);
    assert.deepEqual(graph.edges.map(edge => edge.id), ['edge:rail-smelt']);
    assert.equal(graph.truncated, false);

    const invalidType = await fetch(`${origin}/api/bots/${profile.id}/planner-evolution/graph?type=made_up`);
    assert.equal(invalidType.status, 400);
    assert.deepEqual(await invalidType.json(), { error: 'unknown evolution node type' });

    const exported = await fetch(`${origin}/api/bots/${profile.id}/planner-evolution/export?scope=full`);
    assert.equal(exported.status, 200);
    assert.equal(exported.headers.get('content-type'), 'application/zip');
    assert.match(exported.headers.get('content-disposition') ?? '', /planner-experience-/);
    assert.equal((await exported.arrayBuffer()).byteLength > 100, true);
    const invalidScope = await fetch(`${origin}/api/bots/${profile.id}/planner-evolution/export?scope=plan_run`);
    assert.equal(invalidScope.status, 400);
  } finally {
    await new Promise<void>(resolve => hub.httpServer.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

test('FEAT-CROSS-12 | 无图谱数据返回明确空态，未知 Profile 返回 404', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mineclaw-planner-evolution-empty-'));
  const hub = createHubServer({ port: 0, host: '127.0.0.1', dataDir: join(root, 'data') });
  try {
    await hub.listen();
    const profile = hub.profileStore.create(profileInput('No graph'));
    const origin = `http://127.0.0.1:${(hub.httpServer.address() as AddressInfo).port}`;
    const empty = await fetch(`${origin}/api/bots/${profile.id}/planner-evolution/summary`);
    assert.equal(empty.status, 200);
    assert.equal(((await empty.json()) as { available: boolean }).available, false);

    const missing = await fetch(`${origin}/api/bots/not-found/planner-evolution/summary`);
    assert.equal(missing.status, 404);
  } finally {
    await new Promise<void>(resolve => hub.httpServer.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

test('FEAT-CROSS-14 | Dashboard 返回曲线、候选和议程，治理只影响下一次规划', async () => {
  const root=mkdtempSync(join(tmpdir(),'mineclaw-planner-dashboard-')),dataDir=join(root,'data');
  const hub=createHubServer({port:0,host:'127.0.0.1',dataDir});
  try{
    await hub.listen();const profile=hub.profileStore.create(profileInput('Dashboard'));
    const dbPath=resolveRuntimePersistencePaths(dataDir,profile.id).plannerEvolutionDbPath;seedGraph(dbPath);seedLearning(dbPath);seedPlanRun(dbPath);seedFailedPlanRun(dbPath);seedCancelledPlanRun(dbPath);seedNoProgressSucceededPlanRun(dbPath);
    const origin=`http://127.0.0.1:${(hub.httpServer.address() as AddressInfo).port}`;
    const dashboard=await (await fetch(`${origin}/api/bots/${profile.id}/planner-evolution/dashboard`)).json() as {runtimeGate:{candidateTrialsEnabled:boolean;reason:string};policies:unknown[];candidates:unknown[];agenda:unknown[];validationRuns:Array<{attempt:number;baselineEpisodeIds:string[]}>;curves:unknown[];experimentAllocations:unknown[];experienceLineages:Array<{goalPattern:string;taskFamily:string;candidateId:string|null;maturity:string;candidateGenerations:Array<{generation:number;evolvedFromCandidateId:string|null;positiveEpisodeIds:string[];negativeEpisodeIds:string[];validationStatus:string|null;changes:string[]}>;versions:Array<{policy:{id:string};changes:string[]}>}>;planRuns:Array<{parentGoalText:string;runIndex:number;outcome:string;actionCount:number;llmRounds:number;masteryScore:number;learningEligible:boolean;learningExclusionReason:string|null;isComparisonBaseline:boolean}>};
    assert.equal(typeof dashboard.runtimeGate.candidateTrialsEnabled,'boolean');assert.ok(dashboard.runtimeGate.reason);
    assert.equal(dashboard.policies.length,1);assert.equal(dashboard.candidates.length,2);assert.equal(dashboard.agenda.length,1);assert.equal(dashboard.validationRuns.length,1);assert.equal(dashboard.validationRuns[0]?.attempt,1);assert.deepEqual(dashboard.validationRuns[0]?.baselineEpisodeIds,['episode-rail-1']);assert.equal(dashboard.curves.length,2);
    assert.equal(dashboard.experimentAllocations.length,0);assert.equal(dashboard.experienceLineages.length,4);const railLineage=dashboard.experienceLineages.find(value=>value.goalPattern==='制造铁轨');assert.deepEqual({goalPattern:railLineage?.goalPattern,taskFamily:railLineage?.taskFamily,candidateId:railLineage?.candidateId,generations:railLineage?.candidateGenerations.map(value=>value.generation),parent:railLineage?.candidateGenerations[1]?.evolvedFromCandidateId,g1Validation:railLineage?.candidateGenerations[0]?.validationStatus,g2Positive:railLineage?.candidateGenerations[1]?.positiveEpisodeIds,policyId:railLineage?.versions[0]?.policy.id,changes:railLineage?.versions[0]?.changes},{goalPattern:'制造铁轨',taskFamily:'crafting',candidateId:'candidate:rail:g2',generations:[1,2],parent:'candidate:rail',g1Validation:'promoted',g2Positive:['episode-rail-2'],policyId:'policy-rail-v1',changes:['初始候选版本']});assert.equal(dashboard.experienceLineages.filter(value=>value.maturity==='accumulating').length,2);
    const successful=dashboard.planRuns.find(run=>run.outcome==='succeeded');
    const failed=dashboard.planRuns.find(run=>run.outcome==='failed');
    const cancelled=dashboard.planRuns.find(run=>run.outcome==='cancelled');
    const preSatisfied=dashboard.planRuns.find(run=>run.parentGoalText==='清理空场僵尸');
    assert.deepEqual(successful&&{runIndex:successful.runIndex,actionCount:successful.actionCount,llmRounds:successful.llmRounds,masteryScore:successful.masteryScore},{runIndex:1,actionCount:1,llmRounds:3,masteryScore:100});
    assert.deepEqual(failed&&{runIndex:failed.runIndex,actionCount:failed.actionCount,llmRounds:failed.llmRounds,masteryScore:failed.masteryScore,learningEligible:failed.learningEligible,learningExclusionReason:failed.learningExclusionReason},{runIndex:1,actionCount:2,llmRounds:2,masteryScore:0,learningEligible:true,learningExclusionReason:null});
    assert.deepEqual(cancelled&&{runIndex:cancelled.runIndex,learningEligible:cancelled.learningEligible,learningExclusionReason:cancelled.learningExclusionReason,masteryScore:cancelled.masteryScore},{runIndex:2,learningEligible:false,learningExclusionReason:'owner_or_runtime_cancelled',masteryScore:0});
    assert.deepEqual(preSatisfied&&{learningEligible:preSatisfied.learningEligible,learningExclusionReason:preSatisfied.learningExclusionReason,masteryScore:preSatisfied.masteryScore,isComparisonBaseline:preSatisfied.isComparisonBaseline},{learningEligible:false,learningExclusionReason:'goal_pre_satisfied_no_progress',masteryScore:0,isComparisonBaseline:false});
    assert.equal(successful?.isComparisonBaseline,true);assert.equal(failed?.isComparisonBaseline,true);assert.equal(cancelled?.isComparisonBaseline,false);
    const disable=await fetch(`${origin}/api/bots/${profile.id}/planner-evolution/policies/policy-rail-v1/disable`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({expectedRevision:2,reason:'owner test'})});
    assert.equal(disable.status,200);assert.equal(((await disable.json()) as {appliesTo:string}).appliesTo,'next_planning_session');
    const rollback=await fetch(`${origin}/api/bots/${profile.id}/planner-evolution/policies/policy-rail-v1/rollback`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({expectedRevision:3,reason:'restore'})});
    assert.equal(rollback.status,200);assert.equal(((await rollback.json()) as {policy:{state:string}}).policy.state,'trusted');
  }finally{await new Promise<void>(resolve=>hub.httpServer.close(()=>resolve()));rmSync(root,{recursive:true,force:true});}
});

function profileInput(name: string): Omit<BotProfile, 'id' | 'createdAt' | 'updatedAt'> {
  return {
    name,
    personality: { description: 'planner evolution test', style: 'calm' },
    server: { host: '127.0.0.1', port: 25565, auth: 'offline' },
  };
}

function seedGraph(dbPath: string): void {
  const graph = new EvolutionGraphStore(dbPath);
  const policies = new PlannerPolicyStore(dbPath);
  try {
    graph.upsertNode({
      id: 'goal:rail', type: 'goal_pattern', label: '制造铁轨', summary: '从原始材料完成铁轨制造',
      evidenceIds: ['episode-rail-1'], data: { taskFamily: 'crafting' }, validFrom: '2026-01-01T00:00:00.000Z',
    });
    graph.upsertNode({
      id: 'fragment:smelt', type: 'plan_fragment', label: '先熔炼铁锭', summary: '确认燃料与熔炉后批量熔炼',
      evidenceIds: ['episode-rail-1'], data: { stepCount: 3 }, validFrom: '2026-01-01T00:00:00.000Z',
    });
    graph.upsertEdge({
      id: 'edge:rail-smelt', from: 'goal:rail', to: 'fragment:smelt', type: 'decomposes_to',
      evidenceIds: ['evaluation-rail-1'], confidenceLowerBound: 0.82, validFrom: '2026-01-01T00:00:00.000Z',
    });
    const candidate = policies.createCandidate({
      id: 'policy-rail-v1', version: 1,
      content: { taskSchemas: [], planFragments: [], planRecoveryPatterns: [], metaPolicies: [], applicability: [] },
      evidenceIds: ['episode-rail-1', 'evaluation-rail-1'], confidenceLowerBound: 0.82,
    });
    policies.promote(candidate.id, candidate.revision, {
      decision: 'promote', selectionDelta: 0.12, hiddenRegression: false,
      safetyViolations: 0, evaluationId: 'evaluation-rail-1',
    });
  } finally {
    policies.close();
    graph.close();
  }
}

function seedLearning(dbPath:string):void{
  const store=new PlannerLearningStore(dbPath);const metrics={successRate:.8,medianDurationMs:1000,medianActions:4,medianLlmRounds:2,interventionRate:0,safetyViolations:0,samples:3};
  try{
    const first=store.upsertCandidate({id:'candidate:rail',taskFamily:'crafting',goalPattern:'制造铁轨',content:{taskSchemas:[],planFragments:[],planRecoveryPatterns:[],metaPolicies:[],applicability:[]},evidenceIds:['episode-rail-1'],positiveEpisodeIds:['episode-rail-1'],negativeEpisodeIds:[],confidenceLowerBound:.82,status:'candidate',validationSpec:{id:'validation:rail',validatorId:'inventory',primaryMetric:'success_rate',minimumSelectionSamples:2,minimumHiddenSamples:1,pairing:'snapshot_pair',treatmentField:'planner_policy'}});
    store.addCurvePoint({policyId:'policy-rail-v1',policyVersion:1,split:'selection',metrics,episodeIds:['episode-rail-1'],valid:true});store.addCurvePoint({policyId:'policy-rail-v1',policyVersion:1,split:'hidden',metrics,episodeIds:['episode-rail-1'],valid:true});
    store.upsertAgenda({candidateId:'candidate:rail',status:'queued',expectedInformationGain:.5,uncertainty:.18,impactScope:3,estimatedCost:2,safetyRisk:0,headroom:.18,retryBudget:2});
    store.upsertValidationRun({candidateId:'candidate:rail',candidateGeneration:first.generation,candidateContentHash:first.contentHash,baselineEpisodeIds:['episode-rail-1'],baselineCutoffOccurredAt:'2026-01-01T00:00:00.000Z',selectionEpisodeIds:[],hiddenEpisodeIds:[],consumedTrialEpisodeIds:[],attempt:1,status:'promoted'});
    store.registerCandidateProposal({...first,content:{...first.content,taskSchemas:[{id:'schema:rail:v2',stages:['prepare','craft','verify']}]},evidenceIds:['episode-rail-2'],positiveEpisodeIds:['episode-rail-2'],negativeEpisodeIds:[]});
  }finally{store.close();}
}

function seedPlanRun(dbPath:string):void{
  const ledger=new EpisodeLedger(dbPath);
  const fact=(sequence:number,eventType:string,payload:Record<string,unknown>):ExecutionFactEnvelopeV1=>({schema:EXECUTION_FACT_SCHEMA_V1,eventId:`pickaxe-${sequence}`,eventType,sessionId:'pickaxe-leaf-1',runId:'plan-pickaxe-1',planRunId:'plan-pickaxe-1',planRevision:1,nodeId:'node-1',sequence,occurredAt:new Date(Date.UTC(2026,7,2,1,0,sequence)).toISOString(),codeRevision:'test',configRevision:'test',correlationId:'pickaxe-goal',payload});
  try{
    ledger.appendFact(fact(1,'execution.session.started',{goalText:'制作铁镐'}));
    ledger.appendFact(fact(2,'execution.plan.bound',{parentGoalText:'从原始资源开始制作铁镐',policySnapshotId:null,experienceMode:null,planGraph:{id:'plan-pickaxe-1',goalId:'pickaxe-goal',nodes:[{id:'node-1',goal:{id:'pickaxe-node',goalText:'制作铁镐',successCriteria:['inventory']},state:'ready'}],edges:[],budget:{maxNodes:8,maxGraphReplans:2},provenance:['test']}}));
    ledger.appendFact(fact(3,'execution.action.proposed',{proposal:{action:'craft',args:{itemName:'iron_pickaxe'}}}));
    ledger.appendFact(fact(4,'execution.progress.observed',{progress:{llmRounds:3}}));
    ledger.appendFact(fact(5,'execution.session.terminal',{outcome:'succeeded',handoff:'none',verdict:{ok:true,detail:'inventory iron_pickaxe >= 1'}}));
  }finally{ledger.close();}
}

function seedFailedPlanRun(dbPath:string):void{
  const ledger=new EpisodeLedger(dbPath);
  const fact=(sequence:number,eventType:string,payload:Record<string,unknown>):ExecutionFactEnvelopeV1=>({schema:EXECUTION_FACT_SCHEMA_V1,eventId:`failed-${sequence}`,eventType,sessionId:'failed-leaf-1',runId:'plan-failed-1',planRunId:'plan-failed-1',planRevision:1,nodeId:'node-1',sequence,occurredAt:new Date(Date.UTC(2026,7,2,2,0,sequence)).toISOString(),codeRevision:'test',configRevision:'test',correlationId:'failed-goal',payload});
  try{
    ledger.appendFact(fact(1,'execution.session.started',{goalText:'generic failed goal'}));
    ledger.appendFact(fact(2,'execution.plan.bound',{parentGoalText:'generic failed parent goal',policySnapshotId:null,experienceMode:null,planGraph:{id:'plan-failed-1',goalId:'failed-goal',nodes:[{id:'node-1',goal:{id:'failed-node',goalText:'generic failed goal',successCriteria:['inventory']},state:'ready'}],edges:[],budget:{maxNodes:8,maxGraphReplans:2},provenance:['test']}}));
    ledger.appendFact(fact(3,'execution.action.proposed',{proposal:{source:'slow_llm',action:'dig',args:{}}}));
    ledger.appendFact(fact(4,'execution.action.proposed',{proposal:{source:'slow_llm',action:'goto_position',args:{}}}));
    ledger.appendFact(fact(5,'execution.session.terminal',{outcome:'failed',handoff:'graph_replan_required',verdict:{ok:false,detail:'no progress'},failure:{code:'navigation.failed',origin:'navigation',stage:'executing',category:'navigation',retryable:true,ownerActionable:false,evidenceRefs:[]}}));
  }finally{ledger.close();}
}

function seedCancelledPlanRun(dbPath:string):void{
  const ledger=new EpisodeLedger(dbPath);
  const fact=(sequence:number,eventType:string,payload:Record<string,unknown>):ExecutionFactEnvelopeV1=>({schema:EXECUTION_FACT_SCHEMA_V1,eventId:`cancelled-${sequence}`,eventType,sessionId:'cancelled-leaf-1',runId:'plan-cancelled-1',planRunId:'plan-cancelled-1',planRevision:1,nodeId:'node-1',sequence,occurredAt:new Date(Date.UTC(2026,7,2,3,0,sequence)).toISOString(),codeRevision:'test',configRevision:'test',correlationId:'cancelled-goal',payload});
  try{
    ledger.appendFact(fact(1,'execution.session.started',{goalText:'generic failed goal'}));
    ledger.appendFact(fact(2,'execution.plan.bound',{parentGoalText:'generic failed parent goal',policySnapshotId:null,experienceMode:null,planGraph:{id:'plan-cancelled-1',goalId:'cancelled-goal',nodes:[{id:'node-1',goal:{id:'cancelled-node',goalText:'generic failed goal',successCriteria:['inventory']},state:'ready'}],edges:[],budget:{maxNodes:8,maxGraphReplans:2},provenance:['test']}}));
    ledger.appendFact(fact(3,'execution.action.proposed',{proposal:{source:'slow_llm',action:'dig',args:{}}}));
    ledger.appendFact(fact(4,'execution.session.terminal',{outcome:'cancelled',handoff:'none',verdict:{ok:false,detail:'owner cancelled'},failure:{code:'execution.cancelled',origin:'atomic',stage:'executing',category:'cancelled',retryable:false,ownerActionable:false,evidenceRefs:[]}}));
  }finally{ledger.close();}
}

function seedNoProgressSucceededPlanRun(dbPath:string):void{
  const ledger=new EpisodeLedger(dbPath);
  const fact=(sequence:number,eventType:string,payload:Record<string,unknown>):ExecutionFactEnvelopeV1=>({schema:EXECUTION_FACT_SCHEMA_V1,eventId:`pre-satisfied-${sequence}`,eventType,sessionId:'pre-satisfied-leaf-1',runId:'plan-pre-satisfied-1',planRunId:'plan-pre-satisfied-1',planRevision:1,nodeId:'node-1',sequence,occurredAt:new Date(Date.UTC(2026,7,2,4,0,sequence)).toISOString(),codeRevision:'test',configRevision:'test',correlationId:'pre-satisfied-goal',payload});
  try{
    ledger.appendFact(fact(1,'execution.session.started',{goalText:'清理空场僵尸'}));
    ledger.appendFact(fact(2,'execution.plan.bound',{parentGoalText:'清理空场僵尸',policySnapshotId:null,experienceMode:'observe',planGraph:{id:'plan-pre-satisfied-1',goalId:'pre-satisfied-goal',nodes:[{id:'node-1',goal:{id:'pre-satisfied-node',goalText:'清理空场僵尸',successCriteria:['entity_dead']},state:'ready'}],edges:[],budget:{maxNodes:8,maxGraphReplans:2},provenance:['test']}}));
    ledger.appendFact(fact(3,'execution.action.proposed',{proposal:{source:'registered_behavior',action:'invoke_behavior',args:{behavior:'combat'}}}));
    ledger.appendFact(fact(4,'execution.progress.observed',{meaningful:false,changedCriteria:[],inventoryDelta:{},positionDelta:0,worldEffects:[]}));
    ledger.appendFact(fact(5,'execution.session.terminal',{outcome:'succeeded',handoff:'none',verdict:{ok:true,detail:'goal criteria already satisfied'}}));
  }finally{ledger.close();}
}
