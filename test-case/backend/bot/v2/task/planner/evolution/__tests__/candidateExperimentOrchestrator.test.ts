import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CandidateExperimentOrchestrator } from '../../../../../../../../apps/minecraft-companion/src/bot/v2/task/planner/evolution/candidateExperimentOrchestrator.js';
import { CandidateTrialScheduler } from '../../../../../../../../apps/minecraft-companion/src/bot/v2/task/planner/evolution/candidateTrialScheduler.js';
import { EpisodeLedger } from '../../../../../../../../apps/minecraft-companion/src/bot/v2/task/planner/evolution/episodeLedger.js';
import { PlannerLearningStore } from '../../../../../../../../apps/minecraft-companion/src/bot/v2/task/planner/evolution/learningStore.js';
import { ExperienceAttributor } from '../../../../../../../../apps/minecraft-companion/src/bot/v2/task/planner/evolution/attributor.js';
import type { ExperienceCandidate } from '../../../../../../../../apps/minecraft-companion/src/bot/v2/task/planner/evolution/plannerOptimizer.js';
import type { ContextSignature, GoalSignature } from '../../../../../../../../apps/minecraft-companion/src/bot/v2/task/planner/plannerContracts.js';
import { EXECUTION_FACT_SCHEMA_V1, type ExecutionFactEnvelopeV1 } from '../../../../../../../../apps/minecraft-companion/src/bot/v2/task/planner/evolution/contracts/executionFactsV1.js';
import { comparableContextHash } from '../../../../../../../../apps/minecraft-companion/src/bot/v2/task/planner/contextEncoder.js';

const tempDirs: string[] = [];
afterEach(() => { for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('FEAT-CROSS-14-006-003 · production candidate experiment authorization', () => {
  test('显式开启后按 selection→hidden 串行授权，关闭时普通 PlanRun 永不试用候选', () => {
    const m = modules();
    seed(m.learning);
    const orchestrator = new CandidateExperimentOrchestrator(m.ledger, m.learning);

    assert.equal(orchestrator.authorize(request('plan-off', false)), null);
    assert.equal(m.learning.listExperimentAllocations().length, 0);

    const first = orchestrator.authorize(request('plan-selection-1', true));
    assert.equal(first?.split, 'selection');
    assert.equal(first?.budget.maxPlanRuns, 1);
    assert.deepEqual(orchestrator.authorize(request('plan-selection-1', true)), first, '同一 PlanRun 必须幂等复用授权');
    assert.equal(orchestrator.authorize(request('plan-selection-overlap', true)), null, '未封账前不得并发透支样本预算');

    appendTrial(m.ledger, 'plan-selection-1', first!);
    orchestrator.finalizePlanRun('plan-selection-1', 'succeeded');
    const second = orchestrator.authorize(request('plan-selection-2', true));
    assert.equal(second?.split, 'selection');
    appendTrial(m.ledger, 'plan-selection-2', second!);
    orchestrator.finalizePlanRun('plan-selection-2', 'succeeded');

    const hidden = orchestrator.authorize(request('plan-hidden-1', true));
    assert.equal(hidden?.split, 'hidden');
    appendTrial(m.ledger, 'plan-hidden-1', hidden!);
    orchestrator.finalizePlanRun('plan-hidden-1', 'succeeded');
    orchestrator.reconcile();

    const scheduler = new CandidateTrialScheduler(m.ledger, m.learning, new ExperienceAttributor());
    const ready = scheduler.advance(candidate());
    assert.ok(ready);
    assert.equal(ready.selectionEpisodeIds.length, 2);
    assert.equal(ready.hiddenEpisodeIds.length, 1);
    assert.equal(ready.treatment.triggered, true);
    assert.equal(orchestrator.authorize(request('plan-extra', true)), null, '样本满足后不得继续授权');
    m.close();
  });

  test('持久化分配与 execution.plan.bound 授权不一致时废弃且不进入评测', () => {
    const m = modules(); seed(m.learning);
    const orchestrator = new CandidateExperimentOrchestrator(m.ledger, m.learning);
    const auth = orchestrator.authorize(request('plan-mismatch', true));
    assert.ok(auth);
    appendTrial(m.ledger, 'plan-mismatch', { ...auth!, experimentId: 'tampered' });
    orchestrator.reconcile();
    assert.equal(m.learning.getExperimentAllocation('plan-mismatch')?.state, 'abandoned');
    assert.equal(new CandidateTrialScheduler(m.ledger, m.learning, new ExperienceAttributor()).advance(candidate()), null);
    m.close();
  });

  test('Control 与当前情境簇不一致时拒绝签发 Treatment', () => {
    const m=modules();seed(m.learning);
    const baselineContext={...context(),inventory:{oak_log:1}};
    appendBaseline(m.ledger,'baseline-context',baselineContext);
    m.learning.upsertValidationRun({candidateId:candidate().id,baselineEpisodeIds:['baseline-context'],baselineCutoffOccurredAt:'2026-08-03T00:00:03.000Z',selectionEpisodeIds:[],hiddenEpisodeIds:[],consumedTrialEpisodeIds:[],attempt:1,status:'collecting'});
    const orchestrator=new CandidateExperimentOrchestrator(m.ledger,m.learning);
    assert.equal(orchestrator.authorize(request('plan-incomparable',true)),null);
    assert.equal(orchestrator.authorize(request('plan-comparable',true,baselineContext))?.split,'selection');
    m.close();
  });

  test('候选重试消费旧 Treatment，下一次只签发新的 PlanRun 快照', () => {
    const m=modules();seed(m.learning);
    const orchestrator=new CandidateExperimentOrchestrator(m.ledger,m.learning);
    const authorizations=[];
    for(const id of ['retry-selection-a','retry-selection-b','retry-hidden-a']){
      const auth=orchestrator.authorize(request(id,true));assert.ok(auth);authorizations.push(auth!);appendTrial(m.ledger,id,auth!);orchestrator.finalizePlanRun(id,'succeeded');
    }
    const scheduler=new CandidateTrialScheduler(m.ledger,m.learning,new ExperienceAttributor());
    const ready=scheduler.advance(candidate());assert.ok(ready);
    assert.equal(scheduler.settle(ready!,'inconclusive'),'retry');
    const retried=m.learning.getValidationRun(candidate().id)!;
    assert.equal(retried.attempt,2);
    assert.deepEqual(new Set(retried.consumedTrialEpisodeIds),new Set(['session:retry-selection-a','session:retry-selection-b','session:retry-hidden-a']));
    const next=orchestrator.authorize(request('retry-selection-new',true));
    assert.equal(next?.split,'selection');
    assert.equal(next?.candidateGeneration,authorizations[0]?.candidateGeneration);
    assert.equal(next?.candidateContentHash,authorizations[0]?.candidateContentHash);
    m.close();
  });

  test('一个多叶子 PlanRun 只计一个实验样本，父终态前不释放下一授权', () => {
    const m=modules();seed(m.learning);
    const orchestrator=new CandidateExperimentOrchestrator(m.ledger,m.learning);
    const first=orchestrator.authorize(request('multi-leaf-selection-1',true));assert.ok(first);
    appendTrial(m.ledger,'multi-leaf-selection-1',first!);
    appendTrialLeaf(m.ledger,'multi-leaf-selection-1','node-2',first!);
    orchestrator.reconcile();
    assert.equal(orchestrator.authorize(request('must-wait-for-parent-terminal',true)),null);
    orchestrator.finalizePlanRun('multi-leaf-selection-1','succeeded');
    const second=orchestrator.authorize(request('multi-leaf-selection-2',true));
    assert.equal(second?.split,'selection');
    m.close();
  });

  test('叶子先封账时 allocation=allocated 不得提前进入 Selection/Hidden 或触发评测', () => {
    const m=modules();seed(m.learning);
    const orchestrator=new CandidateExperimentOrchestrator(m.ledger,m.learning);
    const scheduler=new CandidateTrialScheduler(m.ledger,m.learning,new ExperienceAttributor());

    const first=orchestrator.authorize(request('parent-gate-selection-1',true));assert.ok(first);
    appendTrial(m.ledger,'parent-gate-selection-1',first!);
    assert.equal(scheduler.advance(candidate()),null);
    assert.deepEqual(m.learning.getValidationRun(candidate().id)?.selectionEpisodeIds,[]);
    orchestrator.finalizePlanRun('parent-gate-selection-1','succeeded');
    assert.equal(scheduler.advance(candidate()),null);
    assert.equal(m.learning.getValidationRun(candidate().id)?.selectionEpisodeIds.length,1);

    const second=orchestrator.authorize(request('parent-gate-selection-2',true));assert.ok(second);
    appendTrial(m.ledger,'parent-gate-selection-2',second!);
    assert.equal(scheduler.advance(candidate()),null);
    assert.equal(m.learning.getValidationRun(candidate().id)?.selectionEpisodeIds.length,1);
    orchestrator.finalizePlanRun('parent-gate-selection-2','succeeded');
    assert.equal(scheduler.advance(candidate()),null);
    assert.equal(m.learning.getValidationRun(candidate().id)?.selectionEpisodeIds.length,2);

    const hidden=orchestrator.authorize(request('parent-gate-hidden',true));assert.ok(hidden);
    appendTrial(m.ledger,'parent-gate-hidden',hidden!);
    assert.equal(scheduler.advance(candidate()),null);
    assert.deepEqual(m.learning.getValidationRun(candidate().id)?.hiddenEpisodeIds,[]);
    orchestrator.finalizePlanRun('parent-gate-hidden','cancelled');
    assert.equal(scheduler.advance(candidate()),null);
    assert.deepEqual(m.learning.getValidationRun(candidate().id)?.hiddenEpisodeIds,[]);
    m.close();
  });

  test('goal_cancelled 即使父层包装为 failed 也废弃且不污染 Selection', () => {
    const m=modules();seed(m.learning);
    const orchestrator=new CandidateExperimentOrchestrator(m.ledger,m.learning);
    const auth=orchestrator.authorize(request('cancelled-treatment',true));assert.ok(auth);
    appendTrial(m.ledger,'cancelled-treatment',auth!);
    orchestrator.finalizePlanRun('cancelled-treatment','failed','goal_cancelled');
    assert.equal(m.learning.getExperimentAllocation('cancelled-treatment')?.state,'abandoned');
    const scheduler=new CandidateTrialScheduler(m.ledger,m.learning,new ExperienceAttributor());
    assert.equal(scheduler.advance(candidate()),null);
    assert.deepEqual(m.learning.getValidationRun(candidate().id)?.selectionEpisodeIds,[]);
    m.close();
  });
});

function modules() {
  const dir = mkdtempSync(join(tmpdir(), 'planner-experiment-')); tempDirs.push(dir);
  const db = join(dir, 'evolution.db');
  const ledger = new EpisodeLedger(db);
  const learning = new PlannerLearningStore(db);
  return { ledger, learning, close() { learning.close(); ledger.close(); } };
}

function seed(learning: PlannerLearningStore): void {
  const value = candidate();
  learning.upsertCandidate(value);
  learning.upsertValidationRun({
    candidateId: value.id, baselineEpisodeIds: [], baselineCutoffOccurredAt: '',
    selectionEpisodeIds: [], hiddenEpisodeIds: [], consumedTrialEpisodeIds: [],
    attempt: 1, status: 'collecting',
  });
  learning.upsertAgenda({
    candidateId: value.id, status: 'queued', expectedInformationGain: 1,
    uncertainty: .5, impactScope: 3, estimatedCost: 2, safetyRisk: 0,
    headroom: .5, retryBudget: 2, validationSpec: value.validationSpec,
  });
}

function candidate(): ExperienceCandidate {
  return {
    id: 'candidate:iron-pickaxe', taskFamily: 'crafting', goalPattern: '制作一把铁镐',
    content: {
      taskSchemas: [{ id: 'schema:iron-pickaxe', stages: [] }], planFragments: [],
      planRecoveryPatterns: [], metaPolicies: [],
      applicability: [{ taskFamily: 'crafting', targetId: 'minecraft:iron_pickaxe', goalSignature: signature().key }],
    },
    evidenceIds: ['baseline:evidence'], positiveEpisodeIds: [], negativeEpisodeIds: [],
    confidenceLowerBound: .4, status: 'candidate',
    validationSpec: {
      id: 'validation:iron-pickaxe', validatorId: 'inventory', primaryMetric: 'success_rate',
      minimumSelectionSamples: 2, minimumHiddenSamples: 1,
      pairing: 'snapshot_pair', treatmentField: 'planner_policy',
    },
  };
}

function request(planRunId: string, enabled: boolean, value=context()) {
  return { planRunId, goalSignature: signature(), context: value, enabled, maxEstimatedActions: 120 };
}
function signature(): GoalSignature { return { key: 'obtain:item:minecraft:iron_pickaxe:1', outcome: 'obtain', targetKind: 'item', targetId: 'minecraft:iron_pickaxe', quantity: 1, constraintsHash: 'none', compatibleTaskFamilies: ['crafting'], schemaVersion: 1 }; }
function context(): ContextSignature { return { inventory: {}, capabilities: ['goal_agent'], nearbyFacilities: [], nearbyResources: [], timeBucket: 'day', dangerLevel: 0, positionRegion: 'region', worldRevision: 'tick:1' }; }

function appendTrial(ledger: EpisodeLedger, planRunId: string, authorization: NonNullable<ReturnType<CandidateExperimentOrchestrator['authorize']>>): void {
  const sessionId = `session:${planRunId}`;
  ledger.appendFact(fact(sessionId, planRunId, 1, 'execution.session.started', { goalText: '制作一把铁镐' }));
  ledger.appendFact(fact(sessionId, planRunId, 2, 'execution.plan.bound', {
    parentGoalText: '制作一把铁镐', experienceMode: 'experiment',
    candidateId: authorization.candidateId, experimentId: authorization.experimentId,
    candidateGeneration: authorization.candidateGeneration,
    candidateContentHash: authorization.candidateContentHash,
    experimentSplit: authorization.split,
    experimentAuthorizationId: authorization.budget.authorizationId,
    experimentContextComparable: authorization.contextComparable,
    contextSignatureHash: comparableContextHash(context()),
    planGraph: { id: planRunId, goalId: 'goal', nodes: [{ id: 'node-1', goal: { id: 'goal:1', goalText: '制作一把铁镐' }, state: 'ready' }], edges: [], budget: { maxNodes: 8, maxGraphReplans: 2 }, provenance: [] },
  }));
  ledger.appendFact(fact(sessionId, planRunId, 3, 'execution.session.terminal', { outcome: 'succeeded', handoff: 'none', verdict: { ok: true, detail: 'done' } }));
}

function appendTrialLeaf(ledger:EpisodeLedger,planRunId:string,nodeId:string,authorization:NonNullable<ReturnType<CandidateExperimentOrchestrator['authorize']>>):void{
  const sessionId=`session:${planRunId}:${nodeId}`;
  ledger.appendFact({...fact(sessionId,planRunId,1,'execution.session.started',{goalText:'制作一把铁镐'}),nodeId});
  ledger.appendFact({...fact(sessionId,planRunId,2,'execution.plan.bound',{parentGoalText:'制作一把铁镐',experienceMode:'experiment',candidateId:authorization.candidateId,experimentId:authorization.experimentId,candidateGeneration:authorization.candidateGeneration,candidateContentHash:authorization.candidateContentHash,experimentSplit:authorization.split,experimentAuthorizationId:authorization.budget.authorizationId,experimentContextComparable:authorization.contextComparable,contextSignatureHash:comparableContextHash(context()),planGraph:{id:planRunId,goalId:'goal',nodes:[{id:'node-1',goal:{id:'goal:1',goalText:'制作一把铁镐'},state:'ready'},{id:'node-2',goal:{id:'goal:2',goalText:'制作一把铁镐'},state:'ready'}],edges:[],budget:{maxNodes:8,maxGraphReplans:2},provenance:[]}}),nodeId});
  ledger.appendFact({...fact(sessionId,planRunId,3,'execution.session.terminal',{outcome:'succeeded',handoff:'none',verdict:{ok:true,detail:'done'}}),nodeId});
}

function appendBaseline(ledger:EpisodeLedger,sessionId:string,value:ContextSignature):void{
  ledger.appendFact(fact(sessionId,sessionId,1,'execution.session.started',{goalText:'制作一把铁镐'}));
  ledger.appendFact(fact(sessionId,sessionId,2,'execution.plan.bound',{parentGoalText:'制作一把铁镐',goalSignature:signature().key,contextSignatureHash:comparableContextHash(value),planGraph:{id:sessionId,goalId:'goal',nodes:[{id:'node-1',goal:{id:'goal:1',goalText:'制作一把铁镐'},state:'ready'}],edges:[],budget:{maxNodes:8,maxGraphReplans:2},provenance:[]} }));
  ledger.appendFact(fact(sessionId,sessionId,3,'execution.session.terminal',{outcome:'succeeded',handoff:'none',verdict:{ok:true,detail:'done'}}));
}

function fact(sessionId: string, planRunId: string, sequence: number, eventType: string, payload: Record<string, unknown>): ExecutionFactEnvelopeV1 {
  return { schema: EXECUTION_FACT_SCHEMA_V1, eventId: `${sessionId}:${sequence}`, eventType, sessionId, runId: `run:${planRunId}`, planRunId, planRevision: 1, nodeId: 'node-1', sequence, occurredAt: new Date(Date.UTC(2026, 7, 3, 0, 0, sequence)).toISOString(), codeRevision: 'test', configRevision: 'test', correlationId: `corr:${planRunId}`, payload };
}
