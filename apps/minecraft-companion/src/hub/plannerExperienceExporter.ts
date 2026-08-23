import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EvolutionGraphStore } from '../bot/v2/task/planner/evolution/evolutionGraphStore.js';
import { PlannerPolicyStore } from '../bot/v2/task/planner/evolution/policyStore.js';
import { PlannerLearningStore } from '../bot/v2/task/planner/evolution/learningStore.js';
import { EpisodeLedger, type PlannerLeafEpisode } from '../bot/v2/task/planner/evolution/episodeLedger.js';
import { createZip } from './zipArchive.js';

export type PlannerAuditScope =
  | { type:'full' }
  | { type:'policy'; id:string }
  | { type:'plan_run'; id:string }
  | { type:'episode'; id:string };

export interface PlannerAuditExportRequest { profileId:string;dbPath:string;jsonlPath:string;scope:PlannerAuditScope;includeRawFacts?:boolean; }
export interface PlannerAuditExportResult {fileName:string;contentType:'application/zip';buffer:Buffer;manifest:Record<string,unknown>;}

export class PlannerExperienceExporter {
  export(request:PlannerAuditExportRequest):PlannerAuditExportResult {
    validateRequest(request);
    const boundary=snapshotBoundary(request.dbPath,request.jsonlPath);
    const snapshotDir=mkdtempSync(join(tmpdir(),'mineclaw-planner-audit-'));
    const snapshotDb=join(snapshotDir,'snapshot.db');
    copyFileSync(request.dbPath,snapshotDb);
    if(existsSync(`${request.dbPath}-wal`))copyFileSync(`${request.dbPath}-wal`,`${snapshotDb}-wal`);
    const graph=new EvolutionGraphStore(snapshotDb),policies=new PlannerPolicyStore(snapshotDb),learning=new PlannerLearningStore(snapshotDb),ledger=new EpisodeLedger(snapshotDb);
    try{
      const allEpisodes=ledger.listEpisodes({limit:5000});
      const episodes=scopeEpisodes(allEpisodes,request.scope);
      const allPolicies=policies.list();
      const selectedPolicies=scopePolicies(allPolicies,request.scope,episodes);
      const graphSnapshot=scopeGraph(graph,request.scope,episodes,selectedPolicies.map(value=>value.id));
      const safe={
        policies:redact(selectedPolicies),
        policyAudit:redact(policies.listAudit().filter(value=>selectedPolicies.some(policy=>policy.id===value.policyId))),
        candidates:request.scope.type==='full'?redact(learning.listCandidates()):[],
        evaluations:request.scope.type==='full'?redact(learning.listEvaluations()):[],
        curves:request.scope.type==='full'?redact(learning.listCurvePoints()):[],
        planRuns:redact(planRunRecords(episodes)),
        episodes:redact(episodes.map(episode=>episodeRecord(episode,false))),
        graph:redact(graphSnapshot),
      };
      const entries=new Map<string,Buffer>();
      put(entries,'README.md',readme(request,safe,boundary));
      put(entries,'markdown/policies.md',policyMarkdown(safe.policies as unknown[]));
      put(entries,'markdown/experience.md',experienceMarkdown(safe.graph as {nodes:unknown[];edges:unknown[]}));
      put(entries,'markdown/plan-runs.md',planMarkdown(safe.planRuns as unknown[]));
      put(entries,'markdown/episodes.md',episodeMarkdown(safe.episodes as unknown[]));
      putJson(entries,'machine/policies.json',safe.policies);
      putJson(entries,'machine/policy-audit.json',safe.policyAudit);
      putJson(entries,'machine/candidates.json',safe.candidates);
      putJson(entries,'machine/evaluations.json',safe.evaluations);
      putJson(entries,'machine/curves.json',safe.curves);
      putJson(entries,'machine/plan-runs.json',safe.planRuns);
      putJson(entries,'machine/episodes.json',safe.episodes);
      putJson(entries,'machine/graph.json',safe.graph);
      if(request.includeRawFacts)put(entries,'machine/facts.jsonl',sanitizedFacts(request.jsonlPath,boundary.jsonlHighWatermark));
      const hashes=Object.fromEntries([...entries].map(([name,data])=>[name,sha256(data)]));
      const manifest={schemaVersion:'mineclaw.planner-audit/v1',derivedReadOnly:true,profileId:request.profileId,scope:request.scope,exportedAt:new Date().toISOString(),databaseRevision:boundary.databaseRevision,jsonlHighWatermark:boundary.jsonlHighWatermark,jsonlLastEventId:boundary.jsonlLastEventId,redactionVersion:'planner-audit-redaction/v1',includeRawFacts:request.includeRawFacts===true,counts:{policies:(safe.policies as unknown[]).length,planRuns:(safe.planRuns as unknown[]).length,episodes:(safe.episodes as unknown[]).length,graphNodes:(safe.graph as {nodes:unknown[]}).nodes.length,graphEdges:(safe.graph as {edges:unknown[]}).edges.length},files:hashes};
      putJson(entries,'manifest.json',manifest);
      return {fileName:`planner-experience-${safeFile(request.profileId)}-${request.scope.type}.zip`,contentType:'application/zip',buffer:createZip([...entries].map(([name,data])=>({name,data}))),manifest};
    }finally{ledger.close();learning.close();policies.close();graph.close();rmSync(snapshotDir,{recursive:true,force:true});}
  }
}

function scopeEpisodes(all:PlannerLeafEpisode[],scope:PlannerAuditScope):PlannerLeafEpisode[]{
  if(scope.type==='full')return all;
  if(scope.type==='policy')return all.filter(value=>{const bound=value.facts.find(fact=>fact.eventType==='execution.plan.bound');const snapshot=bound?.payload.policySnapshotId;const manifest=isRecord(bound?.payload.selectionManifest)?bound.payload.selectionManifest:null;return (typeof snapshot==='string'&&snapshot.split('@')[0]===scope.id)||(Array.isArray(manifest?.selected)&&manifest.selected.some(entry=>isRecord(entry)&&entry.policyId===scope.id));});
  if(scope.type==='plan_run')return all.filter(value=>value.planRunId===scope.id);
  return all.filter(value=>value.sessionId===scope.id);
}
function scopePolicies(all:ReturnType<PlannerPolicyStore['list']>,scope:PlannerAuditScope,episodes:PlannerLeafEpisode[]){
  if(scope.type==='full')return all;
  const ids=new Set<string>();
  if(scope.type==='policy')ids.add(scope.id);
  for(const episode of episodes){const bound=episode.facts.find(fact=>fact.eventType==='execution.plan.bound');const snapshot=bound?.payload.policySnapshotId;if(typeof snapshot==='string')ids.add(snapshot.split('@')[0]);const manifest=isRecord(bound?.payload.selectionManifest)?bound.payload.selectionManifest:null;for(const entry of Array.isArray(manifest?.selected)?manifest.selected:[])if(isRecord(entry)&&typeof entry.policyId==='string')ids.add(entry.policyId);}
  let changed=true;while(changed){changed=false;for(const policy of all)if(ids.has(policy.id)&&policy.evolvedFrom&&!ids.has(policy.evolvedFrom)){ids.add(policy.evolvedFrom);changed=true;}}
  return all.filter(value=>ids.has(value.id));
}
function scopeGraph(store:EvolutionGraphStore,scope:PlannerAuditScope,episodes:PlannerLeafEpisode[],policyIds:string[]){
  if(scope.type==='full')return {nodes:store.listNodes({limit:5001}),edges:store.listEdges({limit:10001})};
  const roots=[...episodes.map(value=>`episode:${value.sessionId}`),...episodes.map(value=>`plan:${value.planRunId}`),...policyIds.map(value=>`policy:${value}`)];
  const existing=roots.filter(id=>store.getNode(id));
  return existing.length?store.querySubgraph(existing,{depth:5,maxNodes:5000,maxEdges:10000}):{nodes:[],edges:[],truncated:false};
}
function episodeRecord(episode:PlannerLeafEpisode,raw:boolean){const hidden=episode.facts.some(fact=>fact.eventType==='execution.plan.bound'&&fact.payload.experimentSplit==='hidden');return {id:episode.sessionId,runId:episode.runId,planRunId:episode.planRunId,nodeId:episode.nodeId,state:episode.state,outcome:episode.outcome??null,hidden,firstSequence:episode.firstSequence,lastSequence:episode.maxSequence,eventCount:episode.facts.length,evidenceRefs:episode.facts.map(fact=>fact.eventId),...(raw&&!hidden?{facts:episode.facts}:{})};}
function planRunRecords(episodes:PlannerLeafEpisode[]){const ids=[...new Set(episodes.map(value=>value.planRunId))];return ids.map(id=>{const values=episodes.filter(value=>value.planRunId===id);const bound=values.flatMap(value=>value.facts).find(fact=>fact.eventType==='execution.plan.bound');return {id,parentGoalText:typeof bound?.payload.parentGoalText==='string'?bound.payload.parentGoalText:id,policySnapshotId:bound?.payload.policySnapshotId??null,bundleId:bound?.payload.bundleId??null,selectionManifestId:bound?.payload.selectionManifestId??null,selectionManifest:isRecord(bound?.payload.selectionManifest)?bound.payload.selectionManifest:null,nodeIds:[...new Set(values.map(value=>value.nodeId))],episodeIds:values.map(value=>value.sessionId),outcomes:values.map(value=>value.outcome??'unknown')};});}
function snapshotBoundary(dbPath:string,jsonlPath:string){const db=readFileSync(dbPath);let high=0,last:string|null=null;if(existsSync(jsonlPath)){const data=readFileSync(jsonlPath);high=data.length;for(const line of data.toString('utf8').split(/\r?\n/).filter(Boolean)){try{const value=JSON.parse(line) as Record<string,unknown>;if(typeof value.eventId==='string')last=value.eventId;}catch{}}}return {databaseRevision:`sha256:${sha256(db)}`,jsonlHighWatermark:high,jsonlLastEventId:last};}
function sanitizedFacts(path:string,high:number):Buffer {if(!existsSync(path)||high===0)return Buffer.alloc(0);const text=readFileSync(path).subarray(0,high).toString('utf8');const lines=text.split(/\r?\n/).filter(Boolean).flatMap(line=>{try{return [JSON.stringify(redact(JSON.parse(line)))];}catch{return [];}});return Buffer.from(lines.join('\n')+(lines.length?'\n':''));}
function redact<T>(value:T):T {return redactValue(value) as T;}
function redactValue(value:unknown):unknown {if(Array.isArray(value))return value.map(redactValue);if(isRecord(value)){const out:Record<string,unknown>={};for(const [key,child] of Object.entries(value)){if(/(api.?key|token|secret|password|authorization|ownerName|ownerText|rawMessage|absolutePosition|coordinates|position)$/i.test(key))continue;if(['x','y','z'].includes(key)&&typeof child==='number')continue;out[key]=redactValue(child);}return out;}if(typeof value==='string'){if(/[A-Za-z]:\\|\/Users\//i.test(value))return '[REDACTED_PATH]';if(/bearer\s+[a-z0-9._-]+|sk-[a-z0-9_-]{12,}/i.test(value))return '[REDACTED_SECRET]';}return value;}
function readme(request:PlannerAuditExportRequest,safe:Record<string,unknown>,boundary:ReturnType<typeof snapshotBoundary>):string{return `# Planner 经验审计包\n\n> 这是从运行时事实源派生的只读快照。编辑、移动或删除本 ZIP 不会改变 Agent；系统不支持导入。\n\n- Profile: \`${request.profileId}\`\n- Scope: \`${request.scope.type}${'id'in request.scope?` / ${request.scope.id}`:''}\`\n- SQLite revision: \`${boundary.databaseRevision}\`\n- JSONL watermark: \`${boundary.jsonlHighWatermark}\` bytes\n- 原始事实: ${request.includeRawFacts?'已按请求包含并脱敏':'默认关闭'}\n\n## 阅读导航\n\n1. \`markdown/policies.md\`：可信 Policy 与谱系。\n2. \`markdown/plan-runs.md\`：每轮计划、采用/舍弃经验。\n3. \`markdown/episodes.md\`：结果和证据 ID。\n4. \`markdown/experience.md\`：Schema、Fragment、Recovery 与关系。\n5. \`machine/\`：与阅读稿对应的 JSON/JSONL。\n\n对象数：Policy ${(safe.policies as unknown[]).length}，PlanRun ${(safe.planRuns as unknown[]).length}，Episode ${(safe.episodes as unknown[]).length}。\n`;}
function policyMarkdown(values:unknown[]):string{return `# Policies\n\n${values.map(value=>markdownObject(value,'Policy')).join('\n\n')||'无。'}\n`;}
function planMarkdown(values:unknown[]):string{return `# PlanRuns\n\n${values.map(value=>markdownObject(value,'PlanRun')).join('\n\n')||'无。'}\n`;}
function episodeMarkdown(values:unknown[]):string{return `# Episodes\n\n${values.map(value=>markdownObject(value,'Episode')).join('\n\n')||'无。'}\n`;}
function experienceMarkdown(graph:{nodes:unknown[];edges:unknown[]}):string{return `# Experience Graph\n\n## Nodes\n\n${graph.nodes.map(value=>markdownObject(value,'Node')).join('\n\n')||'无。'}\n\n## Relations\n\n${graph.edges.map(value=>`- \`${isRecord(value)?value.id:''}\` ${isRecord(value)?value.from:''} —${isRecord(value)?value.type:''}→ ${isRecord(value)?value.to:''}`).join('\n')||'无。'}\n`;}
function markdownObject(value:unknown,label:string):string {const item=isRecord(value)?value:{};const id=String(item.id??item.sessionId??'unknown');return `## ${label} · ${id}\n\n- ID: \`${id}\`\n- 状态: \`${String(item.state??item.outcome??'unknown')}\`\n- 来源/谱系: \`${String(item.evolvedFrom??item.policySnapshotId??'无')}\`\n\n\`\`\`json\n${JSON.stringify(item,null,2)}\n\`\`\``;}
function put(entries:Map<string,Buffer>,name:string,value:string|Buffer):void{entries.set(name,Buffer.isBuffer(value)?value:Buffer.from(value,'utf8'));}
function putJson(entries:Map<string,Buffer>,name:string,value:unknown):void{put(entries,name,`${JSON.stringify(value,null,2)}\n`);}
function sha256(value:Buffer):string{return createHash('sha256').update(value).digest('hex');}
function safeFile(value:string):string{return value.replace(/[^a-z0-9_-]+/gi,'-').replace(/^-|-$/g,'').slice(0,64)||'profile';}
function isRecord(value:unknown):value is Record<string,unknown>{return typeof value==='object'&&value!==null&&!Array.isArray(value);}
function validateRequest(request:PlannerAuditExportRequest):void {if(!request.profileId.trim())throw new Error('profileId is required');if(!existsSync(request.dbPath))throw new Error('planner evolution database not found');if(request.scope.type!=='full'&&!request.scope.id.trim())throw new Error('scope id is required');}
