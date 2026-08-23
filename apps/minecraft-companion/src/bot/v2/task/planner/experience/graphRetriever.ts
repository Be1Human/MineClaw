import { createHash } from 'node:crypto';
import type { PlannerPolicyRecord } from '../evolution/policyStore.js';
import type { EvolutionGraphStore, EvolutionNodeType } from '../evolution/evolutionGraphStore.js';
import type { ContextSignature, GoalSignature } from '../plannerContracts.js';
import type { ExperienceRejectionEntry } from './experienceContracts.js';

export interface RetrievedPolicyCandidate {
  policy: PlannerPolicyRecord;
  score: number;
  reasons: string[];
}

export interface GraphRetrievalResult {
  candidates: RetrievedPolicyCandidate[];
  rejected: ExperienceRejectionEntry[];
  contextSignatureHash: string;
  corrupt: boolean;
}

export interface GraphRetrievalScope {
  rootNodeId: string;
  rootNodeType: Extract<EvolutionNodeType, 'policy' | 'candidate'>;
  rootNodeState: 'trusted' | 'candidate';
}

export class PlannerGraphRetriever {
  constructor(
    private readonly minimumConfidence = 0.55,
    private readonly graph?: Pick<EvolutionGraphStore, 'getNode' | 'querySubgraph'>,
  ) {}

  retrieve(
    policies: readonly PlannerPolicyRecord[],
    goal: GoalSignature,
    context: ContextSignature,
    graphScope?: GraphRetrievalScope,
  ): GraphRetrievalResult {
    const candidates: RetrievedPolicyCandidate[] = [];
    const rejected: ExperienceRejectionEntry[] = [];
    let corrupt = false;
    for (const policy of policies) {
      const rejection = this.hardFilter(policy, goal, context, graphScope);
      if (rejection) {
        rejected.push(rejection);
        if (rejection.reason === 'corrupt') corrupt = true;
        continue;
      }
      const match = scorePolicy(policy, goal, context);
      if (!match.applicable) {
        rejected.push(rejectedPolicy(policy, 'not_applicable'));
        continue;
      }
      candidates.push({
        policy,
        score: Math.min(1, match.score + (this.graph ? .03 : 0)),
        reasons: [...match.reasons, ...(this.graph ? ['knowledge_graph_verified'] : [])],
      });
    }
    candidates.sort((left, right) => right.score - left.score || left.policy.id.localeCompare(right.policy.id));
    return {
      candidates,
      rejected,
      contextSignatureHash: hash(stableStringify(context)),
      corrupt,
    };
  }

  private hardFilter(
    policy: PlannerPolicyRecord,
    goal: GoalSignature,
    context: ContextSignature,
    graphScope?: GraphRetrievalScope,
  ): ExperienceRejectionEntry | null {
    if (policy.state !== 'trusted') return rejectedPolicy(policy, 'not_trusted');
    if (!validPolicy(policy)) return rejectedPolicy(policy, 'corrupt');
    if (this.graph && !experienceProjectionIsComplete(this.graph, policy, graphScope)) return rejectedPolicy(policy, 'corrupt');
    if (policy.confidenceLowerBound < this.minimumConfidence) return rejectedPolicy(policy, 'low_confidence');
    const rules = policy.content.applicability.filter(isRecord);
    if (rules.some(rule => typeof rule.expiresAt === 'string' && Date.parse(rule.expiresAt) <= Date.now())) {
      return rejectedPolicy(policy, 'expired');
    }
    if (containsForbiddenRuntimeData(policy.content)) return rejectedPolicy(policy, 'unsafe');
    if (rules.some(rule => typeof rule.requiresCapability === 'string' && !context.capabilities.includes(rule.requiresCapability))) {
      return rejectedPolicy(policy, 'not_applicable');
    }
    if (rules.some(rule => typeof rule.maxDangerLevel === 'number' && context.dangerLevel > rule.maxDangerLevel)) {
      return rejectedPolicy(policy, 'not_applicable');
    }
    if (!goal.compatibleTaskFamilies.length) return rejectedPolicy(policy, 'not_applicable');
    return null;
  }
}

function experienceProjectionIsComplete(
  graph: Pick<EvolutionGraphStore, 'getNode' | 'querySubgraph'>,
  policy: PlannerPolicyRecord,
  scope?: GraphRetrievalScope,
): boolean {
  const rootNodeId=scope?.rootNodeId??`policy:${policy.id}`;
  const rootNodeType=scope?.rootNodeType??'policy';
  const rootNodeState=scope?.rootNodeState??'trusted';
  const snapshot=graph.querySubgraph([rootNodeId],{depth:1,maxNodes:128,maxEdges:256});
  const rootNode=snapshot.nodes.find(node=>node.id===rootNodeId);
  if(!rootNode||rootNode.type!==rootNodeType||rootNode.state!==rootNodeState)return false;
  const acceptedRelations=rootNodeType==='candidate'?new Set(['contains','proposes']):new Set(['contains']);
  const contained=new Set(snapshot.edges.filter(edge=>edge.from===rootNodeId&&acceptedRelations.has(edge.type)).map(edge=>edge.to));
  for(const expected of expectedPolicyItems(policy)){
    const node=graph.getNode(expected.id);
    if(!node||node.type!==expected.nodeType||!contained.has(expected.id))return false;
  }
  return true;
}

function expectedPolicyItems(policy:PlannerPolicyRecord):Array<{id:string;nodeType:EvolutionNodeType}>{
  const result:Array<{id:string;nodeType:EvolutionNodeType}>=[];
  const add=(values:unknown[],selectionType:string,nodeType:EvolutionNodeType)=>values.forEach((value,index)=>{
    result.push({id:itemId(value,policy.id,selectionType,index),nodeType});
  });
  add(policy.content.taskSchemas,'task_schema','task_schema');
  add(policy.content.planFragments,'plan_fragment','plan_fragment');
  add(policy.content.planRecoveryPatterns,'recovery_pattern','plan_recovery_pattern');
  add(policy.content.metaPolicies,'meta_policy','meta_policy');
  return result;
}

function itemId(value:unknown,policyId:string,type:string,index:number):string{
  return isRecord(value)&&typeof value.id==='string'&&value.id.trim()
    ? value.id
    : `${policyId}:${type}:${index+1}`;
}

function scorePolicy(policy: PlannerPolicyRecord, goal: GoalSignature, context: ContextSignature): { applicable: boolean; score: number; reasons: string[] } {
  const rules = policy.content.applicability.filter(isRecord);
  if (rules.length === 0) return { applicable: true, score: 0.6 + policy.confidenceLowerBound * 0.25, reasons: ['generic_trusted_policy'] };
  let best = -1;
  let reasons: string[] = [];
  for (const rule of rules) {
    const family = typeof rule.taskFamily === 'string' ? rule.taskFamily : undefined;
    if (family && !goal.compatibleTaskFamilies.includes(family)) continue;
    const targetId = typeof rule.targetId === 'string' ? normalizeId(rule.targetId) : undefined;
    const exact = targetId === goal.targetId;
    const supports = Array.isArray(rule.supportsTargets)
      && rule.supportsTargets.some(value => typeof value === 'string' && normalizeId(value) === goal.targetId);
    const signature = typeof rule.goalSignature === 'string' && rule.goalSignature === goal.key;
    const complementary = rule.role === 'dependency' && (!targetId || supports);
    if (targetId && !exact && !supports) continue;
    if (typeof rule.contextFacilityMissing === 'string' && context.nearbyFacilities.includes(rule.contextFacilityMissing)) continue;
    const score = (exact || signature ? 0.5 : supports || complementary ? 0.32 : 0.18)
      + policy.confidenceLowerBound * 0.35
      + Math.min(0.1, policy.evidenceIds.length * 0.02);
    if (score > best) {
      best = score;
      reasons = [
        ...(exact || signature ? ['exact_goal_match'] : []),
        ...(supports || complementary ? ['dependency_support'] : []),
        ...(family ? [`family:${family}`] : []),
        `confidence:${policy.confidenceLowerBound.toFixed(3)}`,
        `evidence:${policy.evidenceIds.length}`,
      ];
    }
  }
  return best < 0 ? { applicable: false, score: 0, reasons: [] } : { applicable: true, score: best, reasons };
}

function validPolicy(policy: PlannerPolicyRecord): boolean {
  const content = policy.content;
  return !!policy.id && Number.isInteger(policy.revision)
    && Array.isArray(content.taskSchemas) && Array.isArray(content.planFragments)
    && Array.isArray(content.planRecoveryPatterns) && Array.isArray(content.metaPolicies)
    && Array.isArray(content.applicability) && Array.isArray(policy.evidenceIds);
}
function containsForbiddenRuntimeData(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(containsForbiddenRuntimeData);
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (/^(preparedAction|actionProposal|sessionId|requestId|absolutePosition|coordinates|hiddenFeatures)$/i.test(key)) return true;
    if (containsForbiddenRuntimeData(child)) return true;
  }
  return false;
}
function rejectedPolicy(policy: PlannerPolicyRecord, reason: ExperienceRejectionEntry['reason']): ExperienceRejectionEntry {
  return { experienceId: policy.id, policyId: policy.id, reason };
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function normalizeId(value: string): string { return value.includes(':') ? value.toLowerCase() : `minecraft:${value.toLowerCase()}`; }
function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
