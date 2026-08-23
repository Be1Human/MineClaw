/**
 * L7 · LoopCritic —— Agent Loop 内嵌 critic 节点（FEAT-L7-15）
 *
 * 根因：LLMToolLoop 是裸 ReAct，全程无评判；只看 tool 自身 ok/fail，
 *   只说不提交 GoalAgent，不验证「决策真推进了 user 意图」→ 与 cross_door
 *   "假完成"同类病。
 *
 * 本 critic 在 loop 每轮「派发工具前」对**终止意图**(say/complete_task) 做一次同步评判：
 *   - 任务类指令，但本 turn 还没起过任何实质推进工具就想 end_turn → block（疑似假完成）
 *     → 回灌评语逼 LLM 提交 GoalAgent 或 ask_master，而不是嘴上答应、啥也没干。
 *
 * 边界（不做）：
 *   - 物理成败 → 心跳⑨ Critic + FEAT-L7-16 跨 turn 回灌（决策面 vs 物理面，分工）。
 *   - 必填参数缺失 → create_task 自带 clarify 门（missingSlots），不在此重复。
 *   - 完全重复同工具 → llmLoop 已有重复守卫，不重复。
 */

import type { ToolCall, ToolResult } from './tools/types.js';
import { classifyOwnerTurn } from './goalAgentPort/goalRequestClassifier.js';

export type LoopVerdictAction = 'pass' | 'revise' | 'block';

export interface LoopVerdict {
  action: LoopVerdictAction;
  reason: string;
  /** 给 LLM 的纠正建议（revise/block 时） */
  hint?: string;
}

export interface LoopCriticInput {
  /** 本轮 LLM 选中的工具调用 */
  call: ToolCall;
  /** 已执行历史（含本轮之前的工具调用与结果） */
  history: Array<{ call: ToolCall; result: ToolResult }>;
  /** 本 turn 玩家原话 */
  userMessage: string;
  /** 本次 call 是否「end_turn 终止意图」（say/complete_task 等） */
  isTerminalIntent: boolean;
}

export interface ILoopCritic {
  judge(input: LoopCriticInput): LoopVerdict;
}

const PASS: LoopVerdict = { action: 'pass', reason: 'ok' };

const SUBSTANTIVE_TOOLS = new Set<string>(['submit_goal_request']);

/** ask_master 也算「负责任收尾」——主动澄清不是假完成 */
const RESPONSIBLE_TOOLS = new Set<string>(['ask_master']);

export class MainBrainLoopCritic implements ILoopCritic {
  judge(input: LoopCriticInput): LoopVerdict {
    // 只拦终止意图；非终止工具放行（让它执行，重复由 loop 的重复守卫管）
    if (!input.isTerminalIntent) return PASS;
    // ask_master 属负责任收尾，永远放行
    if (RESPONSIBLE_TOOLS.has(input.call.tool)) return PASS;
    // GoalAgentPort 是动作/查询的唯一合法提交。它本身是终止工具，必须在执行前放行。
    if (input.call.tool === 'submit_goal_request') return PASS;

    const didSubstantive = input.history.some(
      (h) => SUBSTANTIVE_TOOLS.has(h.call.tool) || RESPONSIBLE_TOOLS.has(h.call.tool),
    );
    if (didSubstantive) return PASS; // 这 turn 真干过事 → 收尾合理

    const intent = classifyOwnerTurn(input.userMessage);
    if (intent === 'chat') return PASS;

    return {
      action: 'block',
      reason: `${intent}「${input.userMessage.slice(0, 24)}」尚无 GoalAgent 委托就想用话术收尾`,
      hint: '请调用 submit_goal_request 委托完整高层意图，或用 ask_master 询问必要澄清；不要用 say 代替游戏行动。',
    };
  }
}
