import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { jsonSnapshot } from '../../infra/jsonSnapshot.js';
import type { CapabilityPackageSnapshot } from '../../capabilities/types.js';
import { validateClosedArguments } from '../../infra/closedJsonSchema.js';
import { tuning } from '../../infra/tuning.js';
import type { GoalContractV2 } from '../contracts/goalContractV2.js';
import type { GoalScopeBinding, PredicateRef } from '../contracts/goalDraft.js';
import type { BoundGoalPlanOperation, GoalOperationRequest, GoalPlanNodeProposal } from '../contracts/goalPlanOperation.js';
import type { GoalSuccessCriterion } from '../contracts/goalTypes.js';
import type { FactRegion } from '../contracts/worldFact.js';
import type { GoalPredicateEvaluator } from '../goalRunner/goalCriteriaEvaluator.js';
import { evaluateRegisteredPredicate, validatePredicateArguments } from '../goalRunner/goalPredicateEvaluation.js';
import { isFactRegion, observationIsFresh } from '../goalRunner/worldFactValidation.js';
import type { PlanGraph } from '../planner/plannerContracts.js';
import { PlanVerifier } from '../planner/planVerifier.js';
import { stableJson } from './goalAgentJson.js';
import type { GoalAgentStateV1 } from './goalAgentState.js';
import type { GoalAgentActionCandidate } from './ports/executionPort.js';
import type { GoalPlanAuthorizationPort } from './ports/goalPlanPort.js';

/** Verifies a proposed causal chain; does not search, invent recipes or execute actions. */
export class GoalPlanAuthority implements GoalPlanAuthorizationPort {
  constructor(private readonly options: {
    snapshot: () => Pick<CapabilityPackageSnapshot, 'operations' | 'operationSemantics' | 'predicateEvaluators'>;
    bindings: (state: Readonly<GoalAgentStateV1>) => readonly GoalScopeBinding[];
    now?: () => number;
  }) {}

  inspect(state: Readonly<GoalAgentStateV1>, request: GoalOperationRequest): BoundGoalPlanOperation {
    const root = this.root(state);
    const operation = jsonSnapshot(request);
    const limits = tuning().goalComposition;
    if (![limits.maxPredicates, limits.maxDraftBytes].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error('invalid_operation_limits');
    if (Buffer.byteLength(JSON.stringify(operation)) > limits.maxDraftBytes) throw new Error('operation_arguments_budget_exceeded');
    validateClosedArguments(operation, { type: 'object', additionalProperties: false, required: ['id', 'version', 'args'], properties: {
      id: { type: 'string', minLength: 1 }, version: { type: 'integer', minimum: 1 }, args: { type: 'object' },
    } }, operation);
    const snapshot = this.options.snapshot();
    const entries = snapshot.operations.filter(value => value.definition.id === operation.id && value.packageVersion === operation.version);
    const resolvers = snapshot.operationSemantics.filter(value => value.operationId === operation.id);
    if (entries.length !== 1 || resolvers.length !== 1) throw new Error(`operation_semantics_unavailable:${operation.id}@${operation.version}`);
    const definition = entries[0]!.definition, resolver = resolvers[0]!;
    validateClosedArguments(operation.args, definition.inputSchema);
    const resolved = jsonSnapshot(resolver.resolve({ args: operation.args, state }));
    if (!Number.isSafeInteger(resolved.estimatedActions) || resolved.estimatedActions < 1) throw new Error('operation_action_cost_invalid');
    const requires = this.refs(resolved.requires), satisfies = this.refs(resolved.satisfies);
    if (!satisfies.length || !Array.isArray(resolved.accesses) || !resolved.accesses.length) throw new Error('operation_effect_or_scope_missing');
    for (const ref of requires) if (!definition.preconditions.some(value => value.id === ref.id)) throw new Error(`undeclared_operation_precondition:${ref.id}`);
    for (const ref of satisfies) if (!definition.effects.some(value => value.id === ref.id)) throw new Error(`undeclared_operation_effect:${ref.id}`);
    this.checkAccesses(state, root, resolved.accesses);
    const content = { operation, semanticsVersion: resolver.version, requires, satisfies,
      accesses: resolved.accesses, estimatedActions: resolved.estimatedActions };
    return jsonSnapshot({ ...content, contentHash: createHash('sha256').update(stableJson(content)).digest('hex') });
  }

  validatePlan(state: Readonly<GoalAgentStateV1>, input: PlanGraph, proposals: readonly GoalPlanNodeProposal[]): PlanGraph {
    const root = this.root(state), limits = tuning().goalComposition;
    for (const limit of [limits.maxPlanNodes, limits.maxPlanDepth, limits.maxPlanBytes]) if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('invalid_causal_plan_limits');
    if (input.nodes.length > limits.maxPlanNodes || Buffer.byteLength(JSON.stringify(input)) > limits.maxPlanBytes) throw new Error('causal_plan_budget_exceeded');
    const structural = new PlanVerifier().verify(input);
    if (!structural.ok) throw new Error(structural.errors.join(';'));
    if (input.edges.some(edge => edge.type !== 'requires')) throw new Error('causal_plan_requires_edges_only');
    if (proposals.length !== input.nodes.length || new Set(proposals.map(value => value.id)).size !== proposals.length) throw new Error('causal_plan_proposal_mismatch');
    const graph = structuredClone(input);
    const ancestors = new Map<string, Set<string>>(), depths = new Map<string, number>();
    const collect = (id: string): Set<string> => {
      if (ancestors.has(id)) return ancestors.get(id)!;
      const set = new Set<string>(); let depth = 1;
      for (const edge of graph.edges.filter(value => value.to === id)) {
        set.add(edge.from); for (const ancestor of collect(edge.from)) set.add(ancestor);
        depth = Math.max(depth, depths.get(edge.from)! + 1);
      }
      if (depth > limits.maxPlanDepth) throw new Error(`causal_plan_depth_exceeded:${id}`);
      ancestors.set(id, set); depths.set(id, depth); return set;
    };
    for (const node of graph.nodes) {
      collect(node.id);
      const proposal = proposals.find(value => value.id === node.id);
      if (!proposal?.operation) throw new Error(`plan_operation_required:${node.id}`);
      node.causal = this.inspect(state, proposal.operation);
      if (!sameRefs(this.refs(proposal.requires), node.causal.requires) || !sameRefs(this.refs(proposal.satisfies), node.causal.satisfies)) {
        throw new Error(`plan_effect_claim_mismatch:${node.id}`);
      }
      const criteria = node.goal.metadata?.structuredSuccessCriteria;
      if (!Array.isArray(criteria) || !sameRefs(criteria.map(value => criterionRef(value, Date.parse(root.createdAt))), node.causal.satisfies)) {
        throw new Error(`plan_criteria_effect_mismatch:${node.id}`);
      }
      const verifiedCriteria = node.causal.satisfies.map(ref => criterion(ref, root));
      node.goal.metadata = { ...node.goal.metadata, structuredSuccessCriteria: verifiedCriteria };
      node.goal.successCriteria = verifiedCriteria.map(stableJson); node.postconditions = [...node.goal.successCriteria];
      node.estimatedCost.actions = node.causal.estimatedActions;
    }
    if (graph.nodes.reduce((total, node) => total + node.causal!.estimatedActions, 0) > state.budget.maxActions - state.budget.actions) throw new Error('causal_plan_action_budget_exceeded');
    // Trace backwards only through real required effects, not arbitrary declared dependency edges.
    const used = new Set<string>();
    const use = (id: string) => {
      if (used.has(id)) return; used.add(id);
      const node = graph.nodes.find(value => value.id === id)!;
      for (const ref of node.causal!.requires) {
        const producers = graph.nodes.filter(value => ancestors.get(id)!.has(value.id) && hasRef(value.causal!.satisfies, ref));
        if (producers.length > 1) throw new Error(`ambiguous_precondition_producer:${id}:${ref.id}`);
        if (producers.length) use(producers[0]!.id);
        else this.requireSatisfied(state, ref, id);
      }
    };
    for (const goal of root.successCriteria) {
      const ref = criterionRef(goal, Date.parse(root.createdAt));
      const producers = graph.nodes.filter(node => hasRef(node.causal!.satisfies, ref));
      if (producers.length !== 1) throw new Error(`root_effect_missing_or_ambiguous:${ref.id}`);
      use(producers[0]!.id);
    }
    for (const node of graph.nodes) if (!used.has(node.id)) throw new Error(`unrelated_plan_node:${node.id}`);
    if (Buffer.byteLength(JSON.stringify(graph)) > limits.maxPlanBytes) throw new Error('bound_causal_plan_budget_exceeded');
    return graph;
  }

  authorize(state: Readonly<GoalAgentStateV1>, candidate: GoalAgentActionCandidate, args: Record<string, unknown>): void {
    const root = this.root(state);
    if (!candidate.operationRef) throw new Error('composed_action_requires_registered_operation');
    const operation = this.inspect(state, { ...candidate.operationRef, args });
    const definition = this.options.snapshot().operations.find(value => value.definition.id === operation.operation.id)!.definition;
    const executor = definition.executorRef;
    const executorId = candidate.kind === 'behavior' ? candidate.fixedArgs.behavior
      : candidate.kind === 'task' ? candidate.fixedArgs.taskKind
        : candidate.kind === 'strategy' ? candidate.fixedArgs.strategyId : candidate.action;
    if (candidate.kind !== executor.kind || executorId !== executor.id) throw new Error('operation_executor_binding_mismatch');
    if (state.plan.graph) {
      const node = state.plan.graph.nodes.find(value => value.id === state.plan.activeNodeId);
      if (!node?.causal || !['ready', 'dispatched'].includes(node.state)) throw new Error('causal_active_node_required');
      if (node.causal.contentHash !== operation.contentHash) throw new Error('action_not_bound_to_active_causal_plan');
      const predecessors = state.plan.graph.edges.filter(edge => edge.type === 'requires' && edge.to === node.id);
      if (predecessors.some(edge => state.plan.graph!.nodes.find(value => value.id === edge.from)?.state !== 'satisfied')) throw new Error('causal_predecessor_not_verified');
    } else {
      if (!sameRefs(root.successCriteria.map(value => criterionRef(value, Date.parse(root.createdAt))), operation.satisfies)) {
        throw new Error('intermediate_action_requires_causal_plan');
      }
    }
    if (operation.estimatedActions > state.budget.maxActions - state.budget.actions) throw new Error('operation_action_budget_exceeded');
    for (const ref of operation.requires) this.requireSatisfied(state, ref, state.plan.activeNodeId ?? 'root');
  }

  private root(state: Readonly<GoalAgentStateV1>): GoalContractV2 {
    if (state.rootGoal?.schema !== 'mineclaw.goal/v2') throw new Error('composed_root_required');
    const world = state.world.latest;
    if (!world || world.environment.dimension !== state.rootGoal.scope.dimension
      || !observationIsFresh(world.timestamp, this.now(), tuning().goalEvidence.maxWorldAgeMs)) throw new Error('causal_plan_requires_fresh_bound_world');
    return state.rootGoal;
  }

  private refs(value: unknown): PredicateRef[] {
    if (!Array.isArray(value) || value.length > tuning().goalComposition.maxPredicates) throw new Error('invalid_operation_predicates');
    const predicates = this.options.snapshot().predicateEvaluators;
    const refs = value.map(raw => {
      const ref = jsonSnapshot(raw) as PredicateRef;
      if (!ref || Object.keys(ref).some(key => !['id', 'version', 'args'].includes(key))) throw new Error('invalid_predicate_ref');
      const matches = predicates.filter(entry => entry.id === ref.id);
      if (matches.length !== 1) throw new Error(`predicate_not_registered:${ref.id}`);
      validatePredicateArguments({ type: 'predicate', predicate: ref.id, predicateVersion: ref.version, args: ref.args }, matches[0]!);
      return ref;
    });
    if (new Set(refs.map(stableJson)).size !== refs.length) throw new Error('duplicate_operation_predicate');
    return refs.sort((a, b) => stableJson(a).localeCompare(stableJson(b)));
  }

  private checkAccesses(state: Readonly<GoalAgentStateV1>, root: GoalContractV2, accesses: BoundGoalPlanOperation['accesses']): void {
    const fresh = this.options.bindings(state);
    if (new Set(fresh.map(value => value.id)).size !== fresh.length) throw new Error('goal_binding_identity_conflict');
    for (const access of accesses) {
      if (!['observe', 'use', 'modify'].includes(access.mode) || Object.keys(access).some(key => !['targetRef', 'mode', 'position'].includes(key))) throw new Error('invalid_operation_access');
      const binding = root.scope.bindings.find(value => value.id === access.targetRef);
      const current = fresh.find(value => value.id === access.targetRef);
      if (!binding || !current || !root.scope.targetRefs.includes(binding.id)) throw new Error(`operation_target_not_authorized:${access.targetRef}`);
      if (!isDeepStrictEqual(bindingIdentity(binding), bindingIdentity(current))) throw new Error(`operation_target_binding_changed:${binding.id}`);
      const allowed = binding.allowedAccess ?? (binding.mutationAllowed ? ['observe', 'modify'] : ['observe']);
      if (!allowed.includes(access.mode)) throw new Error(`operation_access_not_authorized:${binding.id}:${access.mode}`);
      if (binding.kind === 'container' && !binding.position) throw new Error(`container_position_unbound:${binding.id}`);
      if (access.position && (!finitePosition(access.position)
        || (binding.position ? !isDeepStrictEqual(access.position, binding.position) : !inRegion(access.position, binding.region)))) throw new Error(`operation_position_outside_binding:${binding.id}`);
      if (access.mode === 'modify' && (!binding.mutationAllowed || !isFactRegion(binding.region)
        || !inRegion(binding.region.min, root.scope.allowedMutationRegion) || !inRegion(binding.region.max, root.scope.allowedMutationRegion))) throw new Error(`operation_mutation_outside_scope:${binding.id}`);
    }
  }

  private requireSatisfied(state: Readonly<GoalAgentStateV1>, ref: PredicateRef, nodeId: string): void {
    const result = evaluateRegisteredPredicate(criterion(ref, state.rootGoal as GoalContractV2), state.world.latest!, {
      now: this.now(), predicateEvaluators: this.options.snapshot().predicateEvaluators as readonly GoalPredicateEvaluator[],
    });
    if (result.status !== 'satisfied') throw new Error(`operation_precondition_${result.status}:${nodeId}:${ref.id}:${result.detail}`);
  }

  private now(): number { return this.options.now?.() ?? Date.now(); }
}

function criterion(ref: PredicateRef, root: GoalContractV2): GoalSuccessCriterion {
  return { type: 'predicate', predicate: ref.id, predicateVersion: ref.version, args: ref.args, since: Date.parse(root.createdAt) };
}

function criterionRef(raw: unknown, baseline: number): PredicateRef {
  const value = raw as GoalSuccessCriterion;
  if (!value || value.type !== 'predicate' || !value.predicate || !value.predicateVersion || !value.args
    || Object.keys(value).some(key => !['type', 'predicate', 'predicateVersion', 'args', 'since'].includes(key))
    || (value.since !== undefined && value.since !== baseline)) throw new Error('composed_plan_criterion_invalid');
  return { id: value.predicate, version: value.predicateVersion, args: value.args };
}

function hasRef(values: readonly PredicateRef[], ref: PredicateRef): boolean { return values.some(value => stableJson(value) === stableJson(ref)); }
function sameRefs(a: readonly PredicateRef[], b: readonly PredicateRef[]): boolean { return a.length === b.length && a.every(ref => hasRef(b, ref)); }
function bindingIdentity({ summary: _summary, evidenceRefs: _evidence, ...binding }: GoalScopeBinding): unknown { return binding; }
function finitePosition(value: { x: number; y: number; z: number }): boolean { return ['x', 'y', 'z'].every(key => Number.isFinite(value[key as 'x'])); }
function inRegion(position: { x: number; y: number; z: number }, region: FactRegion | undefined): boolean {
  return isFactRegion(region) && ['x', 'y', 'z'].every(key => position[key as 'x'] >= region.min[key as 'x'] && position[key as 'x'] <= region.max[key as 'x']);
}
