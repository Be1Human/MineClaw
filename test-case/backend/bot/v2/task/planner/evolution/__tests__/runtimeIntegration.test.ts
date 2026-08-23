import { afterEach,test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,readFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { ExecutionFactLog } from '../../../../../../../../apps/minecraft-companion/src/bot/v2/task/execution/executionFactLog.js';
import { PlannerEvolutionRuntime } from '../../../../../../../../apps/minecraft-companion/src/bot/v2/task/planner/evolution/plannerEvolutionRuntime.js';

const dirs:string[]=[];afterEach(()=>{for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});

test('FEAT-CROSS-14 | 持久执行事实日志重启后按 cursor 自动投影，经验运行时只读消费',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'planner-runtime-integration-'));dirs.push(dir);const factsPath=join(dir,'facts.jsonl'),dbPath=join(dir,'evolution.db');
  const log=new ExecutionFactLog({filePath:factsPath,codeRevision:'test',configRevision:'test'});const context={sessionId:'s1',runId:'r1',planRunId:'p1',planRevision:1,nodeId:'n1',correlationId:'c1'};
  log.append(context,'execution.session.started',{goalText:'制造铁轨'});log.append(context,'execution.action.proposed',{proposal:{action:'craft',args:{item:'rail'}}});log.append(context,'execution.session.terminal',{outcome:'succeeded',handoff:'none',verdict:{ok:true,detail:'rail in inventory'}});
  const first=new PlannerEvolutionRuntime({dbPath,executionFactsPath:factsPath,pollMs:10_000});const summary=await first.start();assert.equal(summary.finalized,1);assert.equal(first.learning.listCandidates().length,1);assert.equal(first.graph.listNodes({types:['episode']}).length,1);first.stop();
  const reopened=new PlannerEvolutionRuntime({dbPath,executionFactsPath:factsPath,pollMs:10_000});const replay=await reopened.start();assert.equal(replay.ingested,0);assert.equal(reopened.ledger.getCursor('planner-evolution-v1'),'3');reopened.stop();
});

test('FEAT-CROSS-14 | 经验核心无执行控制依赖或 execution.command 出站主题',()=>{
  const root=resolve('src/bot/v2/task/planner/evolution');const files=['attributor.ts','episodeLedger.ts','evolutionGraphStore.ts','executionFactIngestor.ts','plannerOptimizer.ts','plannerEvolutionEngine.ts','researchAgenda.ts'];
  const source=files.map(file=>readFileSync(join(root,file),'utf8')).join('\n');
  assert.doesNotMatch(source,/task\/execution|goalExecutionCoordinator|ActionPreparer|RecoveryRouter|execution\.command|PreparedAction/);
});

test('FEAT-CROSS-14-007-003-003 | 仅安全 blacklist 发出 Policy 失效，promote/disable 不热切当前快照',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'planner-policy-invalidation-'));dirs.push(dir);const factsPath=join(dir,'facts.jsonl'),dbPath=join(dir,'evolution.db');
  const log=new ExecutionFactLog({filePath:factsPath,codeRevision:'test',configRevision:'test'});void log;
  const runtime=new PlannerEvolutionRuntime({dbPath,executionFactsPath:factsPath,pollMs:10_000});const events:Array<{policyId:string;reason:string}>=[];runtime.onPolicyInvalidated(event=>events.push({policyId:event.policyId,reason:event.reason}));
  const content={taskSchemas:[],planFragments:[],planRecoveryPatterns:[],metaPolicies:[],applicability:[]};
  const disabled=runtime.policies.createCandidate({id:'policy-disable',version:1,content,evidenceIds:['episode:1'],confidenceLowerBound:.8});runtime.policies.promote(disabled.id,disabled.revision,{decision:'promote',selectionDelta:.1,hiddenRegression:false,safetyViolations:0,evaluationId:'eval-promote'});await runtime.sync();assert.deepEqual(events,[]);const trustedDisabled=runtime.policies.get(disabled.id)!;runtime.policies.disable(disabled.id,trustedDisabled.revision,'operator disabled');await runtime.sync();assert.deepEqual(events,[]);
  const unsafe=runtime.policies.createCandidate({id:'policy-unsafe',version:2,content,evidenceIds:['episode:2'],confidenceLowerBound:.8});runtime.policies.promote(unsafe.id,unsafe.revision,{decision:'promote',selectionDelta:.1,hiddenRegression:false,safetyViolations:0,evaluationId:'eval-unsafe'});await runtime.sync();const trustedUnsafe=runtime.policies.get(unsafe.id)!;runtime.policies.blacklist(unsafe.id,trustedUnsafe.revision,'hidden safety regression');await runtime.sync();assert.deepEqual(events,[{policyId:'policy-unsafe',reason:'hidden safety regression'}]);await runtime.sync();assert.equal(events.length,1);runtime.stop();
});
