import { jsonSnapshot } from '../../infra/jsonSnapshot.js';
import { assertSchemaSupported, validateClosedArguments } from '../../infra/closedJsonSchema.js';
import { tuning } from '../../infra/tuning.js';
import type { WorldStateView } from '../../types.js';
import type { GoalSuccessCriterion } from '../contracts/goalTypes.js';
import type { WorldFact } from '../contracts/worldFact.js';
import type { GoalCriterionEvidence, GoalPredicateEvaluator, GoalPredicateVerdict } from './goalCriteriaEvaluator.js';
import { observationIsFresh, worldFactIssue } from './worldFactValidation.js';

/** Compilation uses this same gate; metadata discovery is not a looser parser. */
export function validatePredicateArguments(criterion: GoalSuccessCriterion, evaluator: GoalPredicateEvaluator): Readonly<Record<string, unknown>> {
  if (criterion.type !== 'predicate' || criterion.predicate !== evaluator.id || !evaluator.version
    || criterion.predicateVersion !== evaluator.version) throw new Error('predicate_version_missing_or_mismatched');
  if (!evaluator.argumentSchema || evaluator.argumentSchema.type !== 'object' || evaluator.argumentSchema.additionalProperties !== false) {
    throw new Error('predicate_argument_schema_missing_or_open');
  }
  const args = jsonSnapshot(criterion.args ?? {});
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('predicate_args_must_be_object');
  assertSchemaSupported(evaluator.argumentSchema);
  validateClosedArguments(args, evaluator.argumentSchema);
  return args;
}

export function evaluateRegisteredPredicate(
  criterion: GoalSuccessCriterion, world: WorldStateView, evidence: GoalCriterionEvidence,
): GoalPredicateVerdict {
  const id = criterion.predicate?.trim();
  if (!id) return unknown('predicate 字段非法，无法验证');
  const matches = (evidence.predicateEvaluators ?? []).filter(value => value.id === id);
  if (matches.length === 0) return unknown(`predicate「${id}」没有已注册机器验证器`);
  if (matches.length > 1) return unknown(`predicate「${id}」机器验证器身份重复`);
  const evaluator = matches[0]!;
  const versioned = criterion.predicateVersion !== undefined || criterion.args !== undefined || evaluator.version !== undefined;
  try {
    const facts: WorldFact[] = [];
    if (versioned) {
      const args = validatePredicateArguments(criterion, evaluator);
      const now = evidence.now ?? Date.now();
      if (!observationIsFresh(world.timestamp, now, tuning().goalEvidence.maxWorldAgeMs)) return unknown('world_observation_stale_or_invalid');
      for (const required of evaluator.factRequirements?.(args) ?? []) {
        if (world.environment.dimension !== required.dimension) return unknown('world_dimension_mismatch');
        const candidates = [...(evidence.worldFacts ?? world.capabilityFacts ?? [])].filter(fact => fact.providerId === required.providerId);
        const valid = candidates.filter(fact => worldFactIssue(fact, required, now) === null)
          .sort((a, b) => b.observedAt - a.observedAt)[0];
        if (!valid) return unknown(`world_fact_unavailable:${required.providerId}:${candidates[0] ? worldFactIssue(candidates[0], required, now) : 'not_observed'}`);
        facts.push(jsonSnapshot(valid));
      }
    }
    const result = evaluator.evaluate({ criterion: jsonSnapshot(criterion), world, evidence, facts });
    if ('status' in result) {
      if (!['satisfied', 'unsatisfied', 'unknown'].includes(result.status)) return unknown('predicate_invalid_status');
      return { status: result.status, detail: result.detail, evidenceRefs: [...new Set([
        ...(result.evidenceRefs ?? []), ...facts.flatMap(fact => [...fact.evidenceRefs]),
        ...(versioned ? [`predicate:${id}@${evaluator.version}`] : []),
      ])] };
    }
    if (versioned) return unknown('versioned_predicate_requires_three_state_result');
    return { status: result.ok === true ? 'satisfied' : 'unsatisfied', detail: result.detail, evidenceRefs: result.evidenceRefs ?? [] };
  } catch (error) {
    return unknown(`predicate「${id}」验证异常：${error instanceof Error ? error.message : String(error)}`);
  }
}

function unknown(detail: string): GoalPredicateVerdict { return { status: 'unknown', detail, evidenceRefs: [] }; }
