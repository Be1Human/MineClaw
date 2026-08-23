import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { EvolutionGraphStore } from '../../../../../../../../apps/minecraft-companion/src/bot/v2/task/planner/evolution/evolutionGraphStore.js';
import { EvolutionProjector } from '../../../../../../../../apps/minecraft-companion/src/bot/v2/task/planner/evolution/evolutionProjector.js';
import type { PlannerLeafEpisode } from '../../../../../../../../apps/minecraft-companion/src/bot/v2/task/planner/evolution/episodeLedger.js';
import type { EpisodeAttribution } from '../../../../../../../../apps/minecraft-companion/src/bot/v2/task/planner/evolution/attributor.js';
import { EXECUTION_FACT_SCHEMA_V1, type ExecutionFactEnvelopeV1 } from '../../../../../../../../apps/minecraft-companion/src/bot/v2/task/planner/evolution/contracts/executionFactsV1.js';

describe('FEAT-CROSS-14-006-005 · plan experience projection',()=>{
  test('PlanNode、Manifest、Policy、Episode 与 execution facts 形成采用/舍弃/支持证据链',()=>{
    const graph=new EvolutionGraphStore(':memory:');
    const projector=new EvolutionProjector(graph);
    projector.projectEpisode(episode(),attribution());
    assert.ok(graph.getNode('plan:plan-1:node-1'));
    assert.ok(graph.getNode('selection:manifest:1'));
    assert.ok(graph.getNode('experience:schema:iron-pickaxe'));
    assert.ok(graph.getNode('rejection:selection:manifest:1:candidate:shortcut'));
    assert.ok(graph.getNode('evidence:bound-1'));
    const edges=graph.listEdges({limit:100});
    assert.ok(edges.some(edge=>edge.type==='executed_under'));
    assert.ok(edges.some(edge=>edge.type==='compiled_from'));
    assert.ok(edges.some(edge=>edge.type==='used_experience'));
    assert.ok(edges.some(edge=>edge.type==='supports'));
    assert.ok(edges.some(edge=>edge.type==='defined_by'));
    assert.ok(edges.some(edge=>edge.type==='rejected_experience'));
    assert.equal(edges.some(edge=>edge.type==='requires'&&edge.to.includes('rejection:')),false);
    graph.close();
  });
});

function episode():PlannerLeafEpisode{return {sessionId:'session-1',runId:'run-1',planRunId:'plan-1',planRevision:1,nodeId:'node-1',state:'finalized',firstSequence:1,lastContiguousSequence:2,maxSequence:2,terminalSequence:2,outcome:'succeeded',facts:[bound(),terminal()]};}
function bound():ExecutionFactEnvelopeV1{return fact('bound-1',1,'execution.plan.bound',{parentGoalText:'制作一把铁镐',policySnapshotId:'policy-iron@2',experienceMode:'production',bundleId:'bundle:1',contentHash:'hash',selectionManifestId:'manifest:1',selectionManifest:{id:'manifest:1',planRunId:'plan-1',query:{goalSignature:'obtain:item:minecraft:iron_pickaxe:1',contextSignatureHash:'context'},selected:[{experienceId:'schema:iron-pickaxe',policyId:'policy-iron',type:'task_schema',score:.95,reasons:['exact_goal_match'],evidenceRefs:['episode:seed']}],rejected:[{experienceId:'candidate:shortcut',policyId:'candidate:shortcut',reason:'not_trusted'}]},planGraph:{id:'plan-1',goalId:'goal-1',bundleId:'bundle:1',contentHash:'hash',policySnapshotId:'policy-iron@2',selectionManifestId:'manifest:1',nodes:[{id:'node-1',goal:{id:'goal-1:1',goalText:'制作铁镐',successCriteria:['iron_pickaxe>=1']},state:'ready',experienceRefs:['schema:iron-pickaxe']}],edges:[],budget:{maxNodes:8,maxGraphReplans:2},provenance:['bundle:1']}});}
function terminal():ExecutionFactEnvelopeV1{return fact('terminal-1',2,'execution.session.terminal',{outcome:'succeeded',handoff:'none',verdict:{ok:true,detail:'done'}});}
function fact(eventId:string,sequence:number,eventType:string,payload:Record<string,unknown>):ExecutionFactEnvelopeV1{return {schema:EXECUTION_FACT_SCHEMA_V1,eventId,eventType,sessionId:'session-1',runId:'run-1',planRunId:'plan-1',planRevision:1,nodeId:'node-1',sequence,occurredAt:`2026-08-02T00:00:0${sequence}.000Z`,codeRevision:'test',configRevision:'test',correlationId:'goal-1',payload};}
function attribution():EpisodeAttribution{return {episodeId:'session-1',category:'success',reason:'goal_verified',learnable:true,confidence:1,evidenceIds:['bound-1','terminal-1']};}
