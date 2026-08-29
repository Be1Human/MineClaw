/**
 * 完成确认闸（FEAT-CROSS-21 · 双签完成）
 *
 * GoalAgent 的 completed 声明在进入共享任务状态前必须经过本闸的机器复核：
 *   - item_delivered / item_deposited / block_placed：复用 goalCriteriaEvaluator 的
 *     收据语义（deliveries/deposits/placements + 时间锚 since）
 *   - inventory：fresh world 快照实物
 *   - reached / entity_dead / predicate：复用同源 evaluator
 * 复核零 LLM、幂等（调用方按 requestId 去重）；不通过返回结构化拒绝原因，
 * 由报告链降级为 running/obstacle 并触发恢复，共享任务状态不置 completed。
 */
import type { WorldStateView } from '../../types.js';
import type { Goal, GoalSuccessCriterion } from '../../task/contracts/goalTypes.js';
import {
  evaluateGoalCriteria,
  type GoalCriterionEvidence,
} from '../../task/goalRunner/goalCriteriaEvaluator.js';

export type ConfirmationRejectReason =
  | 'deliver_missing_receipt'
  | 'place_missing_receipt'
  | 'obtain_inventory_not_satisfied'
  | 'criteria_invalid';

export type ConfirmationVerdict =
  | { ok: true; summary: string; evidenceRefs?: string[] }
  | { ok: false; reason: ConfirmationRejectReason; detail: string };

export interface ConfirmationInput {
  goalText: string;
  criteria: readonly GoalSuccessCriterion[];
  /** fresh world 快照；null 视为无法复核（拒绝）。 */
  world: WorldStateView | null;
  evidence: GoalCriterionEvidence;
}

/**
 * 机器复核 GoalAgent 的完成声明。
 * 与 GoalAgent verifier 共用 goalCriteriaEvaluator（同一事实源），
 * 本闸只做"证据存在性 + 时间锚"的权威复核，不重实现第二套语义。
 */
export function confirmCompletion(input: ConfirmationInput): ConfirmationVerdict {
  if (!input.world) {
    return { ok: false, reason: 'criteria_invalid', detail: '无 fresh 世界快照，无法确认完成' };
  }
  const goal: Goal = {
    goalText: input.goalText,
    successCriteria: [...input.criteria],
    constraints: undefined,
  };
  const result = evaluateGoalCriteria(goal, input.world, input.evidence);
  if (result.ok) {
    return { ok: true, summary: result.detail, evidenceRefs: result.evidenceRefs };
  }
  return { ok: false, reason: rejectReasonFor(input.criteria, result.detail), detail: result.detail };
}

function rejectReasonFor(
  criteria: readonly GoalSuccessCriterion[],
  detail: string,
): ConfirmationRejectReason {
  if (criteria.some(criterion => criterion.type === 'item_delivered' || criterion.type === 'item_deposited')) {
    return 'deliver_missing_receipt';
  }
  if (criteria.some(criterion => criterion.type === 'block_placed')) {
    return 'place_missing_receipt';
  }
  if (criteria.some(criterion => criterion.type === 'inventory')) {
    return 'obtain_inventory_not_satisfied';
  }
  return 'criteria_invalid';
}
