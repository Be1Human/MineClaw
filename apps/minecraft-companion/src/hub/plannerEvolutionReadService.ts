import { existsSync } from 'node:fs';
import { resolveRuntimePersistencePaths } from '../bot/runtimePersistence.js';
import {
  EvolutionGraphStore,
  type EvolutionNodeType,
  type EvolutionSubgraph,
} from '../bot/v2/task/planner/evolution/evolutionGraphStore.js';
import { PlannerPolicyStore, type PlannerPolicyRecord } from '../bot/v2/task/planner/evolution/policyStore.js';
import { PlannerLearningStore } from '../bot/v2/task/planner/evolution/learningStore.js';
import { EpisodeLedger, type PlannerLeafEpisode } from '../bot/v2/task/planner/evolution/episodeLedger.js';
import { ExperienceAttributor } from '../bot/v2/task/planner/evolution/attributor.js';
import { EvolutionProjector } from '../bot/v2/task/planner/evolution/evolutionProjector.js';
import { declaredPlanNodeCount, latestPlanEpisodes } from '../bot/v2/task/planner/evolution/planEpisodeAggregation.js';
import { inferPlannerTaskFamily } from '../bot/v2/task/planner/evolution/goalCanonicalizer.js';

export interface PlannerEvolutionSummary {
  available: boolean;
  generatedAt: string;
  counts: {
    nodes: number;
    edges: number;
    evidence: number;
    knowledgeNodes: number;
    knowledgeEdges: number;
    runtimeEvidenceNodes: number;
    byType: Partial<Record<EvolutionNodeType, number>>;
  };
  activePolicy: null | {
    id: string;
    version: number;
    revision: number;
    confidenceLowerBound: number;
    updatedAt: string;
  };
}

export interface PlannerEvolutionGraphRequest {
  roots?: string[];
  types?: EvolutionNodeType[];
  states?: string[];
  search?: string;
  at?: string;
  depth?: number;
  maxNodes?: number;
  maxEdges?: number;
}

export interface PlannerEvolutionGraphSnapshot extends EvolutionSubgraph {
  available: boolean;
  generatedAt: string;
}

export interface PlannerEvolutionDashboard {
  available: boolean;
  generatedAt: string;
  runtimeGate: PlannerEvolutionRuntimeGateView;
  policies: ReturnType<PlannerPolicyStore['list']>;
  policyAudit: ReturnType<PlannerPolicyStore['listAudit']>;
  candidates: ReturnType<PlannerLearningStore['listCandidates']>;
  agenda: ReturnType<PlannerLearningStore['listAgenda']>;
  validationRuns: ReturnType<PlannerLearningStore['listValidationRuns']>;
  curves: ReturnType<PlannerLearningStore['listCurvePoints']>;
  experimentAllocations: ReturnType<PlannerLearningStore['listExperimentAllocations']>;
  experienceLineages: PlannerExperienceLineageView[];
  planRuns: PlannerPlanRunView[];
  episodes: Array<{
    id:string; runId:string; planRunId:string; nodeId:string; outcome?:string; hidden:boolean;
    attribution:ReturnType<ExperienceAttributor['classify']>;
    actionCount:number; startedAt?:string; endedAt?:string;
    timeline:Array<{sequence:number;eventId:string;eventType:string;occurredAt:string;payload:Record<string,unknown>}>;
  }>;
}

export interface PlannerEvolutionRuntimeGateView {
  evolutionMode: 'off' | 'observe' | 'active';
  experimentMode: 'off' | 'authorized';
  profileAuthorized: boolean;
  candidateTrialsEnabled: boolean;
  reason: 'authorized' | 'evolution_not_active' | 'experiment_not_authorized' | 'profile_not_allowlisted';
}

export interface PlannerExperienceLineageView {
  id: string;
  taskFamily: string;
  goalPattern: string;
  goalSignature: string | null;
  candidateId: string | null;
  candidateStatus: string | null;
  candidateGenerations: Array<{
    id:string; generation:number; contentHash:string; status:string; evolvedFromCandidateId:string|null;
    positiveEpisodeIds:string[]; negativeEpisodeIds:string[];
    validationStatus:string|null; validationAttempt:number|null; changes:string[];
  }>;
  currentPolicyId: string | null;
  maturity: 'observed' | 'accumulating' | 'candidate' | 'evaluating' | 'trusted';
  sourceEpisodeIds: string[];
  planRunIds: string[];
  validationRun: ReturnType<PlannerLearningStore['getValidationRun']>;
  versions: Array<{
    policy: ReturnType<PlannerPolicyStore['list']>[number];
    curves: ReturnType<PlannerLearningStore['listCurvePoints']>;
    audit: ReturnType<PlannerPolicyStore['listAudit']>;
    sourceEpisodeIds: string[];
    changes: string[];
  }>;
}

export interface PlannerPlanRunView {
  planRunId:string;
  parentGoalText:string;
  runIndex:number;
  outcome:'succeeded'|'failed'|'cancelled'|'incomplete';
  learningEligible:boolean;
  learningExclusionReason:string|null;
  policySnapshotId:string|null;
  experienceMode:string|null;
  goalSignature:string|null;
  contextSignatureHash:string|null;
  candidateId:string|null;
  experimentId:string|null;
  experimentSplit:string|null;
  experimentAuthorizationId:string|null;
  bundleId:string|null;
  contentHash:string|null;
  selectionManifestId:string|null;
  selectedExperience:Array<Record<string,unknown>>;
  rejectedExperience:Array<Record<string,unknown>>;
  episodeIds:string[];
  nodeCount:number;
  completedNodes:number;
  actionCount:number;
  executedActionCount:number;
  failedActionCount:number;
  noProgressActions:number;
  recoveryCount:number;
  replanCount:number;
  distanceMoved:number;
  inventoryDelta:Record<string,number>;
  llmRounds:number;
  durationMs:number;
  intervention:boolean;
  safetyViolations:number;
  masteryScore:number;
  improvementPct:number;
  isComparisonBaseline:boolean;
  startedAt?:string;
  endedAt?:string;
}

export class PlannerEvolutionReadService {
  constructor(private readonly dataDir: string) {}

  summary(botId: string): PlannerEvolutionSummary {
    const generatedAt = new Date().toISOString();
    const dbPath = this.databasePath(botId);
    if (!existsSync(dbPath)) return emptySummary(generatedAt);

    const graph = new EvolutionGraphStore(dbPath);
    const policies = new PlannerPolicyStore(dbPath);
    try {
      const nodes = graph.listNodes({ at: generatedAt, limit: 5001 });
      const edges = graph.listEdges({ at: generatedAt, limit: 10001 });
      const evidence = new Set<string>();
      const byType: Partial<Record<EvolutionNodeType, number>> = {};
      for (const node of nodes) {
        byType[node.type] = (byType[node.type] ?? 0) + 1;
        for (const id of node.evidenceIds) evidence.add(id);
      }
      for (const edge of edges) for (const id of edge.evidenceIds) evidence.add(id);
      const nodeTypeById = new Map(nodes.map(node => [node.id, node.type]));
      const knowledgeNodes = nodes.filter(node => isKnowledgeNodeType(node.type)).length;
      const knowledgeEdges = edges.filter(edge => isKnowledgeNodeType(nodeTypeById.get(edge.from))
        && isKnowledgeNodeType(nodeTypeById.get(edge.to))).length;
      const runtimeEvidenceNodes = nodes.length - knowledgeNodes;
      const active = policies.active();
      return {
        available: true,
        generatedAt,
        counts: {
          nodes: nodes.length,
          edges: edges.length,
          evidence: evidence.size,
          knowledgeNodes,
          knowledgeEdges,
          runtimeEvidenceNodes,
          byType,
        },
        activePolicy: active ? {
          id: active.id,
          version: active.version,
          revision: active.revision,
          confidenceLowerBound: active.confidenceLowerBound,
          updatedAt: active.updatedAt,
        } : null,
      };
    } finally {
      policies.close();
      graph.close();
    }
  }

  graph(botId: string, request: PlannerEvolutionGraphRequest = {}): PlannerEvolutionGraphSnapshot {
    const generatedAt = new Date().toISOString();
    const dbPath = this.databasePath(botId);
    if (!existsSync(dbPath)) return { available: false, generatedAt, nodes: [], edges: [], truncated: false };

    const store = new EvolutionGraphStore(dbPath);
    try {
      const maxNodes = clampInteger(request.maxNodes, 160, 1, 500);
      const maxEdges = clampInteger(request.maxEdges, 320, 1, 1000);
      const roots = unique(request.roots ?? []).slice(0, 24);
      if (roots.length > 0) {
        return {
          available: true,
          generatedAt,
          ...store.querySubgraph(roots, {
            at: request.at,
          depth: clampInteger(request.depth, 2, 0, 5),
          maxNodes,
          maxEdges,
          types: request.types,
        }),
        };
      }

      const listedNodes = store.listNodes({
        at: request.at,
        types: request.types,
        states: request.states,
        search: request.search,
        limit: maxNodes + 1,
      });
      const truncatedByNodes = listedNodes.length > maxNodes;
      const nodes = listedNodes.slice(0, maxNodes);
      const allowed = new Set(nodes.map(node => node.id));
      const listedEdges = store.listEdges({ at: request.at, limit: maxEdges + 1 });
      const relevantEdges = listedEdges.filter(edge => allowed.has(edge.from) && allowed.has(edge.to));
      return {
        available: true,
        generatedAt,
        nodes,
        edges: relevantEdges.slice(0, maxEdges),
        truncated: truncatedByNodes || relevantEdges.length > maxEdges,
      };
    } finally {
      store.close();
    }
  }

  dashboard(botId:string):PlannerEvolutionDashboard {
    const generatedAt=new Date().toISOString();
    const runtimeGate=plannerEvolutionRuntimeGate(botId);
    const dbPath=this.databasePath(botId);
    if(!existsSync(dbPath)) return {available:false,generatedAt,runtimeGate,policies:[],policyAudit:[],candidates:[],agenda:[],validationRuns:[],curves:[],experimentAllocations:[],experienceLineages:[],planRuns:[],episodes:[]};
    const policies=new PlannerPolicyStore(dbPath),learning=new PlannerLearningStore(dbPath),ledger=new EpisodeLedger(dbPath),attributor=new ExperienceAttributor();
    try {
      const allEpisodes=ledger.listEpisodes({limit:500});
      const finalizedEpisodes=ledger.listEpisodes({state:'finalized',limit:500});
      const episodes=finalizedEpisodes.map(episode=>{
        const hidden=isHiddenEpisode(episode);
        return {
          id:episode.sessionId,runId:episode.runId,planRunId:episode.planRunId,nodeId:episode.nodeId,...(episode.outcome?{outcome:episode.outcome}:{}),hidden,
          attribution:dashboardAttribution(episode,attributor,hidden),
          actionCount:episode.facts.filter(fact=>fact.eventType==='execution.action.proposed').length,
          ...(episode.facts[0]?{startedAt:episode.facts[0].occurredAt}:{}),
          ...(episode.terminalSequence?{endedAt:episode.facts.find(fact=>fact.sequence===episode.terminalSequence)?.occurredAt}:{}),
          timeline:episode.facts.map(fact=>({sequence:fact.sequence,eventId:hidden?'hidden':fact.eventId,eventType:fact.eventType,occurredAt:fact.occurredAt,payload:hidden?{redacted:true}:fact.payload})),
        };
      });
      // PlanRun 是运行态读模型：必须看到最新的未终态 revision。否则 r1 失败触发
      // graph replan、r2 尚在执行时，页面会把整个 PlanRun 误报为失败。
      // 学习、归因和 Episode 回放仍只消费 finalizedEpisodes。
      const policyValues=policies.list(),auditValues=policies.listAudit(),candidateValues=learning.listCandidates(),curveValues=learning.listCurvePoints(),planRuns=buildPlanRuns(allEpisodes,attributor);
      return {available:true,generatedAt,runtimeGate,policies:policyValues,policyAudit:auditValues,candidates:candidateValues,agenda:learning.listAgenda(),validationRuns:learning.listValidationRuns(),curves:curveValues,experimentAllocations:learning.listExperimentAllocations(),experienceLineages:buildExperienceLineages(candidateValues,policyValues,curveValues,auditValues,planRuns,episodes.map(value=>value.id),learning),planRuns,episodes};
    } finally {ledger.close();learning.close();policies.close();}
  }

  disablePolicy(botId:string,id:string,expectedRevision:number,reason:string) {
    return this.governPolicy(botId,store=>store.disable(id,expectedRevision,reason));
  }

  rollbackPolicy(botId:string,id:string,expectedRevision:number,reason:string) {
    return this.governPolicy(botId,store=>store.rollback(id,expectedRevision,reason));
  }

  private governPolicy(botId:string,action:(store:PlannerPolicyStore)=>PlannerPolicyRecord):PlannerPolicyRecord {
    const dbPath=this.databasePath(botId),store=new PlannerPolicyStore(dbPath),graph=new EvolutionGraphStore(dbPath);
    try{
      const changed=action(store),projector=new EvolutionProjector(graph),activeIds=new Set(store.listActive().map(value=>value.id));
      for(const policy of store.list().filter(value=>!activeIds.has(value.id)))projector.projectPolicy(policy);
      for(const policy of store.listActive())projector.projectPolicy(policy);
      return changed;
    }finally{graph.close();store.close();}
  }

  private databasePath(botId: string): string {
    return resolveRuntimePersistencePaths(this.dataDir, botId).plannerEvolutionDbPath;
  }
}

export function plannerEvolutionRuntimeGate(
  botId:string,
  env:Partial<Pick<NodeJS.ProcessEnv,'PLANNER_EVOLUTION_MODE'|'PLANNER_EXPERIMENT_MODE'|'PLANNER_EXPERIMENT_PROFILE_IDS'>>=process.env,
):PlannerEvolutionRuntimeGateView {
  const evolutionMode=env.PLANNER_EVOLUTION_MODE==='active'||env.PLANNER_EVOLUTION_MODE==='off'
    ?env.PLANNER_EVOLUTION_MODE:'observe';
  const experimentMode=env.PLANNER_EXPERIMENT_MODE==='authorized'?'authorized':'off';
  const allowlist=(env.PLANNER_EXPERIMENT_PROFILE_IDS??'').split(',').map(value=>value.trim()).filter(Boolean);
  const profileAuthorized=allowlist.length===0||allowlist.includes(botId);
  const reason:PlannerEvolutionRuntimeGateView['reason']=evolutionMode!=='active'?'evolution_not_active'
    :experimentMode!=='authorized'?'experiment_not_authorized'
      :!profileAuthorized?'profile_not_allowlisted':'authorized';
  return {evolutionMode,experimentMode,profileAuthorized,candidateTrialsEnabled:reason==='authorized',reason};
}

function buildPlanRuns(episodes:ReturnType<EpisodeLedger['listEpisodes']>,attributor:ExperienceAttributor):PlannerPlanRunView[] {
  const groups=new Map<string,typeof episodes>();
  for(const episode of episodes){
    const bound=episode.facts.find(fact=>fact.eventType==='execution.plan.bound');
    if(!bound)continue;
    const values=groups.get(episode.planRunId)??[];values.push(episode);groups.set(episode.planRunId,values);
  }
  const raw=[...groups.entries()].map(([planRunId,values])=>{
    const bound=values[0].facts.find(fact=>fact.eventType==='execution.plan.bound')!;
    const expected=declaredPlanNodeCount(values);
    const latest=latestPlanEpisodes(values);
    const starts=values.flatMap(value=>value.facts.filter(fact=>fact.eventType==='execution.session.started').map(fact=>Date.parse(fact.occurredAt))).filter(Number.isFinite);
    const ends=values.flatMap(value=>value.facts.filter(fact=>fact.eventType==='execution.session.terminal').map(fact=>Date.parse(fact.occurredAt))).filter(Number.isFinite);
    const attrs=values.map(value=>attributor.classify(value));
    const latestAttrs=latest.map(value=>attributor.classify(value));
    const latestFailureAttrs=latest.filter(value=>value.outcome==='failed').map(value=>attributor.classify(value));
    const latestSuccessAttrs=latest.filter(value=>value.outcome==='succeeded').map(value=>attributor.classify(value));
    const completedNodes=latest.filter(value=>value.outcome==='succeeded').length;
    const outcome:PlannerPlanRunView['outcome']=latest.some(value=>value.outcome==='cancelled')?'cancelled'
      :latest.some(value=>value.outcome==='failed')?'failed'
        :completedNodes>=expected?'succeeded':'incomplete';
    const learningEligible=(outcome==='succeeded'&&latestSuccessAttrs.some(item=>item.learnable))
      || (outcome==='failed' && latestFailureAttrs.some(item=>item.learnable));
    const nonLearnableCategories=unique(latestAttrs.filter(item=>!item.learnable).map(item=>item.category));
    const nonLearnableReasons=unique(latestAttrs.filter(item=>!item.learnable).map(item=>item.reason));
    const learningExclusionReason=learningEligible?null
      :outcome==='cancelled'?'owner_or_runtime_cancelled'
        :outcome==='incomplete'?'plan_run_not_terminal'
          :outcome==='succeeded'?nonLearnableReasons.join(',')||'successful_run_without_learnable_progress'
          :`non_planner_attribution:${nonLearnableCategories.join(',')||'confounded'}`;
    const llmRounds=values.reduce((sum,value)=>sum+episodeLlmRounds(value),0);
    return {
      planRunId,
      parentGoalText:typeof bound.payload.parentGoalText==='string'?bound.payload.parentGoalText:planRunId,
      runIndex:0,
      outcome,
      learningEligible,
      learningExclusionReason,
      policySnapshotId:typeof bound.payload.policySnapshotId==='string'?bound.payload.policySnapshotId:null,
      experienceMode:typeof bound.payload.experienceMode==='string'?bound.payload.experienceMode:null,
      goalSignature:typeof bound.payload.goalSignature==='string'?bound.payload.goalSignature:null,
      contextSignatureHash:typeof bound.payload.contextSignatureHash==='string'?bound.payload.contextSignatureHash:null,
      candidateId:typeof bound.payload.candidateId==='string'?bound.payload.candidateId:null,
      experimentId:typeof bound.payload.experimentId==='string'?bound.payload.experimentId:null,
      experimentSplit:typeof bound.payload.experimentSplit==='string'?bound.payload.experimentSplit:null,
      experimentAuthorizationId:typeof bound.payload.experimentAuthorizationId==='string'?bound.payload.experimentAuthorizationId:null,
      bundleId:typeof bound.payload.bundleId==='string'?bound.payload.bundleId:null,
      contentHash:typeof bound.payload.contentHash==='string'?bound.payload.contentHash:null,
      selectionManifestId:typeof bound.payload.selectionManifestId==='string'?bound.payload.selectionManifestId:null,
      selectedExperience:isRecord(bound.payload.selectionManifest)&&Array.isArray(bound.payload.selectionManifest.selected)?bound.payload.selectionManifest.selected.filter(isRecord):[],
      rejectedExperience:isRecord(bound.payload.selectionManifest)&&Array.isArray(bound.payload.selectionManifest.rejected)?bound.payload.selectionManifest.rejected.filter(isRecord):[],
      episodeIds:values.map(value=>value.sessionId),
      nodeCount:expected,
      completedNodes,
      actionCount:values.reduce((sum,value)=>sum+value.facts.filter(fact=>fact.eventType==='execution.action.proposed').length,0),
      executedActionCount:values.reduce((sum,value)=>sum+value.facts.filter(fact=>fact.eventType==='execution.action.completed').length,0),
      failedActionCount:values.reduce((sum,value)=>sum+value.facts.filter(fact=>fact.eventType==='execution.action.completed'&&fact.payload.ok===false).length,0),
      noProgressActions:values.reduce((sum,value)=>sum+value.facts.filter(fact=>fact.eventType==='execution.progress.observed'&&fact.payload.meaningful===false).length,0),
      recoveryCount:values.reduce((sum,value)=>sum+value.facts.filter(fact=>fact.eventType==='execution.recovery.decided').length,0),
      replanCount:Math.max(0,...values.map(value=>value.planRevision-1)),
      distanceMoved:round(values.reduce((sum,value)=>sum+value.facts.filter(fact=>fact.eventType==='execution.progress.observed').reduce((subtotal,fact)=>subtotal+finiteNumber(fact.payload.positionDelta),0),0),2),
      inventoryDelta:mergeInventoryDeltas(values),
      llmRounds,
      durationMs:starts.length&&ends.length?Math.max(0,Math.max(...ends)-Math.min(...starts)):0,
      intervention:attrs.some(item=>item.reason==='decision.need_owner'||item.failure?.ownerActionable),
      safetyViolations:attrs.filter(item=>item.category==='safety_violation').length,
      masteryScore:0,
      improvementPct:0,
      isComparisonBaseline:false,
      ...(starts.length?{startedAt:new Date(Math.min(...starts)).toISOString()}:{}),
      ...(ends.length?{endedAt:new Date(Math.max(...ends)).toISOString()}:{}),
    };
  }).sort((left,right)=>String(left.startedAt??'').localeCompare(String(right.startedAt??'')));
  const byGoal=new Map<string,PlannerPlanRunView[]>();
  for(const run of raw){const key=run.goalSignature??normalizeGoal(run.parentGoalText);const values=byGoal.get(key)??[];values.push(run);byGoal.set(key,values);}
  for(const values of byGoal.values()){
    // Cancelled/incomplete runs remain visible audit rows but are not a valid
    // efficiency baseline.  Anchor the trend at the first learnable terminal.
    values.forEach((run,index)=>{
      run.runIndex=index+1;
    });
    const baseline=values.find(run=>run.learningEligible);
    if(!baseline)continue;
    baseline.isComparisonBaseline=true;
    values.forEach(run=>{
      const actionRatio=efficiencyRatio(baseline.actionCount,run.actionCount);
      const durationRatio=efficiencyRatio(baseline.durationMs,run.durationMs);
      const llmRatio=efficiencyRatio(baseline.llmRounds,run.llmRounds);
      const completionRatio=run.nodeCount>0?Math.min(1,run.completedNodes/run.nodeCount):0;
      const completionScore=run.learningEligible?70*completionRatio:0;
      const successfulEfficiency=run.outcome==='succeeded'
        ? 10+8*actionRatio+5*durationRatio+3*llmRatio+(run.intervention?0:4)
        : 0;
      run.masteryScore=Math.max(0,Math.min(100,Math.round(
        completionScore+successfulEfficiency-run.safetyViolations*10,
      )));
      run.improvementPct=run.learningEligible?improvementFromBaseline(run,baseline):0;
    });
  }
  return raw;
}

function buildExperienceLineages(
  candidates:ReturnType<PlannerLearningStore['listCandidates']>,
  policies:ReturnType<PlannerPolicyStore['list']>,
  curves:ReturnType<PlannerLearningStore['listCurvePoints']>,
  audits:ReturnType<PlannerPolicyStore['listAudit']>,
  planRuns:PlannerPlanRunView[],
  knownEpisodeIds:string[],
  learning:PlannerLearningStore,
):PlannerExperienceLineageView[] {
  const knownEpisodes=new Set(knownEpisodeIds);
  const assigned=new Set<string>();
  const result:PlannerExperienceLineageView[]=[];
  const candidatesByLineage=new Map<string,typeof candidates>();
  for(const candidate of candidates){const key=candidate.lineageId??candidate.id;const values=candidatesByLineage.get(key)??[];values.push(candidate);candidatesByLineage.set(key,values);}
  for(const [lineageId,lineageCandidates] of candidatesByLineage){
    lineageCandidates.sort((left,right)=>(left.generation??1)-(right.generation??1)||left.id.localeCompare(right.id));
    const candidate=lineageCandidates.at(-1)!;
    const candidateIds=new Set(lineageCandidates.map(value=>value.id));
    const matched=policies.filter(policy=>(policy.sourceCandidateId?candidateIds.has(policy.sourceCandidateId):false)||lineageCandidates.some(value=>fallbackPolicyCandidateScore(policy,value)>0))
      .filter(policy=>{if(assigned.has(policy.id)&&!(policy.sourceCandidateId&&candidateIds.has(policy.sourceCandidateId)))return false;assigned.add(policy.id);return true;})
      .sort((left,right)=>left.version-right.version||left.createdAt.localeCompare(right.createdAt));
    result.push(lineageFrom(lineageId,candidate.taskFamily,candidate.goalPattern,candidateGoalSignature(candidate),lineageCandidates,matched,curves,audits,planRuns,knownEpisodes,learning));
  }
  for(const policy of policies.filter(value=>!assigned.has(value.id))){
    result.push(lineageFrom(`lineage:${policy.id}`,policy.taskFamily??policyTaskFamily(policy),policy.goalPattern??`未标注经验 · ${policy.id}`,policy.goalSignature??policyGoalSignature(policy),[],[policy],curves,audits,planRuns,knownEpisodes,learning));
  }
  for(const run of planRuns){
    const exists=result.some(lineage=>(run.goalSignature&&lineage.goalSignature===run.goalSignature)
      ||normalizeGoal(lineage.goalPattern)===normalizeGoal(run.parentGoalText));
    if(exists)continue;
    result.push(lineageFrom(
      `lineage:observed:${slug(run.goalSignature??run.parentGoalText)}`,
      inferPlannerTaskFamily(run.parentGoalText),run.parentGoalText,run.goalSignature,
      [],[],curves,audits,planRuns,knownEpisodes,learning,
    ));
  }
  return result.sort((left,right)=>{
    const leftActive=left.currentPolicyId?1:0,rightActive=right.currentPolicyId?1:0;
    return rightActive-leftActive||left.goalPattern.localeCompare(right.goalPattern,'zh-CN');
  });
}

function lineageFrom(
  id:string,taskFamily:string,goalPattern:string,goalSignature:string|null,candidates:ReturnType<PlannerLearningStore['listCandidates']>,
  policies:ReturnType<PlannerPolicyStore['list']>,curves:ReturnType<PlannerLearningStore['listCurvePoints']>,audits:ReturnType<PlannerPolicyStore['listAudit']>,
  planRuns:PlannerPlanRunView[],knownEpisodes:Set<string>,learning:PlannerLearningStore,
):PlannerExperienceLineageView {
  const candidate=candidates.at(-1)??null;
  const candidateId=candidate?.id??null;
  const candidateStatus=candidate?.status??null;
  const candidateIds=new Set(candidates.map(value=>value.id));
  const policyIds=new Set(policies.map(value=>value.id));
  const runs=planRuns.filter(run=>(run.candidateId?candidateIds.has(run.candidateId):false)
    ||(run.policySnapshotId?policyIds.has(run.policySnapshotId.split('@')[0]):false)
    ||(goalSignature&&run.goalSignature===goalSignature)
    ||normalizeGoal(run.parentGoalText)===normalizeGoal(goalPattern));
  const sourceEpisodeIds=uniqueStrings([
    ...candidates.flatMap(value=>value.positiveEpisodeIds),
    ...candidates.flatMap(value=>value.negativeEpisodeIds),
    ...policies.flatMap(policy=>policy.evidenceIds),
    ...curves.filter(point=>policyIds.has(point.policyId)).flatMap(point=>point.episodeIds),
  ]).filter(value=>knownEpisodes.has(value));
  const validationRun=candidateId?learning.getValidationRun(candidateId):null;
  const currentPolicyId=policies.find(value=>value.state==='trusted')?.id??null;
  const maturity:PlannerExperienceLineageView['maturity']=currentPolicyId?'trusted'
    :validationRun?.status==='evaluating'?'evaluating'
      :candidateId?'candidate'
        :runs.some(run=>run.learningEligible)?'accumulating':'observed';
  return {
    id,taskFamily,goalPattern,goalSignature,candidateId,candidateStatus,
    candidateGenerations:candidates.map((value,index)=>{
      const candidateValidation=learning.getValidationRun(value.id);
      return {
        id:value.id,generation:value.generation??1,contentHash:value.contentHash??'',status:value.status,
        evolvedFromCandidateId:value.evolvedFromCandidateId??null,
        positiveEpisodeIds:[...value.positiveEpisodeIds],negativeEpisodeIds:[...value.negativeEpisodeIds],
        validationStatus:candidateValidation?.status??null,validationAttempt:candidateValidation?.attempt??null,
        changes:candidateChanges(index>0?candidates[index-1]:null,value),
      };
    }),
    currentPolicyId,maturity,
    sourceEpisodeIds,planRunIds:runs.map(value=>value.planRunId),
    validationRun,
    versions:policies.map((policy,index)=>{
      const previous=index>0?policies[index-1]:null;
      const policyCurves=curves.filter(point=>point.policyId===policy.id);
      return {policy,curves:policyCurves,audit:audits.filter(value=>value.policyId===policy.id),sourceEpisodeIds:uniqueStrings([...policy.evidenceIds,...policyCurves.flatMap(point=>point.episodeIds)]).filter(value=>knownEpisodes.has(value)),changes:policyChanges(previous,policy)};
    }),
  };
}

function fallbackPolicyCandidateScore(policy:ReturnType<PlannerPolicyStore['list']>[number],candidate:ReturnType<PlannerLearningStore['listCandidates']>[number]):number {
  if(policy.taskFamily&&policy.taskFamily!==candidate.taskFamily)return 0;
  const overlap=policy.evidenceIds.filter(value=>candidate.evidenceIds.includes(value)).length;
  if(overlap>0)return 10+overlap;
  const policyGoal=policy.goalPattern??policy.content.applicability.filter(isRecord).map(value=>String(value.goalContains??'')).find(Boolean)??'';
  return policyGoal&&normalizeGoal(policyGoal)===normalizeGoal(candidate.goalPattern)?1:0;
}
function candidateGoalSignature(candidate:ReturnType<PlannerLearningStore['listCandidates']>[number]):string|null{return candidate.content.applicability.filter(isRecord).map(value=>value.goalSignature).find((value):value is string=>typeof value==='string')??null;}
function policyGoalSignature(policy:ReturnType<PlannerPolicyStore['list']>[number]):string|null{return policy.content.applicability.filter(isRecord).map(value=>value.goalSignature).find((value):value is string=>typeof value==='string')??null;}
function policyTaskFamily(policy:ReturnType<PlannerPolicyStore['list']>[number]):string{return policy.content.applicability.filter(isRecord).map(value=>value.taskFamily).find((value):value is string=>typeof value==='string')??'general';}
function policyChanges(previous:ReturnType<PlannerPolicyStore['list']>[number]|null,current:ReturnType<PlannerPolicyStore['list']>[number]):string[]{
  if(!previous)return['初始候选版本'];
  const labels:Array<[keyof typeof current.content,string]>=[['taskSchemas','任务结构'],['planFragments','计划片段'],['planRecoveryPatterns','恢复模式'],['metaPolicies','元策略']];
  const changes=labels.flatMap(([key,label])=>{
    if(stable(previous.content[key])===stable(current.content[key]))return[];
    return previous.content[key].length===current.content[key].length
      ?[`${label}内容已调整`]
      :[`${label} ${previous.content[key].length} → ${current.content[key].length}`];
  });
  changes.push(...stageChanges(previous.content.taskSchemas,current.content.taskSchemas));
  if(previous.confidenceLowerBound!==current.confidenceLowerBound)changes.push(`可信下界 ${Math.round(previous.confidenceLowerBound*100)}% → ${Math.round(current.confidenceLowerBound*100)}%`);
  return changes.length?changes:['结构未变，补充了新的真实评测证据'];
}
function candidateChanges(
  previous:ReturnType<PlannerLearningStore['listCandidates']>[number]|null,
  current:ReturnType<PlannerLearningStore['listCandidates']>[number],
):string[]{
  if(!previous)return['初始候选代'];
  const labels:Array<[keyof typeof current.content,string]>=[['taskSchemas','任务结构'],['planFragments','计划片段'],['planRecoveryPatterns','恢复模式'],['metaPolicies','元策略']];
  const changes=labels.flatMap(([key,label])=>{
    if(stable(previous.content[key])===stable(current.content[key]))return[];
    return previous.content[key].length===current.content[key].length
      ?[`${label}内容已调整`]
      :[`${label} ${previous.content[key].length} → ${current.content[key].length}`];
  });
  changes.push(...stageChanges(previous.content.taskSchemas,current.content.taskSchemas));
  return changes.length?changes:['结构未变，仅补充证据'];
}
function uniqueStrings(values:string[]):string[]{return [...new Set(values.filter(Boolean))];}
function isHiddenEpisode(episode:PlannerLeafEpisode):boolean{return episode.facts.some(fact=>fact.eventType==='execution.plan.bound'&&fact.payload.experimentSplit==='hidden');}
function dashboardAttribution(episode:PlannerLeafEpisode,attributor:ExperienceAttributor,hidden:boolean):ReturnType<ExperienceAttributor['classify']>{
  const attribution=attributor.classify(episode);
  if(!hidden)return attribution;
  const {failure:_failure,...safe}=attribution;
  return {...safe,reason:'hidden_evaluation_redacted',evidenceIds:[]};
}

function episodeLlmRounds(episode:ReturnType<EpisodeLedger['listEpisodes']>[number]):number {
  const reported=episode.facts.filter(fact=>fact.eventType==='execution.progress.observed')
    .map(fact=>isRecord(fact.payload.progress)?Number(fact.payload.progress.llmRounds??0):0)
    .filter(Number.isFinite).reduce((max,value)=>Math.max(max,value),0);
  if(reported>0)return reported;
  return episode.facts.filter(fact=>fact.eventType==='execution.action.proposed'
    &&isRecord(fact.payload.proposal)
    &&fact.payload.proposal.source==='slow_llm').length;
}

function efficiencyRatio(baseline:number,current:number):number {
  if(baseline<=0&&current<=0)return 1;
  if(current<=0)return 1;
  return Math.max(0,Math.min(1,baseline/current));
}

function mergeInventoryDeltas(episodes:ReturnType<EpisodeLedger['listEpisodes']>):Record<string,number>{
  const totals:Record<string,number>={};for(const episode of episodes)for(const fact of episode.facts.filter(value=>value.eventType==='execution.progress.observed')){
    const delta=isRecord(fact.payload.inventoryDelta)?fact.payload.inventoryDelta:isRecord(fact.payload.progress)&&isRecord(fact.payload.progress.inventoryDelta)?fact.payload.progress.inventoryDelta:{};
    for(const [item,value] of Object.entries(delta))if(typeof value==='number'&&Number.isFinite(value))totals[item]=(totals[item]??0)+value;
  }return Object.fromEntries(Object.entries(totals).filter(([,value])=>value!==0).sort(([left],[right])=>left.localeCompare(right)));
}
function finiteNumber(value:unknown):number{return typeof value==='number'&&Number.isFinite(value)?value:0;}
function round(value:number,digits:number):number{const scale=10**digits;return Math.round(value*scale)/scale;}

function normalizedCost(run:PlannerPlanRunView,baseline:PlannerPlanRunView):number {
  const ratio=(value:number,base:number)=>base>0?value/base:(value>0?1:0);
  return ratio(run.actionCount,baseline.actionCount)*0.4+ratio(run.durationMs,baseline.durationMs)*0.4+ratio(run.llmRounds,baseline.llmRounds)*0.2;
}

function improvementFromBaseline(run:PlannerPlanRunView,baseline:PlannerPlanRunView):number {
  if(run.planRunId===baseline.planRunId)return 0;
  if(baseline.outcome!=='succeeded'){
    if(run.outcome==='succeeded')return 100;
    const remaining=Math.max(1,100-baseline.masteryScore);
    return Math.round(((run.masteryScore-baseline.masteryScore)/remaining)*1000)/10;
  }
  if(run.outcome!=='succeeded')return -100;
  const baselineCost=normalizedCost(baseline,baseline);
  const currentCost=normalizedCost(run,baseline);
  return baselineCost<=0?0:Math.round(((baselineCost-currentCost)/baselineCost)*1000)/10;
}

function normalizeGoal(value:string):string{return value.toLowerCase().replace(/[\s，。！？、；：,.!?;:]+/g,'').trim();}
function isRecord(value:unknown):value is Record<string,unknown>{return !!value&&typeof value==='object'&&!Array.isArray(value);}
function stable(value:unknown):string{if(Array.isArray(value))return`[${value.map(stable).join(',')}]`;if(isRecord(value))return`{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;return JSON.stringify(value);}
function stageChanges(before:unknown[],after:unknown[]):string[]{
  const stages=(values:unknown[])=>values.filter(isRecord).flatMap(value=>Array.isArray(value.stages)?value.stages:[]).map(value=>isRecord(value)?String(value.stage??value.id??''):String(value)).filter(Boolean);
  const left=stages(before),right=stages(after);if(stable(left)===stable(right))return[];
  const added=right.filter(value=>!left.includes(value)),removed=left.filter(value=>!right.includes(value));const result:string[]=[];
  if(added.length)result.push(`新增阶段：${added.join('、')}`);if(removed.length)result.push(`删除阶段：${removed.join('、')}`);
  if(!added.length&&!removed.length)result.push('阶段顺序已调整');return result;
}
function slug(value:string):string{return normalizeGoal(value).replace(/[^a-z0-9\u4e00-\u9fff]+/g,'-').replace(/^-|-$/g,'').slice(0,80)||'unknown';}

function emptySummary(generatedAt: string): PlannerEvolutionSummary {
  return {
    available: false,
    generatedAt,
    counts: { nodes: 0, edges: 0, evidence: 0, knowledgeNodes: 0, knowledgeEdges: 0, runtimeEvidenceNodes: 0, byType: {} },
    activePolicy: null,
  };
}

const KNOWLEDGE_NODE_TYPES = new Set<EvolutionNodeType>([
  'goal_pattern', 'task_schema', 'plan_fragment', 'plan_recovery_pattern',
  'meta_policy', 'failure_pattern', 'policy', 'candidate', 'context', 'selection_manifest',
  'experience_rejection',
]);
function isKnowledgeNodeType(value: EvolutionNodeType | undefined): boolean {
  return value != null && KNOWLEDGE_NODE_TYPES.has(value);
}

function unique(values: string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))];
}

function clampInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  const candidate = Number.isInteger(value) ? Number(value) : fallback;
  return Math.min(max, Math.max(min, candidate));
}
