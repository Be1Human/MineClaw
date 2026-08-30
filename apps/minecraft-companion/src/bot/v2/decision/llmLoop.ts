/**
 * L7 · LLM Tool Use Loop（FEAT-L7-07 升级版）
 *
 * 一个 turn 内 LLM 多轮回复，直到 LLM 调 say/ask_master/complete_task 结束。
 * 实现：走 LLMClient.callWithTools（OpenAI SDK native function calling）。
 *
 * 取代了原来的 prompt-completion 模拟 tool_use 路线（手工 JSON parse），
 * 同时取代了 Hermes Python 子进程方案（FEAT-L7-06，已废弃）。
 */

import { LLMClient } from '../cognitive/llm/LLMClient.js';
import type {
  CanonicalLlmMessage,
  LLMChatMessage,
  LLMToolCallResult,
  LlmContentBlock,
} from '../cognitive/llm/types.js';
import type { ToolRegistry } from './tools/toolRegistry.js';
import type { ToolCall, ToolResult } from './tools/types.js';
import type { EventBusV2 } from '../infra/eventBus.js';
import type { ILoopCritic } from './loopCritic.js';
import { tuning } from '../infra/tuning.js';
import type { LLMFailure } from '../cognitive/llm/errors.js';
import {
  hasUserFacingIdentityLeak,
  normalizeInternalExecutionNarrative,
  sanitizeUserVisibleThinking,
} from './identitySemantics.js';
import { classifyOwnerTurn } from './goalAgentPort/goalRequestClassifier.js';
import { stripGenericUserVocative } from '../../../character/userAddressing.js';
import { randomUUID } from 'node:crypto';
import type {
  LlmTraceCallContext,
  LlmTraceEventInputV1,
  LlmTraceJsonValue,
  LlmTraceRecorderPort,
  TraceContextSourceRef,
} from '../infra/llmTrace/index.js';

export interface LLMLoopConfig {
  systemPrompt: string;
  /** FEAT-CROSS-12 · 根据当前消息动态选择世界书并组装角色卡。 */
  characterBlock?: (userMessage: string) => string;
  /** 每个 turn 现读的机器运行态；不得用静态 prompt 猜测身体或玩家在线状态。 */
  runtimeBlock?: () => string;
  /** 关闭时只允许聊天/记忆工具。 */
  minecraftEnabled?: boolean;
  memoryEnabled?: boolean;
  maxRounds: number;
  /** 可选 · 传入后发出 l7.thought / l7.tool_call 等细粒度事件 */
  bus?: EventBusV2;
  /** FEAT-NARR-01 · 每 turn 把近期事件通知喂给大模型（让它知道自驱系统刚做/遇到了什么）*/
  recentNotices?: () => string;
  /** 热刷新 · 每 turn 重读个性化记忆块（存了立即生效，不必重启）*/
  memoryBlock?: (userMessage: string) => string;
  /** 热刷新 · 每 turn 重读最近对话历史（已含 ── 最近对话记录 ── 头）*/
  conversationBlock?: () => string;
  /** FEAT-CROSS-09 · 受治理的陪伴人格、关系与可修正情绪上下文。 */
  companionBlock?: () => string;
  /** FEAT-L7-15 · loop 内嵌 critic：每轮派发终止工具前自检，拦"假完成" */
  loopCritic?: ILoopCritic;
  /** FEAT-WEBUI-19 · 工具与委托事件写入统一轨迹事实流。 */
  traceRecorder?: LlmTraceRecorderPort;
}

export interface HistoryEntry {
  call: ToolCall;
  result: ToolResult;
  /** function calling 返回的 tool_call_id · 用于在 messages 里把 assistant.tool_calls 与 tool 结果配对 */
  toolCallId?: string;
  /** Exact assistant turn, including optional canonical/replay metadata. */
  assistant?: LLMChatMessage;
}

interface MainBrainPendingHistoryEnvelopeV1 {
  kind: 'mainbrain-pending-history';
  version: 1;
  entries: HistoryEntry[];
}

/** Durable pending payload stored with the conversation record. */
export function serializeMainBrainPendingHistory(history: readonly HistoryEntry[]): string {
  const envelope: MainBrainPendingHistoryEnvelopeV1 = {
    kind: 'mainbrain-pending-history',
    version: 1,
    entries: structuredClone([...history]),
  };
  return JSON.stringify(envelope);
}

/** Unknown/corrupt envelopes fail closed; replay metadata degrades later in the codec. */
export function restoreMainBrainPendingHistory(raw: string | undefined): HistoryEntry[] | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)
    || parsed.kind !== 'mainbrain-pending-history'
    || parsed.version !== 1
    || !Array.isArray(parsed.entries)) return null;
  const entries: HistoryEntry[] = [];
  for (const value of parsed.entries) {
    const entry = restoreHistoryEntry(value);
    if (!entry) return null;
    entries.push(entry);
  }
  return entries;
}

export interface LoopResult {
  pendingAskMaster: boolean;
  ended: boolean;
  rounds: number;
  history: HistoryEntry[];
}

export interface TerminalSpeechPolicy {
  validate(text: string): { pass: boolean; reason?: string; hint?: string };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error('turn aborted');
  error.name = 'AbortError';
  throw error;
}

function preserveOwnerGoalRequest(call: ToolCall, userMessage: string): ToolCall {
  if (call.tool !== 'submit_goal_request') return call;
  const intent = classifyOwnerTurn(userMessage);
  if (intent === 'chat') return call;
  const requestKind = intent === 'game_query'
    ? 'query'
    : intent === 'game_cancel'
      ? 'cancel'
      : 'task';
  return {
    ...call,
    input: {
      ...call.input,
      requestText: userMessage,
      requestKind,
    },
  };
}


export class LLMToolLoop {
  constructor(
    private readonly llm: LLMClient,
    private readonly tools: ToolRegistry,
    private readonly cfg: LLMLoopConfig,
    private readonly log: (msg: string) => void,
  ) {}

  /**
   * BUG-CROSS-47 · 脱敏协议分类观测。
   * 只记录分类标签、轮次和工具名等安全字段，绝不记录原始响应体。
   */
  private logProtocol(category: string, round: number, detail = ''): void {
    const safeCategory = /^[a-z_]+$/.test(category) ? category : 'unknown';
    this.log(`[protocol:${safeCategory}] R${round}${detail ? ` · ${detail}` : ''}`);
    this.cfg.bus?.publish('brain.protocol_classification', 'info', { category: safeCategory, round });
  }

  /**
   * 执行一轮 turn
   * @param userMessage 玩家这次说的话
   * @param priorHistory 上次 ask_master 时保存的 history · 用于恢复
   * @param abortSignal 可选 · 外部抢占信号（主人消息抢占 IDLE turn）
   */
  async run(
    userMessage: string,
    priorHistory: HistoryEntry[] = [],
    abortSignal?: AbortSignal,
    opts?: {
      systemFeedback?: string;
      allowedTools?: readonly string[];
      terminalSpeechPolicy?: TerminalSpeechPolicy;
      traceContext?: LlmTraceCallContext;
    },
  ): Promise<LoopResult> {
    const isResume = priorHistory.length > 0;
    const history: HistoryEntry[] = [...priorHistory];

    const systemContent = this.buildSystem(userMessage, history, isResume, opts?.systemFeedback);
    // BUG-L7 ask_master 死循环根治：恢复时必须按真实时序——
    //   system → 回放上一轮 assistant/tool 历史(末尾是 ask_master 提问) → 主人这次的答复(放最后)。
    //   旧实现把 userMessage 塞在 priorHistory 之前，导致主人答复时序上排到"提问之前"，
    //   LLM 看到最后一句是自己在问①②③、答复反而在前面 → 永远当没答、逐字重发同一句澄清。
    const messages: LLMChatMessage[] = [{ role: 'system', content: systemContent }];
    // 把 priorHistory 还原成 assistant + tool 消息对（保留上下文）
    for (const h of priorHistory) {
      this.appendHistoryToMessages(messages, h);
    }
    // 主人本轮输入放在回放历史之后（恢复轮=答复 ask_master；普通轮 priorHistory 为空，等价于原行为）。
    messages.push({ role: 'user', content: userMessage });

    let rounds = 0;
    let reviseCount = 0; // FEAT-L7-15 · loop critic 触发 revise/block 计数（防死循环）
    let relationshipRewriteCount = 0;
    let identityRewriteCount = 0;
    let protocolRetryCount = 0;
    let speechPolicyRetryCount = 0;
    let forcedToolName: string | null = null;
    while (rounds < this.cfg.maxRounds) {
      throwIfAborted(abortSignal);
      rounds += 1;

      // MainBrain 始终使用固定白名单；不得通过 skill 动态解锁游戏工具。
      const tools = opts?.allowedTools
        ? this.tools.only(opts.allowedTools)
        : this.tools.toLLMSchemas();
      const permittedTools = tools.filter(tool => {
        if (this.cfg.memoryEnabled === false && ['save_memory', 'recall_memory'].includes(tool.function.name)) return false;
        if (this.cfg.minecraftEnabled === false && !['say', 'ask_master', 'save_memory', 'recall_memory'].includes(tool.function.name)) return false;
        return true;
      });
      const conversationalOnly = permittedTools.every(tool =>
        ['say', 'ask_master', 'save_memory', 'recall_memory', 'join_game'].includes(tool.function.name));
      const llmFailureState: { value?: LLMFailure } = {};
      const callId = `mainbrain-${randomUUID()}`;
      const traceContext: LlmTraceCallContext = {
        ...opts?.traceContext,
        callId,
        agent: 'mainbrain',
        modelCallIndex: rounds,
        contextSources: mainBrainContextManifest(messages, permittedTools.length),
        abortReason: 'new_owner_message_or_runtime_stop',
      };
      const resp = await this.llm.callWithTools({
        messages,
        tools: permittedTools,
        ...(forcedToolName ? {
          toolChoice: { type: 'function' as const, function: { name: forcedToolName } },
        } : {}),
        temperature: conversationalOnly ? 0.75 : 0.2,
        signal: abortSignal,
        onError: failure => { llmFailureState.value = failure; },
        traceContext,
      });
      const llmFailure = llmFailureState.value;
      // BUG-CROSS-19 · 即使 provider 在 abort 后仍迟到返回，也不得派发旧 turn 的工具。
      throwIfAborted(abortSignal);
      if (!resp) {
        this.log(`R${rounds} LLM ${llmFailure ? `失败(${llmFailure.kind})` : '返回空'} · 无大脑决定，静默结束`);
        this.cfg.bus?.publish('brain.turn_no_decision', 'recoverable', {
          reason: llmFailure ? llmFailureMessage(llmFailure) : 'empty_response',
        });
        return { pendingAskMaster: false, ended: true, rounds, history };
      }

      let responseToolCalls = resp.toolCalls;
      let responseContent = resp.content?.trim() || '';
      if (forcedToolName && responseToolCalls.some(call => call.name === forcedToolName)) {
        forcedToolName = null;
      }
      if (responseToolCalls.length > 0) {
        this.logProtocol('standard_tool_call', rounds, responseToolCalls[0]?.name ?? '');
      }

      // 旧 prompt 曾要求模型把动作写进 content。仅兼容严格、完整且工具仍在本轮许可集内的旧动作。
      if (responseToolCalls.length === 0) {
        const legacy = parseLegacyActionJson(responseContent);
        const legacyAllowed = legacy
          ? permittedTools.some(tool => tool.function.name === legacy.call.tool)
          : false;
        if (legacy && legacyAllowed) {
          responseToolCalls = [{
            id: `legacy_${rounds}_${Math.random().toString(36).slice(2, 8)}`,
            name: legacy.call.tool,
            arguments: legacy.call.input,
          }];
          responseContent = legacy.thought;
          this.log(`R${rounds} 兼容旧动作 JSON · 转为原生工具调用 ${legacy.call.tool}`);
          this.logProtocol('legacy_action_adapted', rounds, legacy.call.tool);
        } else {
          let text = stripGenericUserVocative(stripLeakedActionJson(responseContent));
          if (!text) {
            if (protocolRetryCount < 1 && rounds < this.cfg.maxRounds) {
              protocolRetryCount += 1;
              this.log(`R${rounds} 输出协议无效${legacy ? `（工具 ${legacy.call.tool} 未获许可）` : ''} · 纠正重试`);
              this.logProtocol('protocol_retry', rounds, legacy ? `unpermitted_tool:${legacy.call.tool}` : 'empty_content');
              if (responseContent) messages.push(responseAssistantMessage(resp));
              messages.push({ role: 'user', content: protocolCorrectionInstruction() });
              continue;
            }
            this.log(`R${rounds} 输出协议连续无效 · 无大脑决定，静默结束`);
            this.logProtocol('protocol_invalid', rounds, legacy ? `unpermitted_tool:${legacy.call.tool}` : 'empty_content');
            this.cfg.bus?.publish('brain.turn_no_decision', 'recoverable', { reason: 'invalid_output_protocol' });
            return { pendingAskMaster: false, ended: true, rounds, history };
          }
          this.logProtocol('plain_content', rounds);
          if (hasServileRelationshipStyle(text) && relationshipRewriteCount < 1) {
            relationshipRewriteCount += 1;
            this.log(`R${rounds} 检测到主仆式口吻 · 拦截并要求按平等好友关系重写`);
            messages.push(responseAssistantMessage(resp));
            messages.push({ role: 'user', content: relationshipRewriteInstruction(userMessage) });
            continue;
          }
          if (hasUserFacingIdentityLeak(text)) {
            if (identityRewriteCount < 1 && rounds < this.cfg.maxRounds) {
              identityRewriteCount += 1;
              this.log(`R${rounds} 检测到内部执行被写成外部主体 · 拦截并要求按第一人称重写`);
              messages.push(responseAssistantMessage(resp));
              messages.push({ role: 'user', content: identityRewriteInstruction(userMessage) });
              continue;
            }
            this.log(`R${rounds} 身份一致性重写仍未通过 · 静默结束`);
            const silentCall: ToolCall = { tool: 'stay_silent', input: {} };
            const silentResult = this.tools.call(silentCall);
            history.push({ call: silentCall, result: silentResult });
            return { pendingAskMaster: false, ended: true, rounds, history };
          }
          const speechVerdict = opts?.terminalSpeechPolicy?.validate(text);
          if (speechVerdict && !speechVerdict.pass) {
            if (speechPolicyRetryCount < 1 && rounds < this.cfg.maxRounds) {
              speechPolicyRetryCount += 1;
              this.log(`R${rounds} GoalReportSpeechPolicy 拦截 implicit-say: ${speechVerdict.reason ?? '状态不一致'}`);
              messages.push(responseAssistantMessage(resp));
              messages.push({ role: 'user', content: `[GoalReportSpeechPolicy] ${speechVerdict.reason ?? '回复与任务状态不一致'}\n${speechVerdict.hint ?? '请按任务报告重写。'}` });
              continue;
            }
            this.log(`R${rounds} GoalReportSpeechPolicy 重写仍未通过 · 静默结束`);
            return { pendingAskMaster: false, ended: true, rounds, history };
          }
          // BUG-CROSS-15 · 隐式 say 与显式 say 必须共用同一终止治理。
          // 旧路径直接发送 content，任务类请求可借此绕过 LoopCritic，引用历史成功记录制造假完成。
          if (this.cfg.loopCritic && tuning().l7Critic.enabled) {
            const call: ToolCall = { tool: 'say', input: { text } };
            const verdict = this.cfg.loopCritic.judge({ call, history, userMessage, isTerminalIntent: true });
            if (this.cfg.bus) {
              this.cfg.bus.publish('l7.critic_verdict', 'info', {
                round: rounds, action: verdict.action, reason: verdict.reason, implicitSay: true,
              });
            }
            if (verdict.action !== 'pass') {
              this.log(`R${rounds} 🧪 LoopCritic ${verdict.action} implicit-say: ${verdict.reason}`);
              if (permittedTools.some(tool => tool.function.name === 'submit_goal_request')) {
                forcedToolName = 'submit_goal_request';
              }
              if (reviseCount >= tuning().l7Critic.maxRevise || rounds >= this.cfg.maxRounds) {
                const delegated = forcedToolName === 'submit_goal_request'
                  ? this.dispatchForcedGoalRequest(userMessage, rounds, history, callId, traceContext)
                  : null;
                if (delegated) return delegated;
                this.log(`R${rounds} LoopCritic 纠正预算耗尽 · 阻止 implicit-say，结束为无决定`);
                this.cfg.bus?.publish('brain.turn_no_decision', 'recoverable', {
                  reason: 'loop_critic_exhausted',
                });
                return { pendingAskMaster: false, ended: true, rounds, history };
              }
              reviseCount += 1;
              // 没有真实 tool_call，不能伪造 tool role；用合法 assistant/user 对回灌纠正意见。
              messages.push(responseAssistantMessage(resp));
              messages.push({
                role: 'user',
                content: `[LoopCritic ${verdict.action}] ${verdict.reason}\n${verdict.hint ?? '请重新决策并调用合适工具。'}`,
              });
              continue;
            }
          }
          this.log(`R${rounds} 无 tool_call · 把文字回复转为 say · "${text.slice(0, 40)}"`);
          const implicitSay: ToolCall = { tool: 'say', input: { text } };
          const implicitResult = this.tools.call(implicitSay);
          history.push({ call: implicitSay, result: implicitResult });
          return { pendingAskMaster: false, ended: true, rounds, history };
        }
      }

      // 取第一个 tool_call（与 hermes_bridge.py 行为一致）
      const tc = responseToolCalls[0];
      if (!tc) {
        this.log(`R${rounds} tool_calls 数组异常空 · 无大脑决定，静默结束`);
        this.cfg.bus?.publish('brain.turn_no_decision', 'recoverable', { reason: 'empty_tool_calls' });
        return { pendingAskMaster: false, ended: true, rounds, history };
      }
      const call = normalizeGenericVocativeCall(preserveOwnerGoalRequest(
        { tool: tc.name, input: tc.arguments },
        userMessage,
      ));
      const thoughtMaybe = responseContent;
      const policyToolDenied = !!opts?.allowedTools && !opts.allowedTools.includes(call.tool);
      const gameToolDenied = this.cfg.minecraftEnabled === false && !['say', 'ask_master', 'stay_silent', 'save_memory', 'recall_memory'].includes(call.tool);
      const memoryToolDenied = this.cfg.memoryEnabled === false && ['save_memory', 'recall_memory'].includes(call.tool);
      if (policyToolDenied || gameToolDenied || memoryToolDenied) {
        this.log(`R${rounds} 拒绝角色卡未启用的工具 ${call.tool}`);
        messages.push(responseAssistantMessage(resp));
        messages.push({ role: 'user', content: '当前角色未启用这项能力。不要调用该工具，请直接以角色身份自然说明。' });
        continue;
      }
      const inputStr = JSON.stringify(call.input).slice(0, 80);
      this.log(`R${rounds} ${call.tool}(${inputStr})${thoughtMaybe ? ` · 思考：${thoughtMaybe.slice(0, 60)}` : ''}`);

      if (thoughtMaybe && this.cfg.bus) {
        const visibleThought = stripGenericUserVocative(sanitizeUserVisibleThinking(thoughtMaybe));
        if (visibleThought) this.cfg.bus.publish('l7.thought', 'info', { round: rounds, thought: visibleThought });
      }
      if (this.cfg.bus) {
        this.cfg.bus.publish('l7.tool_call', 'info', { round: rounds, tool: call.tool, input: call.input });
      }

      const outgoingText = terminalSpeechText(call);
      const speechVerdict = outgoingText ? opts?.terminalSpeechPolicy?.validate(outgoingText) : undefined;
      if (speechVerdict && !speechVerdict.pass) {
        if (speechPolicyRetryCount < 1 && rounds < this.cfg.maxRounds) {
          speechPolicyRetryCount += 1;
          this.log(`R${rounds} GoalReportSpeechPolicy 拦截 ${call.tool}: ${speechVerdict.reason ?? '状态不一致'}`);
          messages.push(responseAssistantMessage(resp, undefined, outgoingText ?? ''));
          messages.push({ role: 'user', content: `[GoalReportSpeechPolicy] ${speechVerdict.reason ?? '回复与任务状态不一致'}\n${speechVerdict.hint ?? '请按任务报告重写。'}` });
          continue;
        }
        this.log(`R${rounds} GoalReportSpeechPolicy 重写仍未通过 · 静默结束`);
        const safeCall: ToolCall = { tool: 'stay_silent', input: {} };
        const safeResult = this.tools.call(safeCall);
        history.push({ call: safeCall, result: safeResult });
        return { pendingAskMaster: false, ended: true, rounds, history };
      }
      if (outgoingText && hasServileRelationshipStyle(outgoingText) && relationshipRewriteCount < 1) {
        relationshipRewriteCount += 1;
        this.log(`R${rounds} ${call.tool} 命中主仆式口吻 · 拦截并要求按平等好友关系重写`);
        messages.push(responseAssistantMessage(resp, undefined, outgoingText));
        messages.push({ role: 'user', content: relationshipRewriteInstruction(userMessage) });
        continue;
      }
      if (outgoingText && hasUserFacingIdentityLeak(outgoingText)) {
        if (identityRewriteCount < 1 && rounds < this.cfg.maxRounds) {
          identityRewriteCount += 1;
          this.log(`R${rounds} ${call.tool} 把内部执行写成外部主体 · 拦截并要求按第一人称重写`);
          messages.push(responseAssistantMessage(resp, undefined, outgoingText));
          messages.push({ role: 'user', content: identityRewriteInstruction(userMessage) });
          continue;
        }
        this.log(`R${rounds} ${call.tool} 身份一致性重写仍未通过 · 静默结束`);
        const safeCall: ToolCall = { tool: 'stay_silent', input: {} };
        const safeResult = this.tools.call(safeCall);
        history.push({ call: safeCall, result: safeResult });
        return { pendingAskMaster: false, ended: true, rounds, history };
      }

      // 连续重复工具守卫（与旧版同语义）
      const REPEAT_LIMIT = 2;
      if (history.length >= REPEAT_LIMIT) {
        const callKey = `${call.tool}:${JSON.stringify(call.input)}`;
        const lastN = history.slice(-REPEAT_LIMIT);
        const allSame = lastN.every(
          (h) => `${h.call.tool}:${JSON.stringify(h.call.input)}` === callKey,
        );
        if (allSame) {
          this.log(`R${rounds} ⚠ 连续重复 ${call.tool} × ${REPEAT_LIMIT}，注入守卫提示`);
          const guardResult: ToolResult = {
            ok: false,
            result: {
              error: `你已连续调用 "${call.tool}" ${REPEAT_LIMIT} 次并拿到结果。` +
                '请根据已有信息直接决策：调 say 回答主人，或调其他工具推进任务。不要再重复调同一工具。',
            },
          };
          // 把 assistant 的 tool_call + 守卫 tool 结果回填进 messages，让下一轮 LLM 看到
          const assistant = responseAssistantMessage(resp, {
            id: tc.id, name: tc.name, arguments: call.input,
          });
          messages.push(assistant);
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: this.formatToolResult(guardResult),
          });
          history.push({
            call: { tool: '_loop_guard', input: {} }, result: guardResult,
            toolCallId: tc.id, assistant: structuredClone(assistant),
          });
          continue;
        }
      }

      // FEAT-L7-15 · LoopCritic：终止意图(say/complete_task)派发前自检，拦"假完成"。
      // 必须在 tools.call 之前——否则 say 已经把话说出口，拦不住。
      if (this.cfg.loopCritic && tuning().l7Critic.enabled) {
        const isTerminalIntent = this.tools.get(call.tool)?.terminal === 'end_turn';
        if (isTerminalIntent) {
          const verdict = this.cfg.loopCritic.judge({ call, history, userMessage, isTerminalIntent });
          if (this.cfg.bus) {
            this.cfg.bus.publish('l7.critic_verdict', 'info', {
              round: rounds, action: verdict.action, reason: verdict.reason,
            });
          }
          if (verdict.action !== 'pass') {
            this.log(`R${rounds} 🧪 LoopCritic ${verdict.action}: ${verdict.reason}`);
            if (permittedTools.some(tool => tool.function.name === 'submit_goal_request')) {
              forcedToolName = 'submit_goal_request';
            }
            if (reviseCount >= tuning().l7Critic.maxRevise || rounds >= this.cfg.maxRounds) {
              const delegated = forcedToolName === 'submit_goal_request'
                ? this.dispatchForcedGoalRequest(userMessage, rounds, history, callId, traceContext)
                : null;
              if (delegated) return delegated;
              this.log(`R${rounds} LoopCritic 纠正预算耗尽 · 阻止 ${call.tool}，结束为无决定`);
              this.cfg.bus?.publish('brain.turn_no_decision', 'recoverable', {
                reason: 'loop_critic_exhausted',
              });
              return { pendingAskMaster: false, ended: true, rounds, history };
            }
            reviseCount += 1;
            const criticResult: ToolResult = {
              ok: false,
              result: { critic: verdict.action, reason: verdict.reason, hint: verdict.hint },
            };
            const assistant = responseAssistantMessage(resp, {
              id: tc.id, name: tc.name, arguments: call.input,
            });
            messages.push(assistant);
            messages.push({ role: 'tool', tool_call_id: tc.id, content: this.formatToolResult(criticResult) });
            history.push({
              call: { tool: '_loop_critic', input: {} }, result: criticResult,
              toolCallId: tc.id, assistant: structuredClone(assistant),
            });
            continue; // 不执行终止工具，逼 LLM 先真正推进
          }
        }
      }

      // 实际派发
      throwIfAborted(abortSignal);
      this.recordToolTrace('tool.call', callId, traceContext, {
        toolCallId: tc.id,
        name: call.tool,
        arguments: toTraceJson(call.input),
      });
      if (call.tool === 'submit_goal_request') {
        this.recordToolTrace('delegation.submitted', callId, traceContext, {
          toolCallId: tc.id,
          request: toTraceJson(call.input),
        });
      }
      const t0 = Date.now();
      const result = this.tools.call(call);
      const durationMs = Date.now() - t0;
      this.recordToolTrace('tool.result', callId, traceContext, {
        toolCallId: tc.id,
        name: call.tool,
        ok: result.ok,
        result: toTraceJson(result.result),
        durationMs,
      });
      if (call.tool === 'submit_goal_request' && result.ok) {
        this.recordToolTrace('delegation.accepted', callId, traceContext, {
          toolCallId: tc.id,
          result: toTraceJson(result.result),
        });
      }
      const assistant = responseAssistantMessage(resp, {
        id: tc.id, name: tc.name, arguments: call.input,
      });
      history.push({ call, result, toolCallId: tc.id, assistant: structuredClone(assistant) });
      messages.push(assistant);
      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: this.formatToolResult(result),
      });

      if (this.cfg.bus) {
        this.cfg.bus.publish('l7.tool_result', 'info', {
          round: rounds, tool: call.tool, ok: result.ok, result: result.result, durationMs,
        });
      }

      // FEAT-L7-13 · turn 终止语义由 ToolDefinition.terminal 声明，loop 不再按名字记名单
      const terminal = this.tools.get(call.tool)?.terminal;
      if (terminal === 'ask_master') {
        return { pendingAskMaster: true, ended: false, rounds, history };
      }
      if (terminal === 'end_turn') {
        return { pendingAskMaster: false, ended: true, rounds, history };
      }
      // 继续下一轮
    }

    this.log(`maxRounds(${this.cfg.maxRounds}) reached · 无大脑决定，静默结束`);
    throwIfAborted(abortSignal);
    this.cfg.bus?.publish('brain.turn_no_decision', 'recoverable', { reason: 'max_rounds' });
    return { pendingAskMaster: false, ended: true, rounds, history };
  }

  private dispatchForcedGoalRequest(
    userMessage: string,
    round: number,
    history: HistoryEntry[],
    callId: string,
    traceContext: LlmTraceCallContext,
  ): LoopResult | null {
    const intent = classifyOwnerTurn(userMessage);
    if (intent === 'chat') return null;
    const requestKind = intent === 'game_query'
      ? 'query'
      : intent === 'game_cancel'
        ? 'cancel'
        : 'task';
    const call: ToolCall = {
      tool: 'submit_goal_request',
      input: { requestText: userMessage, requestKind },
    };
    this.log(`R${round} Provider 忽略强制工具 · harness 原样委托 submit_goal_request`);
    this.cfg.bus?.publish('l7.tool_call', 'info', {
      round,
      tool: call.tool,
      thought: '',
      harnessFallback: true,
    });
    this.recordToolTrace('tool.call', callId, traceContext, {
      name: call.tool,
      arguments: toTraceJson(call.input),
      harnessFallback: true,
    });
    this.recordToolTrace('delegation.submitted', callId, traceContext, {
      request: toTraceJson(call.input),
      harnessFallback: true,
    });
    const t0 = Date.now();
    const result = this.tools.call(call);
    this.recordToolTrace('tool.result', callId, traceContext, {
      name: call.tool,
      ok: result.ok,
      result: toTraceJson(result.result),
      durationMs: Date.now() - t0,
      harnessFallback: true,
    });
    if (result.ok) {
      this.recordToolTrace('delegation.accepted', callId, traceContext, {
        result: toTraceJson(result.result),
        harnessFallback: true,
      });
    }
    history.push({ call, result });
    this.cfg.bus?.publish('l7.tool_result', 'info', {
      round,
      tool: call.tool,
      ok: result.ok,
      result: result.result,
      durationMs: Date.now() - t0,
      harnessFallback: true,
    });
    return { pendingAskMaster: false, ended: true, rounds: round, history };
  }

  private recordToolTrace(
    type: Extract<LlmTraceEventInputV1['type'],
      'tool.call' | 'tool.result' | 'delegation.submitted' | 'delegation.accepted'>,
    callId: string,
    context: LlmTraceCallContext,
    payload: Record<string, LlmTraceJsonValue>,
  ): void {
    if (!this.cfg.traceRecorder) return;
    try {
      const pending = this.cfg.traceRecorder.append({
        occurredAt: new Date().toISOString(),
        type,
        callId,
        parentCallId: context.parentCallId,
        correlationId: context.correlationId,
        interactionSessionId: context.interactionSessionId,
        goalSessionId: context.goalSessionId,
        taskId: context.taskId,
        agent: 'mainbrain',
        node: context.node,
        turn: context.turn,
        modelCallIndex: context.modelCallIndex,
        payload,
      });
      void Promise.resolve(pending).catch(error => {
        this.log(`trace:fatal tool event append failed: ${error instanceof Error ? error.name : 'UnknownError'}`);
      });
    } catch (error) {
      this.log(`trace:fatal tool event append failed: ${error instanceof Error ? error.name : 'UnknownError'}`);
    }
  }

  /**
   * 构造 system 段：基座 systemPrompt + 可选的 resume 提示 + 渐进式披露的任务详情。
   * （user 消息只放当前这句话；历史以 assistant/tool 消息对出现）
   */
  private buildSystem(userMessage: string, history: HistoryEntry[], isResume: boolean, systemFeedback?: string): string {
    const parts: string[] = [this.cfg.systemPrompt];
    if (this.cfg.characterBlock) {
      const character = this.cfg.characterBlock(userMessage);
      if (character.trim()) parts.push('', character);
    }
    if (this.cfg.runtimeBlock) {
      const runtime = this.cfg.runtimeBlock();
      if (runtime.trim()) parts.push('', '── 当前运行态（机器事实）──', runtime);
    }
    // FEAT-L7-16 · 任务执行回执（内部状态通道 · 非朋友发言）· 放最前，是本 turn 的主要决策依据
    if (systemFeedback && systemFeedback.trim().length > 0) {
      parts.push('');
      parts.push('── 你的执行进展（内部状态 · 不是朋友说的话 · 这些事都是你在做）──');
      parts.push(normalizeInternalExecutionNarrative(systemFeedback));
      parts.push('你的动作：继续多步计划的下一步 / 换个做法重试 / 放弃；需要时再 say 告诉主人（简单成功可不打扰）。');
    }
    if (isResume) {
      parts.push('');
      parts.push('（这是 ask_master 后的恢复 · 玩家刚答复了你的问题）');
    }
    // FEAT-NARR-01 · 近期事件通知（伙伴自己做/遇到的事）· 供大模型知情并自然带出
    if (this.cfg.recentNotices) {
      const notices = this.cfg.recentNotices();
      if (notices && notices.trim().length > 0) {
        parts.push('');
        parts.push('── 你最近做/遇到的事（内部执行记录 · 可在回答时自然提及，不必复述）──');
        parts.push(normalizeInternalExecutionNarrative(notices));
      }
    }
    // 热刷新 · 个性化记忆（每 turn 重读，存了立即生效）
    if (this.cfg.memoryBlock) {
      const mem = this.cfg.memoryBlock(userMessage);
      if (mem && mem.trim().length > 0) {
        parts.push('');
        parts.push('── 你记得的事（始终生效 · 自然融入对话，别生硬复述）──');
        parts.push(mem);
      }
    }
    if (this.cfg.companionBlock) {
      const companion = this.cfg.companionBlock();
      if (companion && companion.trim().length > 0) {
        parts.push('');
        parts.push(companion);
      }
    }
    // 热刷新 · 最近对话历史（每 turn 重读）
    if (this.cfg.conversationBlock) {
      const conv = this.cfg.conversationBlock();
      if (conv && conv.trim().length > 0) {
        parts.push('');
        parts.push(conv);
      }
    }
    return parts.join('\n');
  }

  /**
   * 把 ToolResult 压缩成 LLM 友好的 JSON 字符串（FEAT-L7-02 透传 reason + worldSnapshot）。
   * 与 hermes_bridge.py _slim_result 等价。
   */
  private formatToolResult(r: ToolResult): string {
    const payload: Record<string, unknown> = { ok: r.ok, result: r.result };
    if (r.reason !== undefined) payload['reason'] = r.reason;
    if (r.worldSnapshot !== undefined) payload['worldSnapshot'] = r.worldSnapshot;
    try {
      return JSON.stringify(payload);
    } catch {
      return JSON.stringify({ ok: r.ok, result: { error: 'unserializable' } });
    }
  }

  /** 把一条 HistoryEntry 还原成 assistant + tool 消息对，放进 messages 数组 */
  private appendHistoryToMessages(messages: LLMChatMessage[], h: HistoryEntry): void {
    const callId = h.toolCallId
      ?? h.assistant?.tool_calls?.[0]?.id
      ?? `restored_${Math.random().toString(36).slice(2, 10)}`;
    messages.push(restoredAssistantMessage(h, callId));
    messages.push({
      role: 'tool',
      tool_call_id: callId,
      content: this.formatToolResult(h.result),
    });
  }
}

function responseAssistantMessage(
  result: LLMToolCallResult,
  selected?: { id: string; name: string; arguments: Record<string, unknown> },
  contentOverride = result.content,
): LLMChatMessage {
  const message: LLMChatMessage = {
    role: 'assistant',
    content: contentOverride,
    ...(selected ? {
      tool_calls: [{
        id: selected.id,
        type: 'function',
        function: { name: selected.name, arguments: JSON.stringify(selected.arguments) },
      }],
    } : {}),
  };
  if (!result.canonical) return message;

  if (contentOverride !== result.content) {
    message.canonical = {
      role: 'assistant',
      content: contentOverride ? [{ kind: 'text', text: contentOverride }] : [],
    };
    return message;
  }

  const selectedIndexes: number[] = [];
  const content: LlmContentBlock[] = [];
  for (let index = 0; index < result.canonical.content.length; index += 1) {
    const block = result.canonical.content[index]!;
    if (block.kind === 'reasoning' || block.kind === 'text') {
      selectedIndexes.push(index);
      content.push(structuredClone(block));
    } else if (selected && block.kind === 'tool-call' && block.id === selected.id) {
      selectedIndexes.push(index);
      content.push({
        kind: 'tool-call', id: selected.id, name: selected.name,
        arguments: structuredClone(selected.arguments),
      });
    }
  }
  if (selected && !content.some(block => block.kind === 'tool-call' && block.id === selected.id)) {
    content.push({
      kind: 'tool-call', id: selected.id, name: selected.name,
      arguments: structuredClone(selected.arguments),
    });
  }

  const replay = result.canonical.replay;
  const replayAligned = replay?.blocks.length === result.canonical.content.length;
  const filteredReplay = replay && replayAligned
    ? { ...structuredClone(replay), blocks: selectedIndexes.map(index => structuredClone(replay.blocks[index] ?? null)) }
    : replay ? structuredClone(replay) : undefined;
  const canonical: CanonicalLlmMessage = {
    role: 'assistant',
    content,
    ...(replay
      ? {
          source: {
            providerRoute: replay.providerRoute,
            model: replay.model,
            ...(filteredReplay ? { replay: filteredReplay } : {}),
          },
        }
      : {}),
  };
  message.canonical = canonical;
  return message;
}

function restoredAssistantMessage(history: HistoryEntry, callId: string): LLMChatMessage {
  const restored = sanitizeStoredAssistant(history.assistant, callId);
  if (restored) return restored;
  return {
    role: 'assistant',
    content: '',
    tool_calls: [{
      id: callId,
      type: 'function',
      function: { name: history.call.tool, arguments: JSON.stringify(history.call.input) },
    }],
  };
}

function restoreHistoryEntry(value: unknown): HistoryEntry | null {
  if (!isPlainObject(value) || !isPlainObject(value.call) || !isPlainObject(value.result)) return null;
  if (typeof value.call.tool !== 'string' || !isPlainObject(value.call.input)) return null;
  if (typeof value.result.ok !== 'boolean' || !('result' in value.result)) return null;
  if (value.toolCallId !== undefined && typeof value.toolCallId !== 'string') return null;
  const toolCallId = typeof value.toolCallId === 'string' ? value.toolCallId : undefined;
  const assistant = sanitizeStoredAssistant(value.assistant, toolCallId);
  return {
    call: structuredClone(value.call) as unknown as ToolCall,
    result: structuredClone(value.result) as unknown as ToolResult,
    ...(toolCallId ? { toolCallId } : {}),
    ...(assistant ? { assistant } : {}),
  };
}

function sanitizeStoredAssistant(value: unknown, callId?: string): LLMChatMessage | null {
  if (!isPlainObject(value) || value.role !== 'assistant' || typeof value.content !== 'string') return null;
  if (!Array.isArray(value.tool_calls)) return null;
  const toolCalls = value.tool_calls.filter(isPlainObject);
  if (toolCalls.length !== value.tool_calls.length || toolCalls.length !== 1) return null;
  const toolCall = toolCalls[0]!;
  if (toolCall.type !== 'function' || typeof toolCall.id !== 'string' || !isPlainObject(toolCall.function)) return null;
  if (callId && toolCall.id !== callId) return null;
  if (typeof toolCall.function.name !== 'string' || typeof toolCall.function.arguments !== 'string') return null;
  try {
    JSON.parse(toolCall.function.arguments);
  } catch {
    return null;
  }
  return structuredClone(value) as unknown as LLMChatMessage;
}

function mainBrainContextManifest(
  messages: readonly LLMChatMessage[],
  toolCount: number,
): { selected: TraceContextSourceRef[]; omitted: [] } {
  const selected: TraceContextSourceRef[] = [];
  if (messages.length > 0) {
    selected.push({
      kind: 'mainbrain_system',
      ref: 'mainbrain:compiled-system/current-turn',
      characters: messages[0]!.content.length,
      messageIndexes: [0],
    });
  }
  if (messages.length > 2) {
    const indexes = messages.slice(1, -1).map((_message, index) => index + 1);
    selected.push({
      kind: 'conversation_tool_history',
      ref: `mainbrain:projected-history:${indexes.length}`,
      characters: indexes.reduce((total, index) => total + (messages[index]?.content.length ?? 0), 0),
      messageIndexes: indexes,
    });
  }
  if (messages.length > 1) {
    selected.push({
      kind: 'current_turn',
      ref: 'mainbrain:current-instruction',
      characters: messages.at(-1)!.content.length,
      messageIndexes: [messages.length - 1],
    });
  }
  selected.push({ kind: 'tool_registry', ref: `mainbrain:tools:${toolCount}` });
  return { selected, omitted: [] };
}

function toTraceJson(value: unknown): LlmTraceJsonValue {
  try {
    return JSON.parse(JSON.stringify(value ?? null)) as LlmTraceJsonValue;
  } catch {
    return '[unserializable tool payload]';
  }
}

/** BUG-CROSS-43：只面向用户输出可恢复信息，不暴露 Provider 响应体或内部堆栈。 */
export function llmFailureMessage(failure: LLMFailure): string {
  switch (failure.kind) {
    case 'billing':
      return '现在暂时没法回复：模型服务余额不足，请在设置里补充余额后再试。';
    case 'auth':
    case 'not_configured':
    case 'unsupported':
    case 'bad_request':
      return '现在暂时没法回复：模型服务配置有问题，请在设置里检查 API Key 和模型配置。';
    case 'rate_limit':
      return '模型服务请求太频繁了，请稍后再试。';
    case 'timeout':
      return '模型服务响应超时了，请稍后再试。';
    case 'trace_unavailable':
      return '模型调用轨迹暂时无法安全保存，本次请求没有发送，请稍后再试。';
    case 'network':
    case 'unavailable':
    case 'unknown':
      return '模型服务暂时不可用，请检查网络或稍后再试。';
  }
}

export interface LegacyActionResult {
  thought: string;
  call: ToolCall;
}

/**
 * BUG-CROSS-47 · 只兼容旧 prompt 产生的完整动作对象。
 * 混合文本、缺字段、数组 input 或普通 JSON 都不当作可执行工具调用。
 */
export function parseLegacyActionJson(text: string): LegacyActionResult | null {
  if (!text.trim()) return null;

  let candidate = text.trim();
  const fenced = candidate.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) candidate = fenced[1]?.trim() ?? '';

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;
  if (!Object.keys(parsed).every(key => key === 'thought' || key === 'action')) return null;
  if (parsed.thought !== undefined && typeof parsed.thought !== 'string') return null;
  if (!isPlainObject(parsed.action)) return null;
  if (!Object.keys(parsed.action).every(key => key === 'tool' || key === 'input')) return null;

  const tool = typeof parsed.action.tool === 'string' ? parsed.action.tool.trim() : '';
  const input = parsed.action.input === undefined ? {} : parsed.action.input;
  if (!tool || !isPlainObject(input)) return null;

  return {
    thought: typeof parsed.thought === 'string' ? parsed.thought.trim() : '',
    call: { tool, input },
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function protocolCorrectionInstruction(): string {
  return [
    '[输出协议检查未通过]',
    '不要把 thought/action JSON 写进普通文本，也不要解释刚才的错误。',
    '请使用系统提供的原生 tool_calls 调用一个当前可用工具；普通聊天调用 say，需澄清时调用 ask_master。',
  ].join('\n');
}

/**
 * FEAT-L3-13 R3 · 剥掉 LLM 误把动作当文字吐出的 JSON 块。
 * 现象：模型本该调 tool_call，却把 {"thought":...,"action":{"tool":...,"input":...}} 当 content 文字返回，
 * 经隐式 say 漏进聊天。这里把这类 JSON 对象段删掉；若整体就是个动作块则返回 ''（调用方走兜底文案）。
 */
export function stripLeakedActionJson(text: string): string {
  if (!text) return '';
  const out = text
    .replace(/\{\s*"(?:thought|action|tool|input)"[\s\S]*\}/g, '')
    .trim();
  return out;
}

const SERVILE_RELATIONSHIP_STYLE = /主人|主仆|待命|听(?:你)?指令|等(?:你)?指令|听你安排|乖乖等|立马行动|随时奉陪|忠诚(?:于|地)?你/;

export function hasServileRelationshipStyle(text: string): boolean {
  return SERVILE_RELATIONSHIP_STYLE.test(text);
}

function terminalSpeechText(call: ToolCall): string {
  if (call.tool !== 'say' && call.tool !== 'ask_master') return '';
  const input = call.input as { text?: unknown; question?: unknown };
  const value = input.text ?? input.question;
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeGenericVocativeCall(call: ToolCall): ToolCall {
  if (call.tool !== 'say' && call.tool !== 'ask_master') return call;
  const input = call.input as Record<string, unknown>;
  const field = call.tool === 'say' || !('question' in input) ? 'text' : 'question';
  const value = input[field];
  if (typeof value !== 'string') return call;
  const normalized = stripGenericUserVocative(value);
  return normalized === value ? call : { ...call, input: { ...input, [field]: normalized } };
}

function relationshipRewriteInstruction(userMessage: string): string {
  return [
    '[角色口吻检查未通过]',
    '刚才的草稿把你写成了等待命令的下属或服务型助手。不要发送或解释那份草稿。',
    '请以有自己生活和想法的平等熟人身份，重新自然回答。禁止“主人、待命、指令、听安排、立马行动”等表达；不要用“朋友、玩家、用户、对方”等通用词称呼用户，也不要编造在线位置或游戏状态。',
    `用户刚才说：${userMessage}`,
  ].join('\n');
}

function identityRewriteInstruction(userMessage: string): string {
  return [
    '[身份一致性检查未通过]',
    '刚才的草稿把你的内部执行能力写成了另一个替你操作游戏的主体。不要发送、引用或解释那份草稿。',
    'GoalAgent 及其内部规划、执行、评判、恢复节点都是你的内部能力；你接下的任务必须用“我正在……/我刚才……”描述。',
    '不要向朋友提 task ID、running/paused、内部 Agent 名；Minecraft 服务器、网络、操作系统和外部服务等真实外部故障仍应如实点明。',
    `用户刚才说：${userMessage}`,
  ].join('\n');
}

function identitySafeFallback(): string {
  return '刚才的说法不准确，这件事是我在处理。我先确认一下当前进度，再跟你说清楚。';
}
