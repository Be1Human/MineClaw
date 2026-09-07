import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { jsonSnapshot } from '../../infra/jsonSnapshot.js';
import { validateClosedArguments } from '../../infra/closedJsonSchema.js';
import { tuning } from '../../infra/tuning.js';
import type { ContributionRef } from '../../plugin-sdk/identity.js';
import { GOAL_DRAFT_SCHEMA, type GoalDraft, type GoalScopeBinding, type PredicateRef } from '../contracts/goalDraft.js';
import { freezeGoalContractV2, type GoalContractV2 } from '../contracts/goalContractV2.js';
import type { GoalSuccessCriterion } from '../contracts/goalTypes.js';
import type { CommittedAgentGoal, GoalSignature } from '../planner/plannerContracts.js';
import type { GoalPredicateEvaluator } from '../goalRunner/goalCriteriaEvaluator.js';
import { validatePredicateArguments } from '../goalRunner/goalPredicateEvaluation.js';
import { isFactRegion, observationIsFresh } from '../goalRunner/worldFactValidation.js';
import type { GoalCompilationPort, GoalCompilerInput } from './ports/goalCompilerPort.js';
import type { GoalAgentStateV1 } from './goalAgentState.js';
import { stableJson } from './goalAgentJson.js';

interface NormalizedGoal {
  readonly goal: CommittedAgentGoal;
  readonly criteria: GoalSuccessCriterion[];
  readonly bindings: GoalScopeBinding[];
  readonly region?: import('../contracts/worldFact.js').FactRegion;
  readonly contributions: ContributionRef[];
  readonly compatibleTaskFamilies: readonly string[];
}

/**
 * The only compiler for executable Goals. Template metadata and free drafts are
 * input adapters; both leave this class as the same immutable GoalContractV2.
 * It is pure with respect to the game: compilation reads a pinned observation
 * and Registry snapshot, but never plans or submits a body operation.
 */
export class GoalCompiler implements GoalCompilationPort {
  constructor(private readonly options: {
    predicates: (state: Readonly<GoalAgentStateV1>) => readonly GoalPredicateEvaluator[];
    bindings: (state: Readonly<GoalAgentStateV1>) => Promise<readonly GoalScopeBinding[]> | readonly GoalScopeBinding[];
  }) {}

  async bindings(state: Readonly<GoalAgentStateV1>): Promise<readonly GoalScopeBinding[]> {
    this.requireSnapshot(state);
    const bindings = jsonSnapshot(await this.options.bindings(state));
    if (new Set(bindings.map(binding => binding.id)).size !== bindings.length) throw new Error('goal_binding_identity_conflict');
    return bindings;
  }

  async compile(request: Parameters<GoalCompilationPort['compile']>[0]): Promise<{
    rootGoal: GoalContractV2;
    goal: CommittedAgentGoal;
    signature: GoalSignature;
  }> {
    if (request.state.rootGoal) throw new Error('root_goal_already_committed');
    const snapshot = this.requireSnapshot(request.state);
    const limits = tuning().goalComposition;
    if ([limits.maxPredicates, limits.maxTargets, limits.maxRegionVolume, limits.maxDraftBytes].some(value => !Number.isSafeInteger(value) || value < 1)) {
      throw new Error('invalid_goal_composition_limits');
    }
    const now = Date.parse(request.acceptedAt);
    if (!Number.isFinite(now)) throw new Error('goal_clock_invalid');
    const world = request.state.world.latest;
    if (!world || !observationIsFresh(world.timestamp, now, tuning().goalEvidence.maxWorldAgeMs)) throw new Error('goal_requires_fresh_world');
    const normalized = request.input.kind === 'draft'
      ? await this.normalizeDraft(request.input, request.state, now)
      : await this.normalizeTemplate(request.input, request.state, now);
    if (normalized.bindings.length > limits.maxTargets || normalized.criteria.length > limits.maxPredicates) throw new Error('goal_draft_cardinality_limit');
    if (normalized.region && regionVolume(normalized.region) > limits.maxRegionVolume) throw new Error('goal_mutation_region_limit');
    const contributions = uniqueContributions(normalized.contributions);
    const rootGoal = freezeGoalContractV2({
      schema: 'mineclaw.goal/v2', goalId: request.goalId, profileId: request.profileId,
      goalText: request.state.request.requestText, requestRef: request.state.requestId,
      intent: { outcome: normalized.goal.outcome, target: normalized.goal.target },
      source: { snapshot, contributions }, successCriteria: normalized.criteria,
      scope: {
        dimension: world.environment.dimension,
        targetRefs: normalized.bindings.map(binding => binding.id).sort(),
        bindings: normalized.bindings,
        ...(normalized.region ? { allowedMutationRegion: normalized.region } : {}),
      },
      constraints: normalized.goal.constraints.map(value => ({ type: 'natural_language' as const, value })),
      createdAt: request.acceptedAt,
    });
    const semanticHash = createHash('sha256').update(stableJson({
      intent: rootGoal.intent,
      criteria: rootGoal.successCriteria.map(({ since: _baseline, ...criterion }) => criterion),
      scope: { ...rootGoal.scope, bindings: rootGoal.scope.bindings.map(({ evidenceRefs: _evidence, summary: _summary, ...binding }) => binding) },
      constraints: rootGoal.constraints,
      source: rootGoal.source,
    })).digest('hex');
    const signature: GoalSignature = Object.freeze({
      key: `${normalized.goal.outcome}:${normalized.goal.target.kind}:${normalized.goal.target.registryId}:${normalized.goal.target.quantity}:${semanticHash}`,
      outcome: normalized.goal.outcome,
      targetKind: normalized.goal.target.kind,
      targetId: normalized.goal.target.registryId,
      quantity: normalized.goal.target.quantity,
      constraintsHash: semanticHash,
      compatibleTaskFamilies: Object.freeze([...normalized.compatibleTaskFamilies]),
      schemaVersion: 2,
    });
    return { rootGoal, goal: jsonSnapshot(normalized.goal), signature };
  }

  private async normalizeDraft(input: Extract<GoalCompilerInput, { kind: 'draft' }>, state: Readonly<GoalAgentStateV1>, now: number): Promise<NormalizedGoal> {
    const limits = tuning().goalComposition;
    const raw = jsonSnapshot(input.draft);
    if (Buffer.byteLength(JSON.stringify(raw)) > limits.maxDraftBytes) throw new Error('goal_draft_size_limit');
    validateClosedArguments(raw, GOAL_DRAFT_SCHEMA, raw);
    const draft = raw as GoalDraft;
    if (draft.requestRef !== state.requestId) throw new Error('goal_request_ref_mismatch');
    if (state.world.latest!.environment.dimension !== draft.scope.dimension) throw new Error('goal_scope_dimension_mismatch');
    const available = await this.bindings(state), refs = new Set(draft.scope.targetRefs);
    if (refs.size !== draft.scope.targetRefs.length) throw new Error('duplicate_goal_target_ref');
    const bindings = draft.scope.targetRefs.map(ref => {
      const binding = available.find(value => value.id === ref);
      if (!binding || binding.dimension !== draft.scope.dimension || !binding.version || !binding.evidenceRefs.length) throw new Error(`needs_owner_scope:${ref}`);
      return binding;
    }).sort((a, b) => a.id.localeCompare(b.id));
    if (available.some(binding => binding.required && !refs.has(binding.id))) throw new Error('required_goal_target_omitted');
    const region = mutationRegion(bindings, draft.scope.allowedMutationRegion);
    const predicates = this.options.predicates(state);
    const boundPredicates = new Set(bindings.flatMap(binding => binding.requiredPredicates.map(stableJson)));
    const criteria = draft.success.allOf.map(ref => this.bindPredicate(ref, predicates, bindings, boundPredicates, now));
    assertUniqueCriteria(criteria);
    for (const binding of bindings) for (const required of binding.requiredPredicates) {
      if (!draft.success.allOf.some(ref => stableJson(ref) === stableJson(required))) throw new Error(`required_bound_predicate_missing:${binding.id}:${required.id}`);
    }
    const semantics = stableJson({ criteria: criteria.map(({ since: _since, ...criterion }) => criterion), bindings });
    const targetId = `composed:${createHash('sha256').update(semantics).digest('hex')}`;
    const goal: CommittedAgentGoal = {
      requestId: state.requestId, objective: state.request.requestText, outcome: 'composed',
      target: { kind: 'state', surface: state.request.requestText, registryId: targetId, quantity: 1 },
      constraints: [...state.request.constraints], successCriteria: structuredClone(criteria) as unknown as Record<string, unknown>[],
    };
    return {
      goal, criteria, bindings, ...(region ? { region } : {}), compatibleTaskFamilies: ['composed'],
      contributions: [...bindings.map(binding => binding.contribution), ...criteria.map(criterion => predicateContribution(criterion, predicates))],
    };
  }

  private async normalizeTemplate(input: Extract<GoalCompilerInput, { kind: 'template' }>, state: Readonly<GoalAgentStateV1>, now: number): Promise<NormalizedGoal> {
    if (!outcomeSupportsKind(input.goal.outcome, input.target.kind)) throw new Error(`goal_outcome_incompatible:${input.goal.outcome}:${input.target.kind}`);
    const criteria = templateCriteria(input.goal, input.target.successCriteriaPolicy, input.target.successCriteria, input.arguments, now);
    const predicates = this.options.predicates(state);
    const predicateCriteria = criteria.filter((criterion): criterion is GoalSuccessCriterion & { predicate: string; predicateVersion: string; args: Readonly<Record<string, unknown>> } => criterion.type === 'predicate');
    for (const criterion of predicateCriteria) {
      const evaluator = predicates.find(value => value.id === criterion.predicate && value.version === criterion.predicateVersion);
      if (!evaluator) throw new Error(`missing_or_ambiguous_predicate:${criterion.predicate}`);
      validatePredicateArguments(criterion, evaluator);
    }
    assertUniqueCriteria(criteria);
    const availableBindings = input.target.bindingContributionId ? await this.bindings(state) : [];
    const domainBindings = input.target.bindingContributionId
      ? availableBindings.filter(value => value.contribution.contributionId === input.target.bindingContributionId)
      : [];
    if (input.target.bindingContributionId && domainBindings.length !== 1) {
      throw new Error(domainBindings.length === 0
        ? `needs_owner_scope:${input.target.bindingContributionId}`
        : `ambiguous_goal_scope:${input.target.bindingContributionId}`);
    }
    const binding = domainBindings[0] ?? templateBinding(input, state, criteria);
    return {
      goal: { ...input.goal, successCriteria: structuredClone(criteria) as unknown as Record<string, unknown>[] },
      criteria, bindings: [binding], ...(binding.region ? { region: binding.region } : {}),
      compatibleTaskFamilies: input.target.taskFamilies,
      contributions: [input.target.contribution, binding.contribution, ...predicateCriteria.map(criterion => predicateContribution(criterion, predicates))],
    };
  }

  private bindPredicate(ref: PredicateRef, predicates: readonly GoalPredicateEvaluator[], bindings: readonly GoalScopeBinding[], authorized: ReadonlySet<string>, now: number): GoalSuccessCriterion {
    const matches = predicates.filter(value => value.id === ref.id && value.version === ref.version);
    if (matches.length !== 1) throw new Error(`missing_or_ambiguous_predicate:${ref.id}`);
    const criterion: GoalSuccessCriterion = { type: 'predicate', predicate: ref.id, predicateVersion: ref.version, args: ref.args, since: now };
    validatePredicateArguments(criterion, matches[0]!);
    if (!authorized.has(stableJson(ref)) && matches[0]!.authorizeGoal?.({ criterion, bindings }) !== true) {
      throw new Error(`predicate_not_authorized_for_bound_targets:${ref.id}`);
    }
    return criterion;
  }

  private requireSnapshot(state: Readonly<GoalAgentStateV1>) {
    if (!state.snapshotRef) throw new Error('needs_rebind:goal_snapshot_missing');
    return jsonSnapshot(state.snapshotRef);
  }
}

function templateCriteria(
  goal: Omit<CommittedAgentGoal, 'successCriteria'>,
  policy: 'fallback' | 'authoritative' | undefined,
  templates: readonly import('../../knowledge/goalTargetKnowledge.js').GoalTargetCriterionTemplate[] | undefined,
  args: Readonly<Record<string, unknown>>,
  now: number,
): GoalSuccessCriterion[] {
  let criteria: Array<Record<string, unknown>>;
  const item = goal.target.registryId.replace(/^minecraft:/, '');
  if (policy === 'authoritative') {
    if (!templates?.length) throw new Error(`authoritative_target_without_criteria:${goal.target.registryId}`);
    criteria = materialize(templates, item, goal.target.quantity);
  } else if (goal.outcome === 'deliver' && goal.target.kind === 'item') criteria = [{ type: 'item_delivered', item, count: goal.target.quantity }];
  else if (goal.outcome === 'deposit' && goal.target.kind === 'item') criteria = [{ type: 'item_deposited', item, count: goal.target.quantity }];
  else if (goal.outcome === 'obtain' && goal.target.kind === 'item') criteria = [{ type: 'inventory', item, count: goal.target.quantity }];
  else if (goal.outcome === 'place' && goal.target.kind === 'item') {
    const placement = record(args.placement), relativeTo = String(placement.relativeTo ?? ''), rawRelation = String(placement.relation ?? '');
    const relation = rawRelation === 'underfoot' ? 'near' : rawRelation;
    const radius = typeof placement.radius === 'number' && Number.isFinite(placement.radius) ? Math.max(0.1, placement.radius) : 1.5;
    if (!['owner', 'self'].includes(relativeTo) || !['near', 'right', 'front', 'at'].includes(relation)) throw new Error('place_goal_requires_bounded_placement');
    criteria = [{ type: 'block_placed', item, count: goal.target.quantity, relativeTo, relation, radius }];
  } else if (templates?.length) criteria = materialize(templates, item, goal.target.quantity);
  else throw new Error(`goal_has_no_machine_criterion:${goal.outcome}:${goal.target.registryId}`);
  return criteria.map(value => {
    const criterion = value as unknown as GoalSuccessCriterion;
    return ['item_delivered', 'item_deposited', 'block_placed', 'predicate'].includes(criterion.type) && criterion.since === undefined
      ? { ...criterion, since: now }
      : criterion;
  });
}

function templateBinding(input: Extract<GoalCompilerInput, { kind: 'template' }>, state: Readonly<GoalAgentStateV1>, criteria: readonly GoalSuccessCriterion[]): GoalScopeBinding {
  const world = state.world.latest!;
  const placement = criteria.find(value => value.type === 'block_placed');
  const entity = criteria.find(value => value.type === 'entity_dead');
  const reached = criteria.find(value => value.type === 'reached');
  const reference = placement?.relativeTo === 'owner' || reached?.relativeTo === 'owner' ? world.owner?.position : world.self.position;
  if ((placement || reached?.relativeTo === 'owner') && !reference) throw new Error('needs_owner_scope:owner_position');
  const targetEntity = entity ? world.entities.find(value => entity.entityId ? String(value.id) === entity.entityId : value.name === entity.entityName) : undefined;
  if (entity && !targetEntity) throw new Error('needs_owner_scope:target_entity');
  const radius = Math.ceil(placement?.radius ?? 0);
  const region = placement && reference ? {
    min: { x: Math.floor(reference.x) - radius, y: Math.floor(reference.y) - 1, z: Math.floor(reference.z) - radius },
    max: { x: Math.floor(reference.x) + radius, y: Math.floor(reference.y) + 1, z: Math.floor(reference.z) + radius },
  } : undefined;
  const position = targetEntity?.position ?? reference ?? world.self.position;
  return {
    contribution: input.target.contribution,
    id: `target:${input.target.registryId}`,
    version: input.target.contribution.contributionVersion,
    kind: region ? 'region' : targetEntity ? 'entity' : input.target.kind === 'item' ? 'item' : 'self',
    summary: `compiled target ${input.target.registryId}`,
    dimension: world.environment.dimension,
    registryId: input.target.registryId,
    position,
    ...(region ? { region } : {}),
    mutationAllowed: Boolean(region),
    allowedAccess: region ? ['observe', 'use', 'modify'] : ['observe', 'use'],
    required: true,
    requiredPredicates: criteria.filter(value => value.type === 'predicate').map(value => ({ id: value.predicate!, version: value.predicateVersion!, args: value.args! })),
    evidenceRefs: [`world:${world.tick}:${world.timestamp}`, `contribution:${input.target.contribution.contributionId}@${input.target.contribution.contributionVersion}`],
  };
}

function mutationRegion(bindings: readonly GoalScopeBinding[], requested: import('../contracts/worldFact.js').FactRegion | undefined) {
  const mutable = bindings.filter(binding => binding.mutationAllowed).map(binding => binding.region);
  if (mutable.some(region => !isFactRegion(region))) throw new Error('goal_mutation_binding_unbounded');
  const region = mutable[0];
  if (mutable.some(value => !isDeepStrictEqual(value, region))) throw new Error('multiple_mutation_regions_not_supported');
  if (requested && !isDeepStrictEqual(requested, region)) throw new Error('goal_mutation_scope_changed');
  return region;
}

function predicateContribution(criterion: GoalSuccessCriterion, predicates: readonly GoalPredicateEvaluator[]): ContributionRef {
  const match = predicates.find(value => value.id === criterion.predicate && value.version === criterion.predicateVersion);
  if (!match) throw new Error(`missing_or_ambiguous_predicate:${criterion.predicate ?? ''}`);
  return match.contribution;
}

function uniqueContributions(values: readonly ContributionRef[]): ContributionRef[] {
  const result = new Map<string, ContributionRef>();
  for (const ref of values) result.set(stableJson(ref), jsonSnapshot(ref));
  return [...result.values()].sort((left, right) => stableJson(left).localeCompare(stableJson(right)));
}

function assertUniqueCriteria(criteria: readonly GoalSuccessCriterion[]): void {
  const keys = criteria.map(value => stableJson(value));
  if (new Set(keys).size !== keys.length) throw new Error('duplicate_goal_predicate');
}

function materialize(templates: readonly import('../../knowledge/goalTargetKnowledge.js').GoalTargetCriterionTemplate[], item: string, quantity: number): Array<Record<string, unknown>> {
  return templates.map(template => JSON.parse(JSON.stringify(template), (_key, value) => value === '$quantity' || value === '$count' ? quantity : value === '$item' ? item : value) as Record<string, unknown>);
}

function outcomeSupportsKind(outcome: CommittedAgentGoal['outcome'], kind: CommittedAgentGoal['target']['kind']): boolean {
  if (kind === 'item') return ['obtain', 'deliver', 'deposit', 'place'].includes(outcome);
  if (kind === 'entity') return outcome === 'defeat';
  if (kind === 'location') return outcome === 'reach';
  if (kind === 'structure') return outcome === 'build';
  return outcome === 'explore' || outcome === 'survive' || outcome === 'composed';
}

function regionVolume(region: import('../contracts/worldFact.js').FactRegion): number {
  return (region.max.x - region.min.x + 1) * (region.max.y - region.min.y + 1) * (region.max.z - region.min.z + 1);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
