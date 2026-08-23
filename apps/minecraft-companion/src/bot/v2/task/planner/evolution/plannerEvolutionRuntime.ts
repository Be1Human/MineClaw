import { EpisodeLedger } from './episodeLedger.js';
import { EvolutionGraphStore } from './evolutionGraphStore.js';
import { PlannerPolicyStore } from './policyStore.js';
import { PlannerLearningStore } from './learningStore.js';
import { EvolutionProjector } from './evolutionProjector.js';
import { PlannerEvolutionEngine, type EvolutionCycleSummary } from './plannerEvolutionEngine.js';
import { JsonlExecutionFactSource } from './jsonlExecutionFactSource.js';
import { PlannerExperienceProvider } from '../experience/plannerExperienceProvider.js';
import type { PlannerExperienceFreezeResult } from '../experience/plannerExperienceProvider.js';
import type { ContextSignature, GoalSignature } from '../plannerContracts.js';
import { CandidateExperimentOrchestrator } from './candidateExperimentOrchestrator.js';

export interface PlannerEvolutionRuntimeOptions { dbPath:string; executionFactsPath:string; pollMs?:number }

export interface PlannerPolicyInvalidationV1 {
  schema: 'mineclaw.planner-policy-invalidation/v1';
  policyId: string;
  policyRevision: number;
  reason: string;
  safety: true;
  invalidatedAt: string;
}

/** Lifecycle wrapper. It consumes facts and exposes only frozen Planner experience. */
export class PlannerEvolutionRuntime {
  readonly ledger:EpisodeLedger;readonly graph:EvolutionGraphStore;readonly policies:PlannerPolicyStore;readonly learning:PlannerLearningStore;
  readonly engine:PlannerEvolutionEngine;readonly experience:PlannerExperienceProvider;readonly experiments:CandidateExperimentOrchestrator;readonly projector:EvolutionProjector;
  private readonly source:JsonlExecutionFactSource;private timer:ReturnType<typeof setInterval>|null=null;private running:Promise<EvolutionCycleSummary>|null=null;
  private readonly invalidationListeners=new Set<(event:PlannerPolicyInvalidationV1)=>void>();
  private readonly knownBlacklisted=new Set<string>();
  constructor(private readonly options:PlannerEvolutionRuntimeOptions){
    this.ledger=new EpisodeLedger(options.dbPath);
    this.graph=new EvolutionGraphStore(options.dbPath);
    this.policies=new PlannerPolicyStore(options.dbPath);
    this.learning=new PlannerLearningStore(options.dbPath);
    this.projector=new EvolutionProjector(this.graph);
    this.engine=new PlannerEvolutionEngine(this.ledger,this.learning,this.policies,this.projector);
    this.experience=new PlannerExperienceProvider(this.policies,this.learning,this.graph);
    this.experiments=new CandidateExperimentOrchestrator(this.ledger,this.learning);
    this.source=new JsonlExecutionFactSource(options.executionFactsPath);
    // Graph projection is rebuildable.  Re-project persisted policies and
    // candidates at startup so online retrieval never depends on whether the
    // process happened to be alive at the original promotion moment.
    const persistedPolicies=this.policies.list(),activeIds=new Set(this.policies.listActive().map(value=>value.id));
    for(const policy of persistedPolicies)if(policy.state==='blacklisted')this.knownBlacklisted.add(policy.id);
    for(const policy of persistedPolicies.filter(value=>!activeIds.has(value.id)))this.projector.projectPolicy(policy);
    for(const policy of persistedPolicies.filter(value=>activeIds.has(value.id)))this.projector.projectPolicy(policy);
    for(const candidate of this.learning.listCandidates())this.projector.projectCandidate(candidate);
  }
  async start():Promise<EvolutionCycleSummary>{const first=await this.sync();if(!this.timer){this.timer=setInterval(()=>{void this.sync();},Math.max(250,this.options.pollMs??1000));this.timer.unref?.();}return first;}
  sync():Promise<EvolutionCycleSummary>{if(this.running)return this.running;this.running=this.engine.catchUp(this.source).then(summary=>{this.experiments.reconcile();this.emitNewSafetyInvalidations();return summary;}).finally(()=>{this.running=null;});return this.running;}
  freezeForPlan(request:{planRunId:string;goalSignature:GoalSignature;context:ContextSignature;experimentsEnabled:boolean;maxEstimatedActions?:number}):PlannerExperienceFreezeResult{
    const authorization=this.experiments.authorize({...request,enabled:request.experimentsEnabled});
    if(authorization){
      const result=this.experience.freezeExperiment({planRunId:request.planRunId,goalSignature:request.goalSignature,context:request.context,mode:'experiment'},authorization);
      if(result.status==='frozen')return result;
      this.experiments.abandon(request.planRunId);
    }
    return this.experience.freeze({planRunId:request.planRunId,goalSignature:request.goalSignature,context:request.context,mode:'production'});
  }
  onPolicyInvalidated(listener:(event:PlannerPolicyInvalidationV1)=>void):()=>void{this.invalidationListeners.add(listener);return()=>{this.invalidationListeners.delete(listener);};}
  stop():void{if(this.timer){clearInterval(this.timer);this.timer=null;}this.invalidationListeners.clear();this.learning.close();this.policies.close();this.graph.close();this.ledger.close();}
  private emitNewSafetyInvalidations():void{for(const policy of this.policies.list()){if(policy.state!=='blacklisted'||this.knownBlacklisted.has(policy.id))continue;this.knownBlacklisted.add(policy.id);const audit=[...this.policies.listAudit(policy.id)].reverse().find(value=>value.action==='blacklist');const event:PlannerPolicyInvalidationV1={schema:'mineclaw.planner-policy-invalidation/v1',policyId:policy.id,policyRevision:policy.revision,reason:typeof audit?.detail.reason==='string'?audit.detail.reason:'planner policy failed safety gate',safety:true,invalidatedAt:audit?.createdAt??policy.updatedAt};for(const listener of this.invalidationListeners)listener(structuredClone(event));}}
}
