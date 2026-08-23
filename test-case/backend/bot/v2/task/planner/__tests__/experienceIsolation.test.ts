import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { PlannerPolicyStore, type PlannerPolicyContent } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/planner/evolution/policyStore.js';
import type { ExperienceCandidate, ValidationSpec } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/planner/evolution/plannerOptimizer.js';
import { PlannerExperienceProvider } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/planner/experience/plannerExperienceProvider.js';
import type { ExperimentAuthorizationV1 } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/planner/experience/experienceContracts.js';
import type { ContextSignature, GoalSignature } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/planner/plannerContracts.js';
import type { PlannerLeafEpisode } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/planner/evolution/episodeLedger.js';
import { candidateExperimentEvidenceEligible } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/planner/evolution/candidateTrialScheduler.js';
import { isCandidateExperimentEpisode, isHiddenExperimentEpisode } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/planner/evolution/plannerEvolutionEngine.js';
import { EXECUTION_FACT_SCHEMA_V1, type ExecutionFactEnvelopeV1 } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/planner/evolution/contracts/executionFactsV1.js';
import { candidateIdentity } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/planner/evolution/candidateIdentity.js';

describe('FEAT-CROSS-14-006-003 · production and experiment isolation', () => {
  test('普通生产无 Trusted 时冷启动且不包含 Candidate', () => {
    const store=new PlannerPolicyStore(':memory:');
    const provider=new PlannerExperienceProvider(store,{listCandidates:()=>[candidate()]});
    assert.equal(provider.retrieve('制作一把铁镐'),null);
    const result=provider.freeze(request('production'));
    assert.equal(result.status,'cold_start');
    if(result.status==='cold_start') assert.equal(result.selectionManifest.selected.length,0);
    store.close();
  });

  test('只有完整、匹配且可比的实验授权才能冻结 Candidate Bundle', () => {
    const store=new PlannerPolicyStore(':memory:');
    const provider=new PlannerExperienceProvider(store,{listCandidates:()=>[candidate()]});
    const incomplete=provider.freezeExperiment(request('experiment'),{} as ExperimentAuthorizationV1);
    assert.deepEqual(incomplete,{status:'rejected',reason:'authorization_incomplete'});
    const incomparable=provider.freezeExperiment(request('experiment'),{...authorization(),contextComparable:false});
    assert.deepEqual(incomparable,{status:'rejected',reason:'context_not_comparable'});
    const frozen=provider.freezeExperiment(request('experiment'),authorization());
    assert.equal(frozen.status,'frozen');
    if(frozen.status==='frozen') {
      assert.equal(frozen.bundle.mode,'experiment');
      assert.equal(frozen.bundle.candidateId,'candidate:iron-pickaxe');
      assert.equal(frozen.bundle.experimentId,'experiment:42');
      assert.equal(frozen.bundle.experimentSplit,'selection');
      assert.equal(frozen.bundle.experimentAuthorizationId,'budget:42');
      assert.equal(Object.isFrozen(frozen.bundle),true);
    }
    store.close();
  });

  test('未触发、缺授权或上下文不可比的 Episode 不形成候选证据，Hidden 不进 Optimizer', () => {
    const identity=candidateIdentity(candidate());
    const snapshot={candidateGeneration:identity.generation,candidateContentHash:identity.contentHash};
    const valid=episode({candidateId:'candidate:iron-pickaxe',...snapshot,experienceMode:'experiment',experimentId:'experiment:42',experimentAuthorizationId:'budget:42',experimentContextComparable:true,experimentSplit:'selection'});
    assert.equal(candidateExperimentEvidenceEligible(valid,'candidate:iron-pickaxe'),true);
    assert.equal(candidateExperimentEvidenceEligible(episode({candidateId:'other',...snapshot,experienceMode:'experiment',experimentId:'experiment:42',experimentAuthorizationId:'budget:42',experimentContextComparable:true,experimentSplit:'selection'}),'candidate:iron-pickaxe'),false);
    assert.equal(candidateExperimentEvidenceEligible(episode({candidateId:'candidate:iron-pickaxe',...snapshot,experienceMode:'experiment',experimentId:'experiment:42',experimentAuthorizationId:'budget:42',experimentContextComparable:false,experimentSplit:'selection'}),'candidate:iron-pickaxe'),false);
    assert.equal(candidateExperimentEvidenceEligible(episode({candidateId:'candidate:iron-pickaxe',...snapshot,experienceMode:'experiment',experimentContextComparable:true,experimentSplit:'selection'}),'candidate:iron-pickaxe'),false);
    assert.equal(isHiddenExperimentEpisode(episode({experimentSplit:'hidden'})),true);
    assert.equal(isCandidateExperimentEpisode(valid),true,'Selection 也必须排除出 Optimizer');
  });
});

function candidate():ExperienceCandidate{return {id:'candidate:iron-pickaxe',taskFamily:'crafting',goalPattern:'制作一把铁镐',content:content(),evidenceIds:['episode:seed'],positiveEpisodeIds:['episode:seed'],negativeEpisodeIds:[],confidenceLowerBound:.7,status:'candidate',validationSpec:validation()};}
function content():PlannerPolicyContent{return {taskSchemas:[{id:'schema:iron-pickaxe',stages:['inspect_recipe','prepare_materials','craft','verify_inventory']}],planFragments:[{id:'fragment:iron-pickaxe'}],planRecoveryPatterns:[],metaPolicies:[],applicability:[{taskFamily:'crafting',targetId:'minecraft:iron_pickaxe'}]};}
function validation():ValidationSpec{return {id:'validation:iron-pickaxe',validatorId:'inventory',primaryMetric:'success_rate',minimumSelectionSamples:2,minimumHiddenSamples:1,pairing:'snapshot_pair',treatmentField:'planner_policy'};}
function authorization():ExperimentAuthorizationV1{const identity=candidateIdentity(candidate());return {schema:'mineclaw.planner-experiment-authorization/v1',experimentId:'experiment:42',candidateId:'candidate:iron-pickaxe',candidateGeneration:identity.generation,candidateContentHash:identity.contentHash,validationSpec:validation(),split:'selection',budget:{authorizationId:'budget:42',maxPlanRuns:3,maxEstimatedActions:120,authorized:true},contextComparable:true};}
function request(mode:'production'|'experiment'){return {planRunId:'plan:42',goalSignature:signature(),context:context(),mode};}
function signature():GoalSignature{return {key:'obtain:item:minecraft:iron_pickaxe:1',outcome:'obtain',targetKind:'item',targetId:'minecraft:iron_pickaxe',quantity:1,constraintsHash:'none',compatibleTaskFamilies:['crafting'],schemaVersion:1};}
function context():ContextSignature{return {inventory:{},capabilities:['goal_agent'],nearbyFacilities:[],nearbyResources:[],timeBucket:'day',dangerLevel:0,positionRegion:'region',worldRevision:'tick:1'};}
function episode(payload:Record<string,unknown>):PlannerLeafEpisode {return {sessionId:'s',runId:'r',planRunId:'p',planRevision:1,nodeId:'n',state:'finalized',firstSequence:1,lastContiguousSequence:1,maxSequence:1,terminalSequence:1,outcome:'succeeded',facts:[fact(payload)]};}
function fact(payload:Record<string,unknown>):ExecutionFactEnvelopeV1{return {schema:EXECUTION_FACT_SCHEMA_V1,eventId:'e',eventType:'execution.plan.bound',sessionId:'s',runId:'r',planRunId:'p',planRevision:1,nodeId:'n',sequence:1,occurredAt:'2026-08-02T00:00:00.000Z',codeRevision:'test',configRevision:'test',correlationId:'c',payload};}
