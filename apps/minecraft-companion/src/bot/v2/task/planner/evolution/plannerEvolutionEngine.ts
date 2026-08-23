import { EpisodeLedger, type PlannerLeafEpisode } from './episodeLedger.js';
import { ExecutionFactIngestor, type ExecutionFactSource } from './executionFactIngestor.js';
import { ExperienceAttributor, type EpisodeAttribution } from './attributor.js';
import { PlannerOptimizer, type ExperienceCandidate } from './plannerOptimizer.js';
import { EvolutionProjector } from './evolutionProjector.js';
import { PlannerLearningStore } from './learningStore.js';
import { ResearchAgenda } from './researchAgenda.js';
import { EvalGate, type EvaluationTrack, type GateDecision } from './evalGate.js';
import { PlannerPolicyStore, type PlannerPolicyRecord } from './policyStore.js';
import { CandidateTrialScheduler } from './candidateTrialScheduler.js';
import { CandidateSuccessorReflector } from './candidateSuccessorReflector.js';

export interface EvolutionCycleSummary {
  ingested: number;
  finalized: number;
  projectedEpisodes: number;
  candidates: number;
  agendaItems: number;
}

export class PlannerEvolutionEngine {
  readonly ingestor: ExecutionFactIngestor;
  private readonly attributor = new ExperienceAttributor();
  private readonly optimizer = new PlannerOptimizer();
  private readonly agenda: ResearchAgenda;
  private readonly gate = new EvalGate();
  private readonly trials: CandidateTrialScheduler;
  private readonly reflector = new CandidateSuccessorReflector();

  constructor(
    private readonly ledger: EpisodeLedger,
    private readonly learning: PlannerLearningStore,
    private readonly policies: PlannerPolicyStore,
    private readonly projector: EvolutionProjector,
  ) {
    this.ingestor = new ExecutionFactIngestor(ledger);
    this.agenda = new ResearchAgenda(learning);
    this.trials = new CandidateTrialScheduler(ledger, learning, this.attributor);
  }

  async catchUp(source: ExecutionFactSource): Promise<EvolutionCycleSummary> {
    const ingest = await this.ingestor.catchUp(source);
    const projectedEpisodes = this.projectFinalized();
    const candidates = this.refreshCandidates();
    const agendaItems = this.agenda.schedule(candidates).length;
    return { ingested: ingest.accepted, finalized: ingest.finalized, projectedEpisodes, candidates:candidates.length, agendaItems };
  }

  attach(source: ExecutionFactSource): () => void {
    const stopIngest = this.ingestor.attach(source);
    const timer = setInterval(() => { this.projectFinalized(); this.refreshCandidates(); }, 250);
    timer.unref?.();
    return () => { stopIngest(); clearInterval(timer); };
  }

  projectFinalized(): number {
    let count = 0;
    for (const episode of this.ledger.listEpisodes({ state:'finalized' })) {
      if (this.learning.isProjected(episode.sessionId)) continue;
      this.projector.projectEpisode(episode, this.attributor.classify(episode));
      this.learning.markProjected(episode.sessionId);
      count += 1;
    }
    return count;
  }

  refreshCandidates(): ExperienceCandidate[] {
    const samples = this.ledger.listEpisodes({ state:'finalized' })
      .filter(episode => !isCandidateExperimentEpisode(episode))
      .map(episode => ({ episode, attribution:this.attributor.classify(episode) }));
    const attributionByEpisodeId = new Map(samples.map(sample => [sample.episode.sessionId, sample.attribution]));
    const invalidCandidates = this.learning.listCandidates()
      .filter(candidate => candidate.status === 'candidate')
      .filter(candidate => {
        const episodeIds = [...candidate.positiveEpisodeIds, ...candidate.negativeEpisodeIds];
        return episodeIds.length > 0 && episodeIds.every(id => attributionByEpisodeId.get(id)?.learnable === false);
      })
      .map(candidate => candidate.id);
    const retiredInvalid = this.learning.retireCandidates(invalidCandidates, 'candidate_evidence_no_longer_learning_eligible');
    for (const candidateId of retiredInvalid) this.projector.retireCandidate(candidateId);
    const proposals = this.optimizer.propose(samples);
    const retired = this.learning.retireSupersededCandidates(proposals.map(candidate => candidate.lineageId ?? candidate.id));
    for (const candidateId of retired) this.projector.retireCandidate(candidateId);
    const candidates: ExperienceCandidate[] = [];
    for (const proposal of proposals) {
      const candidate = this.learning.registerCandidateProposal(proposal);
      pushCandidate(candidates, candidate);
      this.projector.projectCandidate(candidate);
      this.agenda.schedule([candidate]);
      const reconciled = this.reconcileExhaustedValidation(candidate);
      if (reconciled) {
        pushCandidate(candidates, reconciled);
        continue;
      }
      const ready = this.trials.advance(candidate);
      if (!ready) continue;
      const outcome = this.evaluateCandidate({
        candidateId: candidate.id,
        version: this.policies.nextVersionForContent(candidate.content),
        control: ready.control,
        treatment: ready.treatment,
        baselineEpisodeIds: ready.baselineEpisodeIds,
        selectionEpisodeIds: ready.selectionEpisodeIds,
        hiddenEpisodeIds: ready.hiddenEpisodeIds,
        settleAgenda: false,
      });
      const agendaBefore = this.learning.listAgenda().find(item => item.candidateId === candidate.id);
      const retryDecision = outcome.decision.decision === 'reject' || outcome.decision.decision === 'inconclusive';
      const allowRetry = retryDecision && ready.attempt < 3 && (agendaBefore?.retryBudget ?? 0) > 1;
      const settlement = this.trials.settle(ready, outcome.decision.decision, allowRetry);
      this.agenda.settle(
        candidate.id,
        settlement === 'completed'
          ? 'completed'
          : settlement === 'retry' || settlement === 'exhausted'
            ? 'inconclusive'
            : 'rejected',
      );
      if (
        (settlement === 'exhausted' || settlement === 'rejected')
        && outcome.decision.decision !== 'blacklist'
        && outcome.decision.decision !== 'promote'
      ) {
        const run = this.learning.getValidationRun(candidate.id);
        const successor = this.reflectSuccessor(candidate, [
          ...(run?.consumedTrialEpisodeIds ?? []),
          ...ready.selectionEpisodeIds,
        ]);
        if (successor) pushCandidate(candidates, successor);
      }
    }
    return candidates;
  }

  /** Repairs older persisted agenda=0/validation=collecting pairs and learns G2 without fabricating a trial. */
  private reconcileExhaustedValidation(candidate: ExperienceCandidate): ExperienceCandidate | null {
    const agenda = this.learning.listAgenda().find(item => item.candidateId === candidate.id);
    const run = this.learning.getValidationRun(candidate.id);
    if (!agenda || agenda.retryBudget > 0 || agenda.status !== 'backlog') return null;
    if (!run || (run.status !== 'collecting' && run.status !== 'evaluating')) return null;
    // Older runtimes cleared `reason` while rescheduling the same exhausted
    // agenda. The canonical persisted pair (backlog + zero budget + an open
    // validation run) is sufficient to restore that lost terminal reason.
    if (agenda.reason !== 'retry_exhausted') {
      const { updatedAt: _agendaUpdatedAt, ...persistedAgenda } = agenda;
      this.learning.upsertAgenda({ ...persistedAgenda, reason: 'retry_exhausted' });
    }
    const { updatedAt: _updatedAt, ...persisted } = run;
    this.learning.upsertValidationRun({ ...persisted, status: 'rejected' });
    return this.reflectSuccessor(candidate, [
      ...run.consumedTrialEpisodeIds,
      ...run.selectionEpisodeIds,
    ]);
  }

  private reflectSuccessor(parent: ExperienceCandidate, episodeIds: string[]): ExperienceCandidate | null {
    const planRunIds = new Set(episodeIds.map(id => this.ledger.getEpisode(id)?.planRunId).filter((value): value is string => !!value));
    if (planRunIds.size === 0) return null;
    const selectionEpisodes = this.ledger.listEpisodes({ state:'finalized' }).filter(episode => {
      if (!planRunIds.has(episode.planRunId)) return false;
      const bound = episode.facts.find(fact => fact.eventType === 'execution.plan.bound');
      return bound?.payload.experimentSplit === 'selection' && bound.payload.candidateId === parent.id;
    });
    const proposal = this.reflector.reflect(parent, selectionEpisodes);
    if (!proposal) return null;
    const successor = this.learning.registerCandidateProposal(proposal);
    if (successor.id === parent.id) return null;
    this.projector.projectCandidate(successor);
    this.agenda.schedule([successor]);
    this.trials.advance(successor);
    return successor;
  }

  evaluateCandidate(input: { candidateId:string; version:number; control:EvaluationTrack; treatment:EvaluationTrack; baselineEpisodeIds?:string[]; selectionEpisodeIds?:string[]; hiddenEpisodeIds?:string[]; settleAgenda?:boolean }): { decision:GateDecision; policy:PlannerPolicyRecord } {
    const candidate = this.learning.getCandidate(input.candidateId);
    if (!candidate) throw new Error(`candidate not found: ${input.candidateId}`);
    const active = this.policies.activeForContent(candidate.content);
    const id = `planner-${candidate.taskFamily}-${policySlug(candidate.id)}-v${input.version}`;
    const scope = candidate.content.applicability.find(value => value && typeof value === 'object' && !Array.isArray(value)) as Record<string, unknown> | undefined;
    let policy = this.policies.get(id) ?? this.policies.createCandidate({
      id, version:input.version, content:candidate.content, evidenceIds:candidate.evidenceIds,
      ...(active ? {evolvedFrom:active.id}:{}), sourceCandidateId:candidate.id,
      taskFamily:candidate.taskFamily, goalPattern:candidate.goalPattern,
      ...(typeof scope?.goalSignature==='string'?{goalSignature:scope.goalSignature}:{}),
      confidenceLowerBound:Math.max(.55,candidate.confidenceLowerBound),
    });
    const decision = this.gate.decide(input.control, input.treatment);
    const evaluationId = `evaluation:${id}:${Date.now()}`;
    const selectionEpisodeIds = input.selectionEpisodeIds ?? candidate.positiveEpisodeIds;
    const hiddenEpisodeIds = input.hiddenEpisodeIds ?? candidate.positiveEpisodeIds;
    this.learning.addEvaluation({ id:evaluationId, policyId:id, ...(active ? {baselinePolicyId:active.id}:{}), split:'selection', metrics:input.treatment.selection, decision, episodeIds:selectionEpisodeIds });
    this.learning.addEvaluation({ id:`${evaluationId}:hidden`, policyId:id, ...(active ? {baselinePolicyId:active.id}:{}), split:'hidden', metrics:input.treatment.hidden, decision, episodeIds:hiddenEpisodeIds });
    this.learning.addCurvePoint({ policyId:id, policyVersion:input.version, split:'selection', metrics:input.treatment.selection, episodeIds:selectionEpisodeIds, valid:decision.decision !== 'inconclusive' });
    this.learning.addCurvePoint({ policyId:id, policyVersion:input.version, split:'hidden', metrics:input.treatment.hidden, episodeIds:hiddenEpisodeIds, valid:decision.decision !== 'inconclusive' });
    if (decision.decision === 'promote') policy = this.policies.promote(id, policy.revision, { decision:'promote', selectionDelta:decision.selectionDelta, efficiencyImproved:decision.efficiencyImproved, hiddenRegression:false, safetyViolations:0, evaluationId });
    else if (decision.decision === 'blacklist') policy = this.policies.blacklist(id, policy.revision, decision.reasons.join(','));
    else if (decision.decision === 'reject') policy = this.policies.reject(id, policy.revision, decision.reasons.join(','));
    if(active&&active.id!==policy.id){
      const updatedParent=this.policies.get(active.id);
      if(updatedParent)this.projector.projectPolicy(updatedParent);
    }
    this.projector.projectPolicy(policy);
    if (input.settleAgenda !== false) this.agenda.settle(candidate.id, decision.decision === 'promote' ? 'completed' : decision.decision === 'inconclusive' ? 'inconclusive' : 'rejected');
    return { decision, policy };
  }
}

export function isHiddenExperimentEpisode(episode: PlannerLeafEpisode): boolean {
  const bound = episode.facts.find(fact => fact.eventType === 'execution.plan.bound');
  return bound?.payload.experimentSplit === 'hidden';
}

/** Treatment results evaluate a frozen candidate but never rewrite it. */
export function isCandidateExperimentEpisode(episode: PlannerLeafEpisode): boolean {
  const bound = episode.facts.find(fact => fact.eventType === 'execution.plan.bound');
  return bound?.payload.experienceMode === 'experiment'
    || bound?.payload.experimentSplit === 'selection'
    || bound?.payload.experimentSplit === 'hidden';
}

export function attributionFor(episode: PlannerLeafEpisode): EpisodeAttribution { return new ExperienceAttributor().classify(episode); }
function policySlug(value:string):string{return value.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g,'-').replace(/^-|-$/g,'').slice(0,48)||'candidate';}
function pushCandidate(values:ExperienceCandidate[],candidate:ExperienceCandidate):void{if(!values.some(value=>value.id===candidate.id))values.push(candidate);}
