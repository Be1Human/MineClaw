import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlannerExperienceExporter } from '../../../../apps/minecraft-companion/src/hub/plannerExperienceExporter.js';
import { EpisodeLedger } from '../../../../apps/minecraft-companion/src/bot/v2/task/planner/evolution/episodeLedger.js';
import { PlannerPolicyStore } from '../../../../apps/minecraft-companion/src/bot/v2/task/planner/evolution/policyStore.js';
import { PlannerLearningStore } from '../../../../apps/minecraft-companion/src/bot/v2/task/planner/evolution/learningStore.js';
import { EvolutionGraphStore } from '../../../../apps/minecraft-companion/src/bot/v2/task/planner/evolution/evolutionGraphStore.js';
import { EvolutionProjector } from '../../../../apps/minecraft-companion/src/bot/v2/task/planner/evolution/evolutionProjector.js';
import { ExperienceAttributor } from '../../../../apps/minecraft-companion/src/bot/v2/task/planner/evolution/attributor.js';
import { EXECUTION_FACT_SCHEMA_V1, type ExecutionFactEnvelopeV1 } from '../../../../apps/minecraft-companion/src/bot/v2/task/planner/evolution/contracts/executionFactsV1.js';

const dirs:string[]=[];afterEach(()=>{for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});

describe('FEAT-CROSS-14-006-007/008 · planner audit export',()=>{
  test('full/policy/plan_run/episode 均生成可读、闭包、脱敏且只读的 ZIP',()=>{
    const root=mkdtempSync(join(tmpdir(),'planner-audit-'));dirs.push(root);const db=join(root,'planner.db'),jsonl=join(root,'facts.jsonl');seed(db,jsonl);
    const before={db:hash(readFileSync(db)),jsonl:hash(readFileSync(jsonl))};
    const exporter=new PlannerExperienceExporter();
    for(const scope of [{type:'full'} as const,{type:'policy',id:'policy-iron'} as const,{type:'plan_run',id:'plan-1'} as const,{type:'episode',id:'session-1'} as const]){
      const result=exporter.export({profileId:'profile-a',dbPath:db,jsonlPath:jsonl,scope});
      const files=readZip(result.buffer);assert.ok(files.has('README.md'));assert.ok(files.has('manifest.json'));assert.ok(files.has('markdown/policies.md'));assert.ok(files.has('machine/graph.json'));assert.equal(files.has('machine/facts.jsonl'),false);
      const readme=files.get('README.md')!.toString('utf8');assert.match(readme,/只读快照/);assert.match(readme,/采用\/舍弃经验/);
      const manifest=JSON.parse(files.get('manifest.json')!.toString('utf8')) as {profileId:string;scope:{type:string};databaseRevision:string;jsonlHighWatermark:number;redactionVersion:string;files:Record<string,string>};
      assert.equal(manifest.profileId,'profile-a');assert.equal(manifest.scope.type,scope.type);assert.match(manifest.databaseRevision,/^sha256:/);assert.ok(manifest.jsonlHighWatermark>0);assert.equal(manifest.redactionVersion,'planner-audit-redaction/v1');
      for(const [name,digest] of Object.entries(manifest.files))assert.equal(hash(files.get(name)!),digest);
      const allText=[...files.values()].map(value=>value.toString('utf8')).join('\n');assert.doesNotMatch(allText,/C:\\Users\\Owner/);assert.doesNotMatch(allText,/sk-super-secret/);assert.doesNotMatch(allText,/"x"\s*:/);assert.doesNotMatch(allText,/主人私聊/);
      const graph=JSON.parse(files.get('machine/graph.json')!.toString('utf8')) as {nodes:Array<{id:string}>;edges:Array<{from:string;to:string}>};const ids=new Set(graph.nodes.map(value=>value.id));assert.equal(graph.edges.every(edge=>ids.has(edge.from)&&ids.has(edge.to)),true);
    }
    assert.deepEqual({db:hash(readFileSync(db)),jsonl:hash(readFileSync(jsonl))},before);
  });

  test('并发追加后的既有导出固定在声明 watermark，业务文件可确定复现',()=>{
    const root=mkdtempSync(join(tmpdir(),'planner-audit-watermark-'));dirs.push(root);const db=join(root,'planner.db'),jsonl=join(root,'facts.jsonl');seed(db,jsonl);const exporter=new PlannerExperienceExporter();
    const first=exporter.export({profileId:'profile-a',dbPath:db,jsonlPath:jsonl,scope:{type:'full'},includeRawFacts:true});const firstFiles=readZip(first.buffer);const firstManifest=JSON.parse(firstFiles.get('manifest.json')!.toString('utf8')) as {jsonlHighWatermark:number};
    writeFileSync(jsonl,`${JSON.stringify({eventId:'late',position:{x:999,y:99,z:999}})}\n`,{flag:'a'});
    assert.equal(firstFiles.get('machine/facts.jsonl')!.length<=firstManifest.jsonlHighWatermark,true);assert.doesNotMatch(firstFiles.get('machine/facts.jsonl')!.toString('utf8'),/late|999/);
    const second=exporter.export({profileId:'profile-a',dbPath:db,jsonlPath:jsonl,scope:{type:'full'},includeRawFacts:false});const secondFiles=readZip(second.buffer);
    for(const name of ['machine/policies.json','machine/plan-runs.json','machine/episodes.json','machine/graph.json'])assert.deepEqual(secondFiles.get(name),firstFiles.get(name));
  });
});

function seed(db:string,jsonl:string):void {
  const learning=new PlannerLearningStore(db);learning.close();
  const policy=new PlannerPolicyStore(db);const candidate=policy.createCandidate({id:'policy-iron',version:1,content:{taskSchemas:[{id:'schema:iron'}],planFragments:[{id:'fragment:iron'}],planRecoveryPatterns:[{id:'recovery:iron'}],metaPolicies:[{id:'meta:iron'}],applicability:[{taskFamily:'crafting',targetId:'minecraft:iron_pickaxe'}]},evidenceIds:['seed-evidence'],confidenceLowerBound:.9});policy.promote(candidate.id,candidate.revision,{decision:'promote',selectionDelta:.1,hiddenRegression:false,safetyViolations:0,evaluationId:'eval-1'});policy.close();
  const ledger=new EpisodeLedger(db);for(const value of facts())ledger.appendFact(value);const episode=ledger.getEpisode('session-1')!;const graph=new EvolutionGraphStore(db);new EvolutionProjector(graph).projectEpisode(episode,new ExperienceAttributor().classify(episode));graph.close();ledger.close();
  writeFileSync(jsonl,facts().map(value=>JSON.stringify({...value,apiKey:'sk-super-secret',ownerText:'主人私聊',path:'C:\\Users\\Owner\\secret',position:{x:1,y:64,z:2}})).join('\n')+'\n','utf8');
}
function facts():ExecutionFactEnvelopeV1[]{return [fact('start',1,'execution.session.started',{goalText:'制作一把铁镐'}),fact('bound',2,'execution.plan.bound',{parentGoalText:'制作一把铁镐',policySnapshotId:'policy-iron@2',experienceMode:'production',bundleId:'bundle-1',selectionManifestId:'manifest-1',selectionManifest:{id:'manifest-1',selected:[{experienceId:'schema:iron',policyId:'policy-iron',type:'task_schema',score:.9,reasons:['exact'],evidenceRefs:['seed-evidence']}],rejected:[{experienceId:'candidate:shortcut',policyId:'candidate:shortcut',reason:'not_trusted'}]},planGraph:{id:'plan-1',goalId:'goal-1',nodes:[{id:'node-1',goal:{id:'goal-1',goalText:'制作铁镐',successCriteria:['done']},state:'ready',experienceRefs:['schema:iron']}],edges:[],budget:{maxNodes:8,maxGraphReplans:2},provenance:['bundle-1']}}),fact('terminal',3,'execution.session.terminal',{outcome:'succeeded',handoff:'none',verdict:{ok:true,detail:'done'}})];}
function fact(eventId:string,sequence:number,eventType:string,payload:Record<string,unknown>):ExecutionFactEnvelopeV1{return {schema:EXECUTION_FACT_SCHEMA_V1,eventId,eventType,sessionId:'session-1',runId:'run-1',planRunId:'plan-1',planRevision:1,nodeId:'node-1',sequence,occurredAt:`2026-08-02T00:00:0${sequence}.000Z`,codeRevision:'test',configRevision:'test',correlationId:'goal-1',payload};}
function readZip(buffer:Buffer):Map<string,Buffer>{const out=new Map<string,Buffer>();let offset=0;while(offset+4<=buffer.length&&buffer.readUInt32LE(offset)===0x04034b50){const size=buffer.readUInt32LE(offset+18),nameLength=buffer.readUInt16LE(offset+26),extra=buffer.readUInt16LE(offset+28),name=buffer.subarray(offset+30,offset+30+nameLength).toString('utf8'),start=offset+30+nameLength+extra;out.set(name,buffer.subarray(start,start+size));offset=start+size;}return out;}
function hash(value:Buffer):string{return createHash('sha256').update(value).digest('hex');}
