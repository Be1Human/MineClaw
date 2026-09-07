import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { jsonSnapshot } from '../../infra/jsonSnapshot.js';
import { tuning } from '../../infra/tuning.js';
import type { ContributionRef } from '../../plugin-sdk/identity.js';
import type { PluginOperationDeclaration } from '../../plugin-sdk/contributions.js';
import type { GoalContractV2 } from '../contracts/goalContractV2.js';
import type { BoundGoalPlanOperation, GoalCriterionRef, GoalOperationRequest, GoalPlanNodeProposal } from '../contracts/goalPlanOperation.js';
import type { GoalSuccessCriterion } from '../contracts/goalTypes.js';
import { observationIsFresh } from '../goalRunner/worldFactValidation.js';
import type { GoalPredicateEvaluator } from '../goalRunner/goalCriteriaEvaluator.js';
import type { PlanGraph } from '../planner/plannerContracts.js';
import { PlanVerifier } from '../planner/planVerifier.js';
import { stableJson } from './goalAgentJson.js';
import type { GoalAgentStateV1 } from './goalAgentState.js';
import type { GoalAgentActionCandidate } from './ports/executionPort.js';
import type { GoalPlanAuthorizationPort } from './ports/goalPlanPort.js';

export interface ResolvedGenerationOperation {
  readonly contribution: ContributionRef;
  readonly operation: PluginOperationDeclaration;
  readonly predicates: readonly GoalPredicateEvaluator[];
}

/** Exact-Generation plan and action authority. It never looks up a live or legacy registry. */
export class GoalPlanAuthority implements GoalPlanAuthorizationPort {
  constructor(private readonly options: {
    resolve(state: Readonly<GoalAgentStateV1>, ref: ContributionRef): ResolvedGenerationOperation;
    now?: () => number;
  }) {}

  inspect(state: Readonly<GoalAgentStateV1>, request: GoalOperationRequest): BoundGoalPlanOperation {
    const root = this.root(state);
    return this.bind(state, request, root.successCriteria.map(value => criterionRef(value, Date.parse(root.createdAt))));
  }

  private bind(
    state: Readonly<GoalAgentStateV1>,
    request: GoalOperationRequest,
    expectedEffects: readonly GoalCriterionRef[],
  ): BoundGoalPlanOperation {
    const root = this.root(state);
    const operation = jsonSnapshot(request);
    const limit = tuning().goalComposition.maxDraftBytes;
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('invalid_operation_limits');
    if (Buffer.byteLength(JSON.stringify(operation)) > limit) throw new Error('operation_arguments_budget_exceeded');
    const resolved = this.options.resolve(state, operation.contribution);
    if (!isDeepStrictEqual(resolved.contribution, operation.contribution)) throw new Error('operation_contribution_identity_changed');
    const allowed = new Set(resolved.predicates.map(value => `${value.id}@${value.version}`));
    const applicability = resolved.operation.applicability;
    const templateApplicable = applicability.outcomes.includes(root.intent.outcome)
      && applicability.targetKinds.includes(root.intent.target.kind)
      && applicability.taskFamilies.some(family => state.goal.signature?.compatibleTaskFamilies.includes(family));
    const satisfies = expectedEffects.filter(ref => ref.type === 'predicate'
      ? allowed.has(`${ref.predicate}@${ref.predicateVersion}`)
      : templateApplicable && applicability.criterionTypes.includes(ref.type));
    if (!satisfies.length) throw new Error(`operation_effect_unbound:${resolved.operation.operationId}`);
    const accesses = root.scope.bindings.map(binding => ({
      targetRef: binding.id,
      mode: binding.mutationAllowed ? 'modify' as const : 'observe' as const,
      ...(binding.position ? { position: structuredClone(binding.position) } : {}),
    }));
    const content = {
      operation,
      semanticsVersion: resolved.contribution.contributionVersion,
      requires: [] as GoalCriterionRef[],
      satisfies,
      accesses,
      estimatedActions: 1,
    };
    return jsonSnapshot({ ...content, contentHash: createHash('sha256').update(stableJson(content)).digest('hex') });
  }

  validatePlan(state: Readonly<GoalAgentStateV1>, input: PlanGraph, proposals: readonly GoalPlanNodeProposal[]): PlanGraph {
    const limits = tuning().goalComposition;
    if (input.nodes.length > limits.maxPlanNodes || Buffer.byteLength(JSON.stringify(input)) > limits.maxPlanBytes) {
      throw new Error('causal_plan_budget_exceeded');
    }
    const structural = new PlanVerifier().verify(input);
    if (!structural.ok) throw new Error(structural.errors.join(';'));
    if (input.edges.some(edge => edge.type !== 'requires')) throw new Error('causal_plan_requires_edges_only');
    if (proposals.length !== input.nodes.length || new Set(proposals.map(value => value.id)).size !== proposals.length) {
      throw new Error('causal_plan_proposal_mismatch');
    }
    const graph = structuredClone(input);
    for (const node of graph.nodes) {
      const proposal = proposals.find(value => value.id === node.id);
      if (!proposal?.operation) throw new Error(`plan_operation_required:${node.id}`);
      const criteria = node.goal.metadata?.structuredSuccessCriteria;
      if (!Array.isArray(criteria)) throw new Error(`plan_criteria_required:${node.id}`);
      const expectedEffects = criteria.map(value => criterionRef(value, Date.parse(this.root(state).createdAt)));
      node.causal = this.bind(state, proposal.operation, expectedEffects);
      if (proposal.requires && !sameRefs(proposal.requires, node.causal.requires)) throw new Error(`plan_requirement_claim_mismatch:${node.id}`);
      if (proposal.satisfies && !sameRefs(proposal.satisfies, node.causal.satisfies)) throw new Error(`plan_effect_claim_mismatch:${node.id}`);
      if (!sameRefs(expectedEffects, node.causal.satisfies)) {
        throw new Error(`plan_criteria_effect_mismatch:${node.id}`);
      }
      node.estimatedCost.actions = node.causal.estimatedActions;
    }
    if (graph.nodes.reduce((total, node) => total + (node.causal?.estimatedActions ?? 0), 0) > state.budget.maxActions - state.budget.actions) {
      throw new Error('causal_plan_action_budget_exceeded');
    }
    return graph;
  }

  authorize(state: Readonly<GoalAgentStateV1>, candidate: GoalAgentActionCandidate, args: Record<string, unknown>): void {
    if (!candidate.operationRef) throw new Error('composed_action_requires_registered_operation');
    const resolved = this.options.resolve(state, candidate.operationRef);
    const executorId = String(candidate.fixedArgs.behavior ?? '');
    if (candidate.kind !== 'behavior' || candidate.action !== 'invoke_behavior'
      || executorId !== resolved.contribution.contributionId) throw new Error('operation_executor_binding_mismatch');
    const active = state.plan.graph?.nodes.find(value => value.id === state.plan.activeNodeId);
    const expectedEffects = active?.causal?.satisfies
      ?? this.root(state).successCriteria.map(value => criterionRef(value, Date.parse(this.root(state).createdAt)));
    const bound = this.bind(state, { contribution: candidate.operationRef, args }, expectedEffects);
    if (state.plan.graph) {
      const node = active;
      if (!node?.causal || !['ready', 'dispatched'].includes(node.state)) throw new Error('causal_active_node_required');
      if (node.causal.contentHash !== bound.contentHash) throw new Error('action_not_bound_to_active_causal_plan');
      const blocked = state.plan.graph.edges
        .filter(edge => edge.type === 'requires' && edge.to === node.id)
        .some(edge => state.plan.graph!.nodes.find(value => value.id === edge.from)?.state !== 'satisfied');
      if (blocked) throw new Error('causal_predecessor_not_verified');
    }
    if (bound.estimatedActions > state.budget.maxActions - state.budget.actions) throw new Error('operation_action_budget_exceeded');
  }

  private root(state: Readonly<GoalAgentStateV1>): GoalContractV2 {
    if (state.rootGoal?.schema !== 'mineclaw.goal/v2') throw new Error('needs_rebind:formal_goal_required');
    if (!state.snapshotRef || !isDeepStrictEqual(state.snapshotRef, state.rootGoal.source.snapshot)) throw new Error('needs_rebind:goal_snapshot_changed');
    const world = state.world.latest;
    if (!world || world.environment.dimension !== state.rootGoal.scope.dimension
      || !observationIsFresh(world.timestamp, this.options.now?.() ?? Date.now(), tuning().goalEvidence.maxWorldAgeMs)) {
      throw new Error('causal_plan_requires_fresh_bound_world');
    }
    return state.rootGoal;
  }
}

function criterionRef(raw: unknown, baseline: number): GoalCriterionRef {
  const value = raw as GoalSuccessCriterion;
  if (!value?.type || value.since !== undefined && value.since !== baseline) throw new Error('goal_plan_criterion_invalid');
  if (value.type === 'predicate' && (!value.predicate || !value.predicateVersion || !value.args)) throw new Error('goal_plan_predicate_invalid');
  const { since: _since, ...ref } = value;
  return ref;
}

function hasRef(values: readonly GoalCriterionRef[], ref: GoalCriterionRef): boolean {
  return values.some(value => stableJson(value) === stableJson(ref));
}

function sameRefs(left: readonly GoalCriterionRef[], right: readonly GoalCriterionRef[]): boolean {
  return left.length === right.length && left.every(ref => hasRef(right, ref));
}
