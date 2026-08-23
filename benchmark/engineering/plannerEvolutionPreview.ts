import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHubServer } from '../../apps/minecraft-companion/src/hub/server.js';
import { resolveRuntimePersistencePaths } from '../../apps/minecraft-companion/src/bot/runtimePersistence.js';
import { EvolutionGraphStore } from '../../apps/minecraft-companion/src/bot/v2/task/planner/evolution/evolutionGraphStore.js';
import { PlannerPolicyStore } from '../../apps/minecraft-companion/src/bot/v2/task/planner/evolution/policyStore.js';
import { PlannerLearningStore } from '../../apps/minecraft-companion/src/bot/v2/task/planner/evolution/learningStore.js';
import { EpisodeLedger } from '../../apps/minecraft-companion/src/bot/v2/task/planner/evolution/episodeLedger.js';
import { EXECUTION_FACT_SCHEMA_V1, type ExecutionFactEnvelopeV1 } from '../../apps/minecraft-companion/src/bot/v2/task/planner/evolution/contracts/executionFactsV1.js';

const staticDir = resolve('web/dist');
if (!existsSync(join(staticDir, 'index.html'))) {
  throw new Error('web/dist 不存在；请先执行 cd web && npm run build');
}

const port = Number(process.env.PLANNER_EVOLUTION_PREVIEW_PORT ?? 3002);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('preview port is invalid');

const dataDir = mkdtempSync(join(tmpdir(), 'mineclaw-evolution-preview-'));
process.env.SERVE_STATIC = staticDir;
const hub = createHubServer({ port, host: '127.0.0.1', dataDir });
await hub.listen();

const profile = hub.profileStore.create({
  name: '图谱验收伙伴',
  personality: { description: 'planner evolution preview fixture', style: 'calm' },
  server: { host: '127.0.0.1', port: 25565, auth: 'offline' },
});
seedFixture(resolveRuntimePersistencePaths(dataDir, profile.id).plannerEvolutionDbPath);

console.log(`\n  🧬 Planner Evolution Preview`);
console.log(`  🔗 http://127.0.0.1:${port}`);
console.log(`  👤 ${profile.name} · ${profile.id}`);
console.log('  页面中点击“进化”即可查看 fixture 图谱。\n');

let closing = false;
const close = (): void => {
  if (closing) return;
  closing = true;
  hub.httpServer.close(() => {
    rmSync(dataDir, { recursive: true, force: true });
    process.exit(0);
  });
};
process.once('SIGINT', close);
process.once('SIGTERM', close);

function seedFixture(dbPath: string): void {
  const graph = new EvolutionGraphStore(dbPath);
  const policies = new PlannerPolicyStore(dbPath);
  const learning = new PlannerLearningStore(dbPath);
  const ledger = new EpisodeLedger(dbPath);
  try {
    const validFrom = '2026-01-01T00:00:00.000Z';
    graph.upsertNode({
      id: 'goal:rail', type: 'goal_pattern', label: '制造铁轨', summary: '从原始材料完成铁轨制造',
      evidenceIds: ['episode-rail-1'], data: { taskFamily: 'crafting' }, validFrom,
    });
    graph.upsertNode({
      id: 'schema:craft', type: 'task_schema', label: '制造任务结构', summary: '调查配方后按依赖准备设施与材料',
      evidenceIds: ['episode-rail-1'], data: { reusable: true }, validFrom,
    });
    graph.upsertNode({
      id: 'fragment:smelt', type: 'plan_fragment', label: '先熔炼铁锭', summary: '确认燃料与熔炉后批量熔炼',
      evidenceIds: ['episode-rail-1'], data: { stepCount: 3 }, validFrom,
    });
    graph.upsertNode({
      id: 'failure:fuel', type: 'failure_pattern', label: '燃料准备不足', summary: '开始熔炼前没有检查燃料库存',
      evidenceIds: ['episode-rail-0'], data: { attribution: 'planning_error' }, validFrom,
    });
    graph.upsertNode({
      id: 'policy:rail-v1', type: 'policy', label: '制造规划 V1', summary: '先调查设施和燃料，再批量准备材料',
      state: 'trusted', evidenceIds: ['evaluation-rail-1'], data: { confidenceLowerBound: 0.82 }, validFrom,
    });
    for (const edge of [
      { id: 'edge:goal-schema', from: 'goal:rail', to: 'schema:craft', type: 'decomposes_to', evidenceIds: ['episode-rail-1'] },
      { id: 'edge:schema-smelt', from: 'schema:craft', to: 'fragment:smelt', type: 'contains', evidenceIds: ['episode-rail-1'] },
      { id: 'edge:failure-smelt', from: 'failure:fuel', to: 'fragment:smelt', type: 'refutes', evidenceIds: ['episode-rail-0'] },
      { id: 'edge:policy-schema', from: 'policy:rail-v1', to: 'schema:craft', type: 'contains', evidenceIds: ['evaluation-rail-1'] },
    ]) {
      graph.upsertEdge({ ...edge, confidenceLowerBound: 0.82, validFrom });
    }
    const candidate = policies.createCandidate({
      id: 'policy-rail-v1', version: 1,
      content: { taskSchemas: [], planFragments: [], planRecoveryPatterns: [], metaPolicies: [], applicability: [] },
      evidenceIds: ['episode-rail-1', 'evaluation-rail-1'], confidenceLowerBound: 0.82,
    });
    const v1=policies.promote(candidate.id, candidate.revision, {
      decision: 'promote', selectionDelta: 0.12, hiddenRegression: false,
      safetyViolations: 0, evaluationId: 'evaluation-rail-1',
    });
    const candidateV2=policies.createCandidate({id:'policy-rail-v2',version:2,evolvedFrom:v1.id,content:{taskSchemas:[{stages:['inspect_recipe','prepare_facilities','prepare_materials','craft','verify_inventory']}],planFragments:[{action:'gather'},{action:'smelt'},{action:'craft'}],planRecoveryPatterns:[{id:'recover:fuel'}],metaPolicies:[{rule:'inspect-first'}],applicability:[{taskFamily:'crafting'}]},evidenceIds:['episode-rail-2','evaluation-rail-2'],confidenceLowerBound:.9});
    policies.promote(candidateV2.id,candidateV2.revision,{decision:'promote',selectionDelta:.18,hiddenRegression:false,safetyViolations:0,evaluationId:'evaluation-rail-2'});
    policies.createCandidate({id:'policy-rail-v3',version:3,evolvedFrom:'policy-rail-v2',content:candidateV2.content,evidenceIds:['episode-rail-3'],confidenceLowerBound:.72});

    const metrics=(successRate:number,actions:number)=>({successRate,medianDurationMs:48_000,medianActions:actions,medianLlmRounds:3,interventionRate:0,safetyViolations:0,samples:5});
    for(const [policyId,version,selection,hidden] of [['policy-rail-v1',1,.64,.62],['policy-rail-v2',2,.82,.78]] as const){
      learning.addCurvePoint({policyId,policyVersion:version,split:'train',metrics:metrics(Math.min(1,selection+.05),8-version),episodeIds:[`episode-rail-${version}`],valid:true});
      learning.addCurvePoint({policyId,policyVersion:version,split:'selection',metrics:metrics(selection,8-version),episodeIds:[`episode-rail-${version}`],valid:true});
      learning.addCurvePoint({policyId,policyVersion:version,split:'hidden',metrics:metrics(hidden,9-version),episodeIds:[`episode-rail-${version}`],valid:true});
    }
    const experienceCandidate={id:'candidate:rail-fuel',taskFamily:'crafting',goalPattern:'制造铁轨时先检查燃料',content:{taskSchemas:[],planFragments:[{action:'inspect_fuel'}],planRecoveryPatterns:[{id:'recover:fuel'}],metaPolicies:[],applicability:[{taskFamily:'crafting'}]},evidenceIds:['episode-rail-0','episode-rail-2'],positiveEpisodeIds:['episode-rail-2'],negativeEpisodeIds:['episode-rail-0'],confidenceLowerBound:.72,status:'candidate' as const,validationSpec:{id:'validation:rail-fuel',validatorId:'inventory-goal-verifier',primaryMetric:'success_rate' as const,minimumSelectionSamples:2,minimumHiddenSamples:1,pairing:'snapshot_pair' as const,treatmentField:'planner_policy'}};
    learning.upsertCandidate(experienceCandidate);
    learning.upsertAgenda({candidateId:experienceCandidate.id,status:'queued',expectedInformationGain:.61,uncertainty:.28,impactScope:4,estimatedCost:2,safetyRisk:0,headroom:.28,retryBudget:2,validationSpec:experienceCandidate.validationSpec});
    seedEpisode(ledger,'episode-rail-0','failed');seedEpisode(ledger,'episode-rail-2','succeeded');
  } finally {
    ledger.close();
    learning.close();
    policies.close();
    graph.close();
  }
}

function seedEpisode(ledger:EpisodeLedger,sessionId:string,outcome:'succeeded'|'failed'):void{
  ledger.appendFact(fact(sessionId,1,'execution.session.started',{goalText:'制造铁轨'}));
  ledger.appendFact(fact(sessionId,2,'execution.action.proposed',{proposal:{action:'craft',args:{item:'rail'}}}));
  ledger.appendFact(fact(sessionId,3,'execution.action.completed',{ok:outcome==='succeeded',durationMs:1200}));
  ledger.appendFact(fact(sessionId,4,'execution.session.terminal',{outcome,handoff:outcome==='failed'?'graph_replan_required':'none',verdict:{ok:outcome==='succeeded',detail:outcome},...(outcome==='failed'?{failure:{code:'resource.fuel_missing',origin:'decision',stage:'deciding',category:'resource',retryable:true,ownerActionable:false,evidenceRefs:[`${sessionId}-3`]}}:{})}));
}
function fact(sessionId:string,sequence:number,eventType:string,payload:Record<string,unknown>):ExecutionFactEnvelopeV1{return{schema:EXECUTION_FACT_SCHEMA_V1,eventId:`${sessionId}-${sequence}`,eventType,sessionId,runId:`run-${sessionId}`,planRunId:`plan-${sessionId}`,planRevision:1,nodeId:`node-${sessionId}`,sequence,occurredAt:new Date(Date.UTC(2026,7,2,8,sequence)).toISOString(),codeRevision:'preview',configRevision:'preview',correlationId:`corr-${sessionId}`,payload};}
