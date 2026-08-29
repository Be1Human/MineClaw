/**
 * GoalAgent 主人反馈判定（BUG-CROSS-80 · 纯函数 · 可单测）
 *
 * 石斧卡死根因之一是反馈缺失：空搜索 166 次、预算耗尽前零告警、owner.question 恒为 null。
 * 本模块把三类反馈触发提炼为纯函数，由 round loop 每轮提交后调用，命中则经
 * goalagent.owner.feedback 事件 → GoalReportV2（R20 通道）向主人表达。
 */
import { tuning } from '../../infra/tuning.js';
import type { GoalAgentStateV1 } from './goalAgentState.js';

export type GoalAgentOwnerFeedbackKind = 'blocked' | 'budget_warning' | 'help_needed';

export interface GoalAgentOwnerFeedback {
  kind: GoalAgentOwnerFeedbackKind;
  summary: string;
  evidenceRefs: string[];
  /** help_needed 时为 true：主人可以出手（给工具/材料）解决。 */
  ownerActionable: boolean;
}

export interface OwnerFeedbackInput {
  state: Readonly<GoalAgentStateV1>;
  /** 当前会话连续空搜索结果次数（GoalAgentRoundToolRuntime.emptySearchStreak）。 */
  emptySearchStreak: number;
  /** 本轮 action_list 返回的候选数；null 表示本轮未调用 action_list。 */
  lastCandidateCount: number | null;
  /** 已发过反馈的 kind 集合（防重复打扰主人）。 */
  alreadySentKinds: ReadonlySet<GoalAgentOwnerFeedbackKind>;
}

/** 失败码集合：说明"缺工具/缺材料"，主人可直接帮助。 */
const HELP_FAILURE_CODES = new Set([
  'atomic.equip_unverified',
  'craft_failed',
  'no_craftable_recipe',
  'need_table_but_unavailable',
]);

export function computeOwnerFeedback(input: OwnerFeedbackInput): GoalAgentOwnerFeedback | null {
  const { state, alreadySentKinds } = input;
  if (state.mode !== 'planned_goal' || !state.budget) return null;
  const cfg = tuning().goalAgent;
  const failure = state.action.result?.failure;
  const failureCode = failure?.code ?? '';

  // ① 缺工具/缺材料 且 无可选候选（revise_action 后 action_list 为空）→ 求助
  if (
    !alreadySentKinds.has('help_needed')
    && failure
    && HELP_FAILURE_CODES.has(failureCode)
    && input.lastCandidateCount !== null
    && input.lastCandidateCount === 0
  ) {
    return {
      kind: 'help_needed',
      summary: `我卡在「${failure.detail ?? failureCode}」：${shortCodeHint(failureCode)}。当前没有可执行的动作候选，需要主人帮助（给工具/材料或换目标）。`,
      evidenceRefs: [...(failure.evidenceRefs ?? []), `failure:${failureCode}`],
      ownerActionable: true,
    };
  }

  // ② 连续空搜索达到阈值 → 障碍反馈
  if (!alreadySentKinds.has('blocked') && input.emptySearchStreak >= cfg.feedbackEmptySearchStreak) {
    const tried = failure ? `最近失败：${failure.detail ?? failureCode}` : '已尝试搜索但无结果';
    return {
      kind: 'blocked',
      summary: `连续 ${input.emptySearchStreak} 次知识/技能/能力搜索都没有结果，${tried}。我暂时找不到可执行的路径，先停下来向主人说明，不再空转。`,
      evidenceRefs: ['goalagent:empty_search_streak', ...(failure?.evidenceRefs ?? [])],
      ownerActionable: false,
    };
  }

  // ③ llmCalls 达阈值比例且未达成 → 预算告警
  const maxLlmCalls = state.budget.maxLlmCalls;
  if (
    !alreadySentKinds.has('budget_warning')
    && Number.isFinite(maxLlmCalls)
    && maxLlmCalls > 0
    && state.budget.llmCalls >= Math.ceil(maxLlmCalls * cfg.feedbackBudgetRatio)
    && !state.terminal
  ) {
    return {
      kind: 'budget_warning',
      summary: `任务执行已经用了 ${state.budget.llmCalls}/${maxLlmCalls} 次思考预算，还没完成。我会继续尝试，但先告诉主人一声。`,
      evidenceRefs: [`goalagent:budget:${state.budget.llmCalls}:${maxLlmCalls}`],
      ownerActionable: false,
    };
  }

  return null;
}

function shortCodeHint(code: string): string {
  if (code === 'atomic.equip_unverified') return '需要的工具不在手上';
  if (code === 'craft_failed' || code === 'no_craftable_recipe') return '合成缺少材料或配方不可用';
  if (code === 'need_table_but_unavailable') return '需要工作台但找不到或造不出';
  return '执行条件不满足';
}
