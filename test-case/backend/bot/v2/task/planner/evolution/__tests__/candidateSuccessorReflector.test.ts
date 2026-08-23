import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CandidateSuccessorReflector } from '../../../../../../../../apps/minecraft-companion/src/bot/v2/task/planner/evolution/candidateSuccessorReflector.js';
import { PlannerLearningStore } from '../../../../../../../../apps/minecraft-companion/src/bot/v2/task/planner/evolution/learningStore.js';
import { candidateIdentity } from '../../../../../../../../apps/minecraft-companion/src/bot/v2/task/planner/evolution/candidateIdentity.js';
import { EpisodeLedger, type PlannerLeafEpisode } from '../../../../../../../../apps/minecraft-companion/src/bot/v2/task/planner/evolution/episodeLedger.js';
import { CandidateTrialScheduler, type CandidateEvaluationReady } from '../../../../../../../../apps/minecraft-companion/src/bot/v2/task/planner/evolution/candidateTrialScheduler.js';
import { ExperienceAttributor } from '../../../../../../../../apps/minecraft-companion/src/bot/v2/task/planner/evolution/attributor.js';
import { ResearchAgenda } from '../../../../../../../../apps/minecraft-companion/src/bot/v2/task/planner/evolution/researchAgenda.js';
import { EvolutionGraphStore } from '../../../../../../../../apps/minecraft-companion/src/bot/v2/task/planner/evolution/evolutionGraphStore.js';
import { EvolutionProjector } from '../../../../../../../../apps/minecraft-companion/src/bot/v2/task/planner/evolution/evolutionProjector.js';
import { PlannerPolicyStore } from '../../../../../../../../apps/minecraft-companion/src/bot/v2/task/planner/evolution/policyStore.js';
import { PlannerEvolutionEngine } from '../../../../../../../../apps/minecraft-companion/src/bot/v2/task/planner/evolution/plannerEvolutionEngine.js';
import type { ExperienceCandidate } from '../../../../../../../../apps/minecraft-companion/src/bot/v2/task/planner/evolution/plannerOptimizer.js';
import { EXECUTION_FACT_SCHEMA_V1, type ExecutionFactEnvelopeV1 } from '../../../../../../../../apps/minecraft-companion/src/bot/v2/task/planner/evolution/contracts/executionFactsV1.js';
import type { PolicyMetrics } from '../../../../../../../../apps/minecraft-companion/src/bot/v2/task/planner/evolution/evalGate.js';

describe('FEAT-CROSS-14-006-016 · settled Selection successor reflection', () => {
  test('G1 结算后只用 Selection 成败生成 G2，Hidden 唯一标记不泄漏', () => {
    const parent = candidate();
    const selectionSuccess = episode('selection-success', 'selection', 'succeeded');
    const selectionFailure = episode('selection-failure', 'selection', 'failed');
    const hidden = episode('HIDDEN-UNIQUE-MARKER', 'hidden', 'failed');
    const proposal = new CandidateSuccessorReflector().reflect(parent, [selectionSuccess, selectionFailure, hidden]);
    assert.ok(proposal);
    assert.deepEqual(new Set(proposal.positiveEpisodeIds), new Set(['selection-success']));
    assert.deepEqual(new Set(proposal.negativeEpisodeIds), new Set(['selection-failure']));
    assert.ok(proposal.content.planFragments.length > 0, '成功 Selection 应形成结构化计划片段');
    assert.ok(proposal.content.planRecoveryPatterns.length > 0, '规划失败 Selection 应形成恢复模式');
    assert.ok(proposal.content.metaPolicies.some(value => JSON.stringify(value).includes('settled_selection')));
    assert.equal(JSON.stringify(proposal).includes('HIDDEN-UNIQUE-MARKER'), false);
    const graph = new EvolutionGraphStore(':memory:');
    new EvolutionProjector(graph).projectEpisode(hidden, new ExperienceAttributor().classify(hidden));
    assert.equal(graph.listNodes().length, 0, 'Hidden 不得投影为知识图谱内容');
    graph.close();

    const learning = new PlannerLearningStore(':memory:');
    const storedParent = learning.registerCandidateProposal(parent);
    const identity = candidateIdentity(storedParent);
    learning.upsertValidationRun({
      candidateId: storedParent.id, candidateGeneration: identity.generation,
      candidateContentHash: identity.contentHash, candidateEvidenceCutoffAt: '2026-08-03T00:00:00.000Z',
      baselineEpisodeIds: ['baseline'], baselineCutoffOccurredAt: '2026-08-03T00:00:00.000Z',
      selectionEpisodeIds: ['selection-success', 'selection-failure'], hiddenEpisodeIds: ['HIDDEN-UNIQUE-MARKER'],
      consumedTrialEpisodeIds: [], attempt: 2, status: 'rejected',
    });
    const successor = learning.registerCandidateProposal(proposal);
    const duplicate = learning.registerCandidateProposal(proposal);
    assert.equal(successor.generation, 2);
    assert.equal(successor.evolvedFromCandidateId, storedParent.id);
    assert.equal(duplicate.id, successor.id);
    assert.equal(learning.listCandidatesForLineage(storedParent.lineageId!).length, 2);
    assert.equal(learning.getCandidate(storedParent.id)?.contentHash, storedParent.contentHash, 'G1 必须保持冻结');
    learning.close();
  });

  test('最后一次预算消费同时关闭 ValidationRun，不留下 collecting 空壳', () => {
    const learning = new PlannerLearningStore(':memory:');
    const ledger = new EpisodeLedger(':memory:');
    const stored = learning.registerCandidateProposal(candidate());
    const identity = candidateIdentity(stored);
    learning.upsertValidationRun({
      candidateId: stored.id, candidateGeneration: identity.generation, candidateContentHash: identity.contentHash,
      candidateEvidenceCutoffAt: '2026-08-03T00:00:00.000Z', baselineEpisodeIds: ['baseline'],
      baselineCutoffOccurredAt: '2026-08-03T00:00:00.000Z', selectionEpisodeIds: ['s1', 's2'], hiddenEpisodeIds: ['h1'],
      consumedTrialEpisodeIds: ['old-s1', 'old-s2', 'old-h1'], attempt: 2, status: 'evaluating',
    });
    learning.upsertAgenda({
      candidateId: stored.id, status: 'inconclusive', expectedInformationGain: 1, uncertainty: .5,
      impactScope: 1, estimatedCost: 2, safetyRisk: 0, headroom: .5, retryBudget: 1,
      validationSpec: stored.validationSpec,
    });
    const scheduler = new CandidateTrialScheduler(ledger, learning, new ExperienceAttributor());
    const settlement = scheduler.settle(ready(stored.id), 'reject', false);
    const agenda = new ResearchAgenda(learning).settle(stored.id, 'inconclusive');
    assert.equal(settlement, 'exhausted');
    assert.equal(learning.getValidationRun(stored.id)?.status, 'rejected');
    assert.equal(agenda.retryBudget, 0);
    assert.equal(agenda.status, 'backlog');
    assert.equal(agenda.reason, 'retry_exhausted');
    ledger.close(); learning.close();
  });

  test('Engine 启动时修复旧的 retry=0/collecting 状态，并幂等回灌真实 G2', () => {
    const root=mkdtempSync(join(tmpdir(),'successor-reflection-')),db=join(root,'evolution.db');
    const ledger=new EpisodeLedger(db),learning=new PlannerLearningStore(db),policies=new PlannerPolicyStore(db),graph=new EvolutionGraphStore(db);
    try{
      appendEpisode(ledger,productionEpisode('baseline-production'));
      const engine=new PlannerEvolutionEngine(ledger,learning,policies,new EvolutionProjector(graph));
      engine.refreshCandidates();
      const parent=learning.listCandidates()[0];assert.ok(parent);
      const success=episode('selection-live-success','selection','succeeded',parent.id);
      const failure=episode('selection-live-failure','selection','failed',parent.id);
      const hidden=episode('HIDDEN-LIVE-UNIQUE','hidden','failed',parent.id);
      appendEpisode(ledger,success);appendEpisode(ledger,failure);appendEpisode(ledger,hidden);
      const run=learning.getValidationRun(parent.id)!;
      const {updatedAt:_updatedAt,...persisted}=run;
      learning.upsertValidationRun({...persisted,selectionEpisodeIds:[],hiddenEpisodeIds:[],consumedTrialEpisodeIds:[success.sessionId,failure.sessionId,hidden.sessionId],attempt:3,status:'collecting'});
      const agenda=learning.listAgenda().find(item=>item.candidateId===parent.id)!;
      // Simulate the legacy runtime that exhausted the budget but lost the
      // terminal reason while rescheduling the agenda.
      const { reason: _legacyReason, updatedAt: _agendaUpdatedAt, ...legacyAgenda } = agenda;
      learning.upsertAgenda({...legacyAgenda,status:'backlog',retryBudget:0});

      engine.refreshCandidates();
      const lineage=learning.listCandidatesForLineage(parent.lineageId!);
      assert.deepEqual(lineage.map(value=>value.generation),[1,2]);
      assert.equal(learning.getValidationRun(parent.id)?.status,'rejected');
      assert.equal(learning.listAgenda().find(item=>item.candidateId===parent.id)?.reason,'retry_exhausted');
      assert.equal(lineage[1]?.evolvedFromCandidateId,parent.id);
      assert.equal(JSON.stringify(lineage[1]).includes('HIDDEN-LIVE-UNIQUE'),false);
      assert.equal(learning.getValidationRun(lineage[1]!.id)?.status,'collecting');
      assert.equal(learning.listAgenda().find(item=>item.candidateId===lineage[1]!.id)?.retryBudget,2);
      engine.refreshCandidates();
      assert.equal(learning.listCandidatesForLineage(parent.lineageId!).length,2,'后台重放不得重复创建 G3');
    }finally{graph.close();policies.close();learning.close();ledger.close();rmSync(root,{recursive:true,force:true});}
  });

  test('成功 Selection 的累计消耗预算真实进入后继候选，而不是停留在工具函数', () => {
    const parent = candidate();
    const success = resourceEpisode('selection-resource-success', 'succeeded', parent.id, [
      { cobblestone: 12, raw_iron: 5 },
      { cobblestone: -11, raw_iron: -3 },
      { iron_pickaxe: 1 },
    ]);
    const proposal = new CandidateSuccessorReflector().reflect(parent, [success]);
    assert.ok(proposal);
    const schema = proposal.content.taskSchemas.find(value => isRecord(value)
      && Array.isArray(value.stages)
      && value.stages.some(stage => isRecord(stage) && stage.stage === 'obtain:cobblestone')) as {
        stages: Array<{ stage: string; structuredSuccessCriteria: Array<{ count: number }>; demandEvidence?: { basis: string; totalConsumed: number } }>;
      } | undefined;
    assert.ok(schema, 'SuccessorReflector 应输出结构化资源 Schema');
    const cobble = schema.stages.find(stage => stage.stage === 'obtain:cobblestone');
    const iron = schema.stages.find(stage => stage.stage === 'obtain:raw_iron');
    assert.equal(cobble?.structuredSuccessCriteria[0]?.count, 11);
    assert.equal(cobble?.demandEvidence?.basis, 'success_consumption_budget');
    assert.equal(cobble?.demandEvidence?.totalConsumed, 11);
    assert.equal(iron?.structuredSuccessCriteria[0]?.count, 3, '成功轨迹的过采不得固化成需求');
  });

  test('失败 Selection 只保守提高父代已有资源阈值并同步进入后继候选', () => {
    const parent = candidate();
    const criterion = { type: 'inventory', item: 'cobblestone', count: 8 };
    parent.content.taskSchemas = [{
      id: 'schema:iron', taskFamily: 'crafting', goalPattern: '制作1个铁镐',
      stages: [{ stage: 'obtain:cobblestone', goalText: '获得至少 8 个 cobblestone，作为后续任务依赖', structuredSuccessCriteria: [criterion], successCriteria: [criterion] }],
    }];
    parent.content.planFragments = [{
      id: 'fragment:cobble', stage: 'obtain:cobblestone', goalText: '获得至少 8 个 cobblestone，作为后续任务依赖',
      structuredSuccessCriteria: [criterion], successCriteria: [criterion],
    }];
    const failure = resourceEpisode('selection-resource-failure', 'failed', parent.id, [
      { cobblestone: 8 },
      { cobblestone: -3 },
      { cobblestone: 4 },
    ]);
    const proposal = new CandidateSuccessorReflector().reflect(parent, [failure]);
    assert.ok(proposal);
    const schema = proposal.content.taskSchemas.find(value => isRecord(value) && value.id === 'schema:iron') as {
      stages: Array<{ structuredSuccessCriteria: Array<{ count: number }>; demandEvidence?: { basis: string; totalAcquired: number } }>;
    } | undefined;
    assert.ok(schema);
    assert.equal(schema.stages[0]?.structuredSuccessCriteria[0]?.count, 12);
    assert.equal(schema.stages[0]?.demandEvidence?.basis, 'failure_conservative_acquisition');
    assert.equal(schema.stages[0]?.demandEvidence?.totalAcquired, 12);
    const fragment = proposal.content.planFragments.find(value => isRecord(value) && value.id === 'fragment:cobble') as {
      structuredSuccessCriteria: Array<{ count: number }>;
    } | undefined;
    assert.equal(fragment?.structuredSuccessCriteria[0]?.count, 12, 'Schema 与 Fragment 必须同时进入 G2');
  });
});

function candidate(): ExperienceCandidate {
  return {
    id: 'candidate:制作1个铁镐', taskFamily: 'crafting', goalPattern: '制作1个铁镐',
    content: {
      taskSchemas: [{ id:'schema:iron', taskFamily:'crafting', goalPattern:'制作1个铁镐', stages:['inspect_recipe','prepare_materials','craft','verify_inventory'] }],
      planFragments: [], planRecoveryPatterns: [],
      metaPolicies: [{ id:'meta:crafting:inspect-first', rule:'inspect_context_and_dependencies_before_execution' }],
      applicability: [{ taskFamily:'crafting', goalContains:'制作1个铁镐', goalSignature:'obtain:item:minecraft:iron_pickaxe:1', targetId:'minecraft:iron_pickaxe' }],
    },
    evidenceIds: ['baseline-evidence'], positiveEpisodeIds: ['baseline'], negativeEpisodeIds: [],
    confidenceLowerBound: .55, status: 'candidate',
    validationSpec: {
      id:'validation:iron',validatorId:'crafting-goal-verifier',primaryMetric:'success_rate',
      minimumSelectionSamples:2,minimumHiddenSamples:1,pairing:'snapshot_pair',treatmentField:'planner_policy',
    },
  };
}

function episode(sessionId:string, split:'selection'|'hidden', outcome:'succeeded'|'failed',candidateId='candidate:制作1个铁镐'):PlannerLeafEpisode {
  const planRunId=`plan-${sessionId}`;
  const facts:ExecutionFactEnvelopeV1[]=[
    fact(sessionId,planRunId,1,'execution.plan.bound',{
      parentGoalText:'制作1个铁镐',goalSignature:'obtain:item:minecraft:iron_pickaxe:1',
      experienceMode:'experiment',experimentSplit:split,candidateId,
      planGraph:{id:planRunId,goalId:`goal-${sessionId}`,nodes:[{id:'node-1',goal:{id:'g1',goalText:'制作1个铁镐',metadata:{targetId:'minecraft:iron_pickaxe'}},state:'ready'}],edges:[],budget:{maxNodes:8,maxGraphReplans:2},provenance:[]},
    }),
    fact(sessionId,planRunId,2,'execution.session.started',{goalText:'制作1个铁镐',parentGoalText:'制作1个铁镐'}),
    fact(sessionId,planRunId,3,'execution.action.proposed',{proposal:{action:'gather',args:{itemName:'oak_log'}}}),
    fact(sessionId,planRunId,4,'execution.progress.observed',{meaningful:true,progress:{inventoryDelta:{oak_log:1}}}),
    fact(sessionId,planRunId,5,'execution.session.terminal',outcome==='succeeded'
      ?{outcome:'succeeded',handoff:'none',verdict:{ok:true,detail:'done'}}
      :{outcome:'failed',handoff:'graph_replan_required',verdict:{ok:false,detail:'no path'},failure:{code:'navigation.no_path',origin:'navigation',stage:'executing',category:'navigation',retryable:false,ownerActionable:false,evidenceRefs:[`${sessionId}:failure`]}}),
  ];
  return {sessionId,runId:`run-${sessionId}`,planRunId,planRevision:1,nodeId:'node-1',state:'finalized',firstSequence:1,lastContiguousSequence:5,maxSequence:5,terminalSequence:5,outcome,facts};
}

function productionEpisode(sessionId:string):PlannerLeafEpisode{
  const planRunId=`plan-${sessionId}`;
  const facts:ExecutionFactEnvelopeV1[]=[
    fact(sessionId,planRunId,1,'execution.plan.bound',{parentGoalText:'制作1个铁镐',goalSignature:'obtain:item:minecraft:iron_pickaxe:1',experienceMode:'production',planGraph:{id:planRunId,goalId:`goal-${sessionId}`,nodes:[{id:'node-1',goal:{id:'g1',goalText:'制作1个铁镐',metadata:{targetId:'minecraft:iron_pickaxe'}},state:'ready'}],edges:[],budget:{maxNodes:8,maxGraphReplans:2},provenance:[]}}),
    fact(sessionId,planRunId,2,'execution.session.started',{goalText:'制作1个铁镐',parentGoalText:'制作1个铁镐'}),
    fact(sessionId,planRunId,3,'execution.action.proposed',{proposal:{action:'gather',args:{itemName:'oak_log'}}}),
    fact(sessionId,planRunId,4,'execution.progress.observed',{meaningful:true,progress:{inventoryDelta:{oak_log:1}}}),
    fact(sessionId,planRunId,5,'execution.session.terminal',{outcome:'succeeded',handoff:'none',verdict:{ok:true,detail:'done'}}),
  ];
  return {sessionId,runId:`run-${sessionId}`,planRunId,planRevision:1,nodeId:'node-1',state:'finalized',firstSequence:1,lastContiguousSequence:5,maxSequence:5,terminalSequence:5,outcome:'succeeded',facts};
}

function resourceEpisode(
  sessionId: string,
  outcome: 'succeeded' | 'failed',
  candidateId: string,
  deltas: Array<Record<string, number>>,
): PlannerLeafEpisode {
  const planRunId = `plan-${sessionId}`;
  const facts: ExecutionFactEnvelopeV1[] = [
    fact(sessionId, planRunId, 1, 'execution.plan.bound', {
      parentGoalText: '制作1个铁镐', goalSignature: 'obtain:item:minecraft:iron_pickaxe:1',
      experienceMode: 'experiment', experimentSplit: 'selection', candidateId,
      planGraph: {
        id: planRunId, goalId: `goal-${sessionId}`,
        nodes: [{
          id: 'node-1',
          goal: {
            id: 'g1', goalText: '制作1个铁镐',
            metadata: {
              targetId: 'minecraft:iron_pickaxe',
              structuredSuccessCriteria: [{ type: 'inventory', item: 'iron_pickaxe', count: 1 }],
            },
          }, state: 'ready',
        }],
        edges: [], budget: { maxNodes: 8, maxGraphReplans: 2 }, provenance: [],
      },
    }),
    fact(sessionId, planRunId, 2, 'execution.session.started', { goalText: '制作1个铁镐', parentGoalText: '制作1个铁镐' }),
    fact(sessionId, planRunId, 3, 'execution.action.proposed', { proposal: { action: 'craft', args: { itemName: 'iron_pickaxe' }, source: 'fast_strategy' } }),
    ...deltas.map((inventoryDelta, index) => fact(
      sessionId,
      planRunId,
      4 + index,
      'execution.progress.observed',
      { meaningful: true, inventoryDelta },
    )),
  ];
  const terminalSequence = 4 + deltas.length;
  facts.push(fact(sessionId, planRunId, terminalSequence, 'execution.session.terminal', outcome === 'succeeded'
    ? { outcome: 'succeeded', handoff: 'none', verdict: { ok: true, detail: 'done' } }
    : {
        outcome: 'failed', handoff: 'graph_replan_required', verdict: { ok: false, detail: 'resource budget insufficient' },
        failure: {
          code: 'planner.resource_budget_insufficient', origin: 'decision', stage: 'deciding', category: 'precondition',
          retryable: false, ownerActionable: false, evidenceRefs: [`${sessionId}:failure`],
        },
      }));
  return {
    sessionId, runId: `run-${sessionId}`, planRunId, planRevision: 1, nodeId: 'node-1', state: 'finalized',
    firstSequence: 1, lastContiguousSequence: terminalSequence, maxSequence: terminalSequence,
    terminalSequence, outcome, facts,
  };
}
function appendEpisode(ledger:EpisodeLedger, value:PlannerLeafEpisode):void{for(const item of value.facts)ledger.appendFact(item);}

function fact(sessionId:string,planRunId:string,sequence:number,eventType:string,payload:Record<string,unknown>):ExecutionFactEnvelopeV1 {
  return {schema:EXECUTION_FACT_SCHEMA_V1,eventId:`${sessionId}:event:${sequence}`,eventType,sessionId,runId:`run-${sessionId}`,planRunId,planRevision:1,nodeId:'node-1',sequence,occurredAt:new Date(Date.UTC(2026,7,3,0,0,sequence)).toISOString(),codeRevision:'test',configRevision:'test',correlationId:`corr-${sessionId}`,payload};
}
function ready(candidateId:string):CandidateEvaluationReady {
  const value=metrics();return {candidateId,attempt:2,baselineEpisodeIds:['baseline'],selectionEpisodeIds:['s1','s2'],hiddenEpisodeIds:['h1'],control:{selection:value,hidden:value,triggered:true,compliant:true,comparable:true},treatment:{selection:value,hidden:value,triggered:true,compliant:true,comparable:true}};
}
function metrics():PolicyMetrics{return {successRate:0,medianDurationMs:1000,medianActions:10,medianLlmRounds:5,interventionRate:0,safetyViolations:0,samples:1};}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
