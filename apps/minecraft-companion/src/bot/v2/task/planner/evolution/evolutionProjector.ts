import type { PlannerLeafEpisode } from './episodeLedger.js';
import type { EpisodeAttribution } from './attributor.js';
import type { ExperienceCandidate } from './plannerOptimizer.js';
import { EvolutionGraphStore } from './evolutionGraphStore.js';
import type { PlannerPolicyRecord } from './policyStore.js';

export class EvolutionProjector {
  constructor(private readonly graph: EvolutionGraphStore) {}

  projectEpisode(episode: PlannerLeafEpisode, attribution: EpisodeAttribution): void {
    const bound = episode.facts.find(fact => fact.eventType === 'execution.plan.bound');
    if (bound?.payload.experimentSplit === 'hidden') return;
    const at = episode.facts[0]?.occurredAt ?? new Date().toISOString();
    const evidence = attribution.evidenceIds;
    const goal = readGoal(episode);
    const goalId = `goal:${slug(goal)}`;
    const episodeId = `episode:${episode.sessionId}`;
    this.graph.upsertNode({ id:goalId, type:'goal_pattern', label:goal, summary:`任务模式：${goal}`, state:'observed', evidenceIds:evidence, data:{ runId:episode.runId }, validFrom:at });
    this.graph.upsertNode({ id:episodeId, type:'episode', label:`Episode ${episode.sessionId}`, summary:`${attribution.category} · ${attribution.reason}`, state:episode.outcome ?? 'unknown', evidenceIds:evidence, data:{ sessionId:episode.sessionId, planRunId:episode.planRunId, nodeId:episode.nodeId, attribution }, validFrom:at });
    this.graph.upsertEdge({ id:`edge:${episodeId}:goal`, from:episodeId, to:goalId, type:'attempted', evidenceIds:evidence, confidenceLowerBound:attribution.confidence, validFrom:at });
    for (const fact of episode.facts) {
      const factId=`evidence:${fact.eventId}`;
      this.graph.upsertNode({id:factId,type:'evidence',label:fact.eventType,summary:`execution.* 原始事实 · sequence ${fact.sequence}`,state:'recorded',evidenceIds:[fact.eventId],data:{eventId:fact.eventId,eventType:fact.eventType,occurredAt:fact.occurredAt,sequence:fact.sequence,sessionId:fact.sessionId},validFrom:fact.occurredAt});
      this.graph.upsertEdge({id:`edge:${episodeId}:${factId}`,from:episodeId,to:factId,type:'supported_by',evidenceIds:[fact.eventId],validFrom:fact.occurredAt});
    }
    this.projectBoundPlan(episode, episodeId, at);
    if (attribution.category !== 'success') {
      const failureId = failureNodeIdForRecovery(attribution.reason);
      this.graph.upsertNode({ id:failureId, type:'failure_pattern', label:attribution.reason, summary:`归因：${attribution.category}`, state:attribution.learnable ? 'learnable' : 'isolated', evidenceIds:evidence, data:{ category:attribution.category, failure:attribution.failure }, validFrom:at });
      this.graph.upsertEdge({ id:`edge:${episodeId}:failure`, from:episodeId, to:failureId, type:'observed', evidenceIds:evidence, confidenceLowerBound:attribution.confidence, validFrom:at });
    }
  }

  private projectBoundPlan(episode: PlannerLeafEpisode, episodeId: string, at: string): void {
    const bound = episode.facts.find(fact => fact.eventType === 'execution.plan.bound');
    if (!bound || !isRecord(bound.payload.planGraph)) return;
    const plan = bound.payload.planGraph;
    const planRunId = typeof plan.id === 'string' ? plan.id : episode.planRunId;
    const planId = `plan:${planRunId}`;
    const parentGoalText = typeof bound.payload.parentGoalText === 'string'
      ? bound.payload.parentGoalText
      : readGoal(episode);
    const policySnapshotId = typeof bound.payload.policySnapshotId === 'string'
      ? bound.payload.policySnapshotId
      : null;
    const planEvidence = [bound.eventId];
    this.graph.upsertNode({
      id: planId,
      type: 'plan_graph',
      label: parentGoalText,
      summary: policySnapshotId ? `经验计划 · ${policySnapshotId}` : '冷启动计划',
      state: 'observed',
      evidenceIds: planEvidence,
      data: { ...plan, policySnapshotId, experienceMode: bound.payload.experienceMode ?? null },
      validFrom: at,
    });
    this.graph.upsertEdge({
      id: `edge:${episodeId}:${planId}`,
      from: episodeId,
      to: planId,
      type: 'executed_under',
      evidenceIds: planEvidence,
      validFrom: at,
    });

    const manifest=isRecord(bound.payload.selectionManifest)?bound.payload.selectionManifest:null;
    const manifestId=typeof bound.payload.selectionManifestId==='string'
      ? bound.payload.selectionManifestId
      : typeof manifest?.id==='string'?manifest.id:null;
    if(manifestId&&manifest){
      const graphManifestId=`selection:${manifestId}`;
      this.graph.upsertNode({id:graphManifestId,type:'selection_manifest',label:`经验选择 ${manifestId}`,summary:`采用 ${Array.isArray(manifest.selected)?manifest.selected.length:0} · 舍弃 ${Array.isArray(manifest.rejected)?manifest.rejected.length:0}`,state:'frozen',evidenceIds:planEvidence,data:manifest,validFrom:at});
      this.graph.upsertEdge({id:`edge:${planId}:${graphManifestId}`,from:planId,to:graphManifestId,type:'compiled_from',evidenceIds:planEvidence,validFrom:at});
      this.projectManifest(graphManifestId,manifest,at,planEvidence);
    }

    const nodes = Array.isArray(plan.nodes) ? plan.nodes.filter(isRecord) : [];
    for (const [index, node] of nodes.entries()) {
      const rawNodeId = typeof node.id === 'string' ? node.id : `node-${index + 1}`;
      const nodeId = `${planId}:${rawNodeId}`;
      const goal = isRecord(node.goal) && typeof node.goal.goalText === 'string'
        ? node.goal.goalText
        : rawNodeId;
      const existingNode = this.graph.getNode(nodeId);
      const nodeState = rawNodeId === episode.nodeId
        ? (episode.outcome ?? String(node.state ?? 'running'))
        : (existingNode?.state ?? String(node.state ?? 'pending'));
      this.graph.upsertNode({
        id: nodeId,
        type: 'plan_node',
        label: goal,
        summary: `计划节点 ${index + 1} · ${nodeState}`,
        state: nodeState,
        evidenceIds: planEvidence,
        data: node,
        validFrom: at,
      });
      this.graph.upsertEdge({
        id: `edge:${planId}:${rawNodeId}`,
        from: planId,
        to: nodeId,
        type: 'contains',
        evidenceIds: planEvidence,
        validFrom: at,
      });
      const refs=Array.isArray(node.experienceRefs)?node.experienceRefs.filter((value):value is string=>typeof value==='string'):[];
      for(const ref of refs){
        const experienceId=`experience:${ref}`;
        if(!this.graph.getNode(experienceId)) this.graph.upsertNode({id:experienceId,type:'plan_fragment',label:ref,summary:'本轮采用的规划经验',state:'selected',evidenceIds:planEvidence,data:{experienceId:ref},validFrom:at});
        this.graph.upsertEdge({id:`edge:${nodeId}:${experienceId}`,from:nodeId,to:experienceId,type:'used_experience',evidenceIds:planEvidence,validFrom:at});
        if(rawNodeId===episode.nodeId)this.graph.upsertEdge({id:`edge:${episodeId}:${experienceId}`,from:episodeId,to:experienceId,type:episode.outcome==='succeeded'?'supports':'refutes',evidenceIds:episode.facts.map(fact=>fact.eventId),validFrom:at});
      }
    }

    const edges = Array.isArray(plan.edges) ? plan.edges.filter(isRecord) : [];
    for (const [index, edge] of edges.entries()) {
      if (typeof edge.from !== 'string' || typeof edge.to !== 'string') continue;
      const from = `${planId}:${edge.from}`;
      const to = `${planId}:${edge.to}`;
      if (!this.graph.getNode(from) || !this.graph.getNode(to)) continue;
      this.graph.upsertEdge({
        id: `edge:${planId}:dependency:${index + 1}`,
        from,
        to,
        type: String(edge.type ?? 'requires'),
        evidenceIds: planEvidence,
        validFrom: at,
      });
    }

    if (policySnapshotId) {
      const policyId = `policy:${policySnapshotId.split('@')[0]}`;
      if (this.graph.getNode(policyId)) {
        this.graph.upsertEdge({
          id: `edge:${planId}:${policyId}`,
          from: planId,
          to: policyId,
          type: 'planned_with',
          evidenceIds: planEvidence,
          validFrom: at,
        });
      }
    }
  }

  private projectManifest(manifestId:string,manifest:Record<string,unknown>,at:string,planEvidence:string[]):void {
    const selected=Array.isArray(manifest.selected)?manifest.selected.filter(isRecord):[];
    for(const entry of selected){
      if(typeof entry.experienceId!=='string')continue;
      const id=`experience:${entry.experienceId}`;
      const type=experienceNodeType(entry.type);
      const evidence=Array.isArray(entry.evidenceRefs)?entry.evidenceRefs.filter((value):value is string=>typeof value==='string'):planEvidence;
      if(!this.graph.getNode(id))this.graph.upsertNode({id,type,label:entry.experienceId,summary:`已采用 · ${Array.isArray(entry.reasons)?entry.reasons.join('；'):''}`,state:'selected',evidenceIds:evidence.length?evidence:planEvidence,data:entry,validFrom:at});
      this.graph.upsertEdge({id:`edge:${manifestId}:${id}:selected`,from:manifestId,to:id,type:'selected',evidenceIds:evidence.length?evidence:planEvidence,confidenceLowerBound:typeof entry.score==='number'?Math.max(0,Math.min(1,entry.score)):undefined,validFrom:at});
      if(typeof entry.policyId==='string')this.ensurePolicyLink(id,entry.policyId,evidence.length?evidence:planEvidence,at);
    }
    const rejected=Array.isArray(manifest.rejected)?manifest.rejected.filter(isRecord):[];
    for(const entry of rejected){
      if(typeof entry.experienceId!=='string')continue;
      const id=`rejection:${manifestId}:${entry.experienceId}`;
      const reason=typeof entry.reason==='string'?entry.reason:'rejected';
      this.graph.upsertNode({id,type:'experience_rejection',label:entry.experienceId,summary:`未采用：${reason}`,state:'rejected',evidenceIds:planEvidence,data:entry,validFrom:at});
      this.graph.upsertEdge({id:`edge:${manifestId}:${id}`,from:manifestId,to:id,type:'rejected_experience',evidenceIds:planEvidence,validFrom:at});
    }
  }

  private ensurePolicyLink(experienceId:string,policyId:string,evidenceIds:string[],at:string):void {
    const id=`policy:${policyId}`;
    if(!this.graph.getNode(id))this.graph.upsertNode({id,type:'policy',label:policyId,summary:'SelectionManifest 引用的 Planner Policy',state:'referenced',evidenceIds,data:{policyId},validFrom:at});
    this.graph.upsertEdge({id:`edge:${experienceId}:${id}`,from:experienceId,to:id,type:'defined_by',evidenceIds,validFrom:at});
  }

  projectCandidate(candidate: ExperienceCandidate): void {
    const at = new Date().toISOString();
    const candidateNode = candidate.id;
    this.graph.upsertNode({ id:candidateNode, type:'candidate', label:`${candidate.goalPattern} 候选经验`, summary:`${candidate.taskFamily} · 正例 ${candidate.positiveEpisodeIds.length} · 反例 ${candidate.negativeEpisodeIds.length}`, state:candidate.status, evidenceIds:candidate.evidenceIds, data:candidate as unknown as Record<string, unknown>, validFrom:at });
    if (candidate.evolvedFromCandidateId && this.graph.getNode(candidate.evolvedFromCandidateId)) {
      this.graph.upsertEdge({
        id:`edge:${candidateNode}:evolved`, from:candidateNode, to:candidate.evolvedFromCandidateId,
        type:'evolved_from', evidenceIds:candidate.evidenceIds,
        confidenceLowerBound:candidate.confidenceLowerBound, validFrom:at,
      });
    }
    for (const episodeId of candidate.positiveEpisodeIds) {
      this.linkCandidateEpisode(candidateNode, episodeId, 'learned_from_success', candidate.evidenceIds, at);
    }
    for (const episodeId of candidate.negativeEpisodeIds) {
      this.linkCandidateEpisode(candidateNode, episodeId, 'learned_from_failure', candidate.evidenceIds, at);
    }
    for (const [index,schema] of candidate.content.taskSchemas.filter(isRecord).entries()) {
      const schemaId = String(schema.id ?? `${candidate.id}:task_schema:${index+1}`);
      this.graph.upsertNode({ id:schemaId, type:'task_schema', label:String(schema.goalPattern ?? candidate.goalPattern), summary:`${candidate.taskFamily} 任务结构`, state:'candidate', evidenceIds:candidate.evidenceIds, data:schema, validFrom:at });
      this.graph.upsertEdge({ id:`edge:${candidateNode}:${schemaId}`, from:candidateNode, to:schemaId, type:'proposes', evidenceIds:candidate.evidenceIds, confidenceLowerBound:candidate.confidenceLowerBound, validFrom:at });
    }
    for (const [index,fragment] of candidate.content.planFragments.filter(isRecord).entries()) {
      const fragmentId = String(fragment.id ?? `${candidate.id}:plan_fragment:${index+1}`);
      this.graph.upsertNode({ id:fragmentId, type:'plan_fragment', label:String(fragment.action ?? '规划片段'), summary:`可复用规划片段：${String(fragment.action ?? '')}`, state:'candidate', evidenceIds:candidate.evidenceIds, data:fragment, validFrom:at });
      this.graph.upsertEdge({ id:`edge:${candidateNode}:${fragmentId}`, from:candidateNode, to:fragmentId, type:'contains', evidenceIds:candidate.evidenceIds, confidenceLowerBound:candidate.confidenceLowerBound, validFrom:at });
    }
    for (const [index,recovery] of candidate.content.planRecoveryPatterns.filter(isRecord).entries()) {
      const recoveryId = String(recovery.id ?? `${candidate.id}:recovery_pattern:${index+1}`);
      const after = String(recovery.after ?? 'unknown failure');
      this.graph.upsertNode({ id:recoveryId, type:'plan_recovery_pattern', label:after, summary:`失败后的图级恢复：${String(recovery.graphChange ?? '')}`, state:'candidate', evidenceIds:candidate.evidenceIds, data:recovery, validFrom:at });
      this.graph.upsertEdge({ id:`edge:${candidateNode}:${recoveryId}`, from:candidateNode, to:recoveryId, type:'contains', evidenceIds:candidate.evidenceIds, confidenceLowerBound:candidate.confidenceLowerBound, validFrom:at });
      const failureId = failureNodeIdForRecovery(after);
      if (!this.graph.getNode(failureId)) this.graph.upsertNode({id:failureId,type:'failure_pattern',label:canonicalFailureReason(after),summary:'候选恢复策略指向的可学习失败模式',state:'observed',evidenceIds:candidate.evidenceIds,data:{reason:after},validFrom:at});
      this.graph.upsertEdge({ id:`edge:${recoveryId}:${failureId}`, from:recoveryId, to:failureId, type:'handles', evidenceIds:candidate.evidenceIds, confidenceLowerBound:candidate.confidenceLowerBound, validFrom:at });
    }
    for (const [index,meta] of candidate.content.metaPolicies.filter(isRecord).entries()) {
      const metaId=String(meta.id??`${candidate.id}:meta_policy:${index+1}`);
      this.graph.upsertNode({id:metaId,type:'meta_policy',label:String(meta.rule??metaId),summary:'候选规划元策略',state:'candidate',evidenceIds:candidate.evidenceIds,data:meta,validFrom:at});
      this.graph.upsertEdge({id:`edge:${candidateNode}:${metaId}`,from:candidateNode,to:metaId,type:'contains',evidenceIds:candidate.evidenceIds,confidenceLowerBound:candidate.confidenceLowerBound,validFrom:at});
    }
  }

  retireCandidate(candidateId: string): boolean {
    return this.graph.retireNode(candidateId);
  }

  projectPolicy(policy: PlannerPolicyRecord): void {
    const at = policy.updatedAt;
    const id = `policy:${policy.id}`;
    this.graph.upsertNode({ id, type:'policy', label:`Planner Policy V${policy.version}`, summary:`${policy.state} · 可信下界 ${Math.round(policy.confidenceLowerBound * 100)}%`, state:policy.state, evidenceIds:policy.evidenceIds, data:{ policyId:policy.id, version:policy.version, revision:policy.revision, evolvedFrom:policy.evolvedFrom }, validFrom:policy.createdAt });
    if (policy.evolvedFrom) {
      const parentId = `policy:${policy.evolvedFrom}`;
      if (this.graph.getNode(parentId)) this.graph.upsertEdge({ id:`edge:${id}:evolved`, from:id, to:parentId, type:'evolved_from', evidenceIds:policy.evidenceIds, confidenceLowerBound:policy.confidenceLowerBound, validFrom:at });
    }
    for (const [index,schema] of policy.content.taskSchemas.filter(isRecord).entries()) {
      const schemaId=String(schema.id??`${policy.id}:task_schema:${index+1}`);
      this.graph.upsertNode({id:schemaId,type:'task_schema',label:String(schema.goalPattern??policy.goalPattern??schemaId),summary:`Planner Policy V${policy.version} 的任务结构`,state:policy.state,evidenceIds:policy.evidenceIds,data:schema,validFrom:policy.createdAt});
      this.graph.upsertEdge({id:`edge:${id}:${schemaId}`,from:id,to:schemaId,type:'contains',evidenceIds:policy.evidenceIds,confidenceLowerBound:policy.confidenceLowerBound,validFrom:at});
    }
    for (const [index,fragment] of policy.content.planFragments.filter(isRecord).entries()) {
      const fragmentId=String(fragment.id??`${policy.id}:plan_fragment:${index+1}`);
      this.graph.upsertNode({id:fragmentId,type:'plan_fragment',label:String(fragment.goalText??fragment.action??fragment.stage??fragmentId),summary:`Planner Policy V${policy.version} 的计划片段`,state:policy.state,evidenceIds:policy.evidenceIds,data:fragment,validFrom:policy.createdAt});
      this.graph.upsertEdge({id:`edge:${id}:${fragmentId}`,from:id,to:fragmentId,type:'contains',evidenceIds:policy.evidenceIds,confidenceLowerBound:policy.confidenceLowerBound,validFrom:at});
    }
    for (const [index,recovery] of policy.content.planRecoveryPatterns.filter(isRecord).entries()) {
      const recoveryId=String(recovery.id??`${policy.id}:recovery_pattern:${index+1}`);
      const after=String(recovery.after??'unknown failure');
      this.graph.upsertNode({id:recoveryId,type:'plan_recovery_pattern',label:after,summary:`Planner Policy V${policy.version} 的恢复模式`,state:policy.state,evidenceIds:policy.evidenceIds,data:recovery,validFrom:policy.createdAt});
      this.graph.upsertEdge({id:`edge:${id}:${recoveryId}`,from:id,to:recoveryId,type:'contains',evidenceIds:policy.evidenceIds,confidenceLowerBound:policy.confidenceLowerBound,validFrom:at});
      const failureId=failureNodeIdForRecovery(after);
      if(!this.graph.getNode(failureId))this.graph.upsertNode({id:failureId,type:'failure_pattern',label:canonicalFailureReason(after),summary:`Planner Policy V${policy.version} 覆盖的失败模式`,state:policy.state,evidenceIds:policy.evidenceIds,data:{reason:after},validFrom:policy.createdAt});
      this.graph.upsertEdge({id:`edge:${recoveryId}:${failureId}`,from:recoveryId,to:failureId,type:'handles',evidenceIds:policy.evidenceIds,confidenceLowerBound:policy.confidenceLowerBound,validFrom:at});
    }
    for (const [index,meta] of policy.content.metaPolicies.filter(isRecord).entries()) {
      const metaId=String(meta.id??`${policy.id}:meta_policy:${index+1}`);
      this.graph.upsertNode({id:metaId,type:'meta_policy',label:String(meta.rule??metaId),summary:`Planner Policy V${policy.version} 的元策略`,state:policy.state,evidenceIds:policy.evidenceIds,data:meta,validFrom:policy.createdAt});
      this.graph.upsertEdge({id:`edge:${id}:${metaId}`,from:id,to:metaId,type:'contains',evidenceIds:policy.evidenceIds,confidenceLowerBound:policy.confidenceLowerBound,validFrom:at});
    }
    for (const plan of this.graph.listNodes({ types: ['plan_graph'], limit: 5000 })) {
      const snapshot = typeof plan.data.policySnapshotId === 'string' ? plan.data.policySnapshotId : '';
      if (snapshot !== policy.id && !snapshot.startsWith(`${policy.id}@`)) continue;
      this.graph.upsertEdge({
        id: `edge:${plan.id}:${id}`,
        from: plan.id,
        to: id,
        type: 'planned_with',
        evidenceIds: plan.evidenceIds,
        confidenceLowerBound: policy.confidenceLowerBound,
        validFrom: at,
      });
    }
  }

  private linkCandidateEpisode(candidateId:string,sessionId:string,type:string,evidenceIds:string[],at:string):void {
    const episodeId=`episode:${sessionId}`;
    if(!this.graph.getNode(episodeId))return;
    this.graph.upsertEdge({id:`edge:${candidateId}:${episodeId}:${type}`,from:candidateId,to:episodeId,type,evidenceIds,validFrom:at});
  }
}

function readGoal(episode: PlannerLeafEpisode): string {
  const started = episode.facts.find(fact => fact.eventType === 'execution.session.started');
  return typeof started?.payload.goalText === 'string' ? started.payload.goalText : episode.nodeId;
}
function slug(value: string): string { return value.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-').replace(/^-|-$/g, '').slice(0,80) || 'unknown'; }
function failureNodeIdForRecovery(after:string):string {
  return `failure:${slug(canonicalFailureReason(after))}`;
}
function canonicalFailureReason(value:string):string{return value.replace(/^graph_replan\s*:/i,'');}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function experienceNodeType(value:unknown):'task_schema'|'plan_fragment'|'plan_recovery_pattern' {
  return value==='task_schema'?'task_schema':value==='recovery_pattern'?'plan_recovery_pattern':'plan_fragment';
}
