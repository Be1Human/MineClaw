import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { jsonSnapshot } from '../../infra/jsonSnapshot.js';
import { validateClosedArguments } from '../../infra/closedJsonSchema.js';
import { tuning } from '../../infra/tuning.js';
import { GOAL_DRAFT_SCHEMA, type GoalDraft, type GoalScopeBinding } from '../contracts/goalDraft.js';
import { freezeGoalContractV2 } from '../contracts/goalContractV2.js';
import type { GoalPredicateEvaluator } from '../goalRunner/goalCriteriaEvaluator.js';
import { validatePredicateArguments } from '../goalRunner/goalPredicateEvaluation.js';
import { isFactRegion, observationIsFresh } from '../goalRunner/worldFactValidation.js';
import type { GoalDraftCompilationPort } from './ports/goalDraftPort.js';
import type { GoalAgentStateV1 } from './goalAgentState.js';
import type { GoalSuccessCriterion } from '../contracts/goalTypes.js';
import { stableJson } from './goalAgentJson.js';

/** Deterministic contract compiler. It neither searches for a plan nor executes a game action. */
export class GoalDraftCompiler implements GoalDraftCompilationPort {
  constructor(private readonly options: {
    predicates: () => readonly GoalPredicateEvaluator[];
    bindings: (state: Readonly<GoalAgentStateV1>) => readonly GoalScopeBinding[];
  }) {}

  bindings(state: Readonly<GoalAgentStateV1>): readonly GoalScopeBinding[] {
    const bindings = jsonSnapshot(this.options.bindings(state));
    if (new Set(bindings.map(binding => binding.id)).size !== bindings.length) throw new Error('goal_binding_identity_conflict');
    return bindings;
  }

  compile(input: Parameters<GoalDraftCompilationPort['compile']>[0]): ReturnType<GoalDraftCompilationPort['compile']> {
    if (input.state.rootGoal) throw new Error('root_goal_already_committed');
    const limits = tuning().goalComposition;
    if (limits.enabled !== true) throw new Error('composed_goals_disabled');
    if ([limits.maxPredicates, limits.maxTargets, limits.maxRegionVolume, limits.maxDraftBytes].some(value => !Number.isSafeInteger(value) || value < 1)) {
      throw new Error('invalid_goal_composition_limits');
    }
    const raw = jsonSnapshot(input.draft);
    if (Buffer.byteLength(JSON.stringify(raw)) > limits.maxDraftBytes) throw new Error('goal_draft_size_limit');
    // Opaque predicate args are independently validated below by the registered predicate's closed schema.
    validateClosedArguments(raw, GOAL_DRAFT_SCHEMA, raw);
    const draft = raw as GoalDraft;
    if (draft.requestRef !== input.state.requestId) throw new Error('goal_request_ref_mismatch');
    if (draft.success.allOf.length > limits.maxPredicates || draft.scope.targetRefs.length > limits.maxTargets) throw new Error('goal_draft_cardinality_limit');
    const now = Date.parse(input.acceptedAt), world = input.state.world.latest;
    if (!world || !observationIsFresh(world.timestamp, now, tuning().goalEvidence.maxWorldAgeMs)) throw new Error('goal_requires_fresh_world');
    if (world.environment.dimension !== draft.scope.dimension) throw new Error('goal_scope_dimension_mismatch');
    const available = this.bindings(input.state), refs = new Set(draft.scope.targetRefs);
    if (refs.size !== draft.scope.targetRefs.length) throw new Error('duplicate_goal_target_ref');
    const bindings = draft.scope.targetRefs.map(ref => {
      const binding = available.find(value => value.id === ref);
      if (!binding || binding.dimension !== draft.scope.dimension || !binding.version || !binding.evidenceRefs.length) throw new Error(`needs_owner_scope:${ref}`);
      return binding;
    }).sort((a, b) => a.id.localeCompare(b.id));
    if (available.some(binding => binding.required && !refs.has(binding.id))) throw new Error('required_goal_target_omitted');
    const mutableRegions = bindings.filter(binding => binding.mutationAllowed).map(binding => binding.region);
    if (mutableRegions.some(region => !isFactRegion(region))) throw new Error('goal_mutation_binding_unbounded');
    const region = mutableRegions[0];
    if (mutableRegions.some(value => !isDeepStrictEqual(value, region))) throw new Error('multiple_mutation_regions_not_supported');
    if (draft.scope.allowedMutationRegion && !isDeepStrictEqual(draft.scope.allowedMutationRegion, region)) throw new Error('goal_mutation_scope_changed');
    if (region && (region.max.x - region.min.x + 1) * (region.max.y - region.min.y + 1) * (region.max.z - region.min.z + 1) > limits.maxRegionVolume) throw new Error('goal_mutation_region_limit');
    const predicates = this.options.predicates();
    const boundPredicates = new Set(bindings.flatMap(binding => binding.requiredPredicates.map(stableJson)));
    const criteria: GoalSuccessCriterion[] = draft.success.allOf.map(ref => {
      const matches = predicates.filter(value => value.id === ref.id);
      if (matches.length !== 1) throw new Error(`missing_or_ambiguous_predicate:${ref.id}`);
      const criterion: GoalSuccessCriterion = { type: 'predicate', predicate: ref.id, predicateVersion: ref.version, args: ref.args, since: now };
      validatePredicateArguments(criterion, matches[0]!);
      if (!boundPredicates.has(stableJson(ref)) && matches[0]!.authorizeGoal?.({ criterion, bindings }) !== true) {
        throw new Error(`predicate_not_authorized_for_bound_targets:${ref.id}`);
      }
      return criterion;
    }).sort((a, b) => stableJson(a).localeCompare(stableJson(b)));
    const actual = new Set(draft.success.allOf.map(stableJson));
    if (actual.size !== criteria.length) throw new Error('duplicate_goal_predicate');
    for (const binding of bindings) for (const required of binding.requiredPredicates) {
      if (!actual.has(stableJson(required))) throw new Error(`required_bound_predicate_missing:${binding.id}:${required.id}`);
    }
    const rootGoal = freezeGoalContractV2({
      schema: 'mineclaw.goal/v2', goalId: input.goalId, profileId: input.profileId,
      goalText: input.state.request.requestText, requestRef: draft.requestRef, successCriteria: criteria,
      scope: { dimension: draft.scope.dimension, targetRefs: [...refs].sort(), bindings,
        ...(region ? { allowedMutationRegion: region } : {}) },
      constraints: input.state.request.constraints.map(value => ({ type: 'natural_language' as const, value })),
      createdAt: input.acceptedAt,
    });
    const semantics = {
      criteria: criteria.map(({ since: _baseline, ...criterion }) => criterion),
      scope: { ...rootGoal.scope, bindings: rootGoal.scope.bindings.map(({ evidenceRefs: _evidence, summary: _summary, ...binding }) => binding) },
      constraints: rootGoal.constraints,
    };
    const semanticHash = createHash('sha256').update(stableJson(semantics)).digest('hex');
    const targetId = `composed:${semanticHash}`;
    return {
      rootGoal,
      goal: { requestId: input.state.requestId, objective: rootGoal.goalText, outcome: 'composed',
        target: { kind: 'state', surface: rootGoal.goalText, registryId: targetId, quantity: 1 },
        constraints: [...input.state.request.constraints], successCriteria: structuredClone(criteria) as unknown as Record<string, unknown>[] },
      signature: { key: targetId, outcome: 'composed', targetKind: 'state', targetId, quantity: 1,
        constraintsHash: semanticHash, compatibleTaskFamilies: ['composed'], schemaVersion: 2 },
    };
  }
}
