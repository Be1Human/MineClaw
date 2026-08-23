import type {
  LLMChatMessage,
  LLMToolCallResult,
  LLMToolSchema,
} from '../../cognitive/llm/types.js';
import { cloneGoalAgentState, type GoalAgentNodeId, type GoalAgentStateV1 } from './goalAgentState.js';
import { GoalAgentContextCompiler } from './goalAgentContextCompiler.js';
import type {
  GoalAgentModelInvocation,
  GoalAgentModelPort,
  GoalAgentModelResponse,
} from './goalAgentRuntimeContracts.js';
import { randomUUID } from 'node:crypto';
import type { LlmTraceCallContext } from '../../infra/llmTrace/index.js';
import {
  type GoalAgentSessionEventLogPort,
} from './goalAgentSessionEventLog.js';

export interface GoalAgentModelClient {
  callWithTools(args: {
    messages: LLMChatMessage[];
    tools: LLMToolSchema[];
    toolChoice?: 'auto' | 'none' | { type: 'function'; function: { name: string } };
    temperature?: number;
    maxTokens?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
    traceContext?: LlmTraceCallContext;
  }): Promise<LLMToolCallResult | null>;
}

export interface GoalAgentModelTrace {
  callId: string;
  sessionId: string;
  node: GoalAgentNodeId;
  contextRevision: number;
  modelCallIndex: number;
  epoch: number;
  projectedMessages: number;
  omittedHistoryMessages: number;
  promptTokens: number;
  completionTokens: number;
}

export interface GoalAgentModelRuntimeOptions {
  compiler?: GoalAgentContextCompiler;
  eventLog: GoalAgentSessionEventLogPort;
  trace?: (trace: GoalAgentModelTrace) => void;
  timeoutMs?: number;
  maxTokensPerCall?: number;
}

export interface GoalAgentTerminalReflectionResult {
  callId: string;
  modelCallIndex: number;
  summary: string;
  promptTokens: number;
  completionTokens: number;
}

export class GoalAgentModelBudgetExceededError extends Error {
  constructor(readonly budget: 'llm_calls' | 'tokens') {
    super(`GoalAgent model ${budget} budget exhausted`);
    this.name = 'GoalAgentModelBudgetExceededError';
  }
}

export class GoalAgentModelContextConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GoalAgentModelContextConflictError';
  }
}

export class GoalAgentModelUnavailableError extends Error {
  constructor() {
    super('GoalAgent model returned no response');
    this.name = 'GoalAgentModelUnavailableError';
  }
}

/**
 * GoalAgentState.interactionSessionId identifies the GoalPort delivery session.
 * Traces must instead keep the originating MainBrain/player turn as their root
 * so both agents are queryable as one end-to-end interaction.
 */
export function goalAgentTraceInteractionId(
  state: Pick<GoalAgentStateV1, 'request'>,
): string {
  return state.request.meta.conversationId;
}

export class GoalAgentModelRuntime implements GoalAgentModelPort {
  private readonly compiler: GoalAgentContextCompiler;
  private readonly eventLog: GoalAgentSessionEventLogPort;
  private readonly timeoutMs: number;
  private readonly maxTokensPerCall: number;

  constructor(
    private readonly client: GoalAgentModelClient,
    private readonly options: GoalAgentModelRuntimeOptions,
  ) {
    this.compiler = options.compiler ?? new GoalAgentContextCompiler();
    this.eventLog = options.eventLog;
    this.timeoutMs = options.timeoutMs ?? 90_000;
    this.maxTokensPerCall = options.maxTokensPerCall ?? 4_096;
  }

  async invoke<T>(invocation: GoalAgentModelInvocation<T>): Promise<GoalAgentModelResponse<T>> {
    assertInvocation(invocation);
    const state = invocation.state;
    if (state.budget.llmCalls >= state.budget.maxLlmCalls) {
      throw new GoalAgentModelBudgetExceededError('llm_calls');
    }
    if (state.budget.maxTotalTokens !== null && totalTokens(state) >= state.budget.maxTotalTokens) {
      throw new GoalAgentModelBudgetExceededError('tokens');
    }
    if (invocation.signal.aborted) throw abortError();

    const projection = this.eventLog.projectMessages(state.sessionId);
    const compiled = this.compiler.compile({
      state,
      node: invocation.node,
      instruction: invocation.instruction,
      historyMessages: projection.messages,
      ...(projection.compactionSummary
        ? { compaction: {
            summary: projection.compactionSummary,
            throughMessageIndex: projection.compactedThroughMessageIndex,
          } }
        : {}),
    });
    const modelCallIndex = state.budget.llmCalls + 1;
    const callId = `goalagent-${randomUUID()}`;
    const tools = invocation.tools ?? [];
    const toolChoice = invocation.toolChoice ?? (tools.length ? 'auto' : 'none');
    this.eventLog.appendSessionEvent({
      eventId: `${state.sessionId}:model-request:${callId}`,
      sessionId: state.sessionId,
      occurredAt: new Date().toISOString(),
      type: 'model.requested',
      node: invocation.node,
      stateRevision: state.revision,
      epoch: state.epoch,
      payload: {
        callId,
        modelCallIndex,
        messages: structuredClone(compiled.messages),
        tools: structuredClone(tools),
        toolChoice: structuredClone(toolChoice),
        contextSources: structuredClone(compiled.contextSources),
      },
    });
    let raw: LLMToolCallResult | null;
    try {
      raw = await this.client.callWithTools({
        messages: compiled.messages,
        tools,
        toolChoice,
        maxTokens: this.maxTokensPerCall,
        timeoutMs: this.timeoutMs,
        signal: invocation.signal,
        traceContext: {
          callId,
          agent: 'goalagent',
          correlationId: state.request.meta.correlationId,
          interactionSessionId: goalAgentTraceInteractionId(state),
          goalSessionId: state.sessionId,
          taskId: state.requestId,
          node: invocation.node,
          modelCallIndex,
          stateRevision: state.revision,
          epoch: state.epoch,
          contextSources: compiled.contextSources,
          abortReason: 'goalagent_deadline_or_cancel',
        },
      });
    } catch (error) {
      this.recordModelFailure(state, invocation.node, callId, modelCallIndex, error);
      throw error;
    }
    if (invocation.signal.aborted) {
      const error = abortError();
      this.recordModelFailure(state, invocation.node, callId, modelCallIndex, error);
      throw error;
    }
    if (!raw) {
      const error = new GoalAgentModelUnavailableError();
      this.recordModelFailure(state, invocation.node, callId, modelCallIndex, error);
      throw error;
    }

    const normalizedContent = raw.content.trim() || JSON.stringify({ toolCalls: raw.toolCalls });
    this.eventLog.appendSessionEvent({
      eventId: `${state.sessionId}:model-response:${callId}`,
      sessionId: state.sessionId,
      occurredAt: new Date().toISOString(),
      type: 'model.responded',
      node: invocation.node,
      stateRevision: state.revision,
      epoch: state.epoch,
      payload: {
        callId,
        modelCallIndex,
        content: raw.content,
        toolCalls: structuredClone(raw.toolCalls),
      },
    });
    const toolCalls = structuredClone(raw.toolCalls);
    const value = invocation.parse(normalizedContent, toolCalls);
    const assistant = assistantMessage(raw);
    const promptTokens = estimateTokens(compiled.messages.map(message => message.content).join('\n'));
    const completionTokens = estimateTokens(normalizedContent);
    const replayInstruction = invocation.historyInstruction?.trim();
    const historyInstructionMessage: LLMChatMessage = replayInstruction
      ? {
          role: 'user',
          content: `[GoalAgent node=${invocation.node} stateRevision=${state.revision} epoch=${state.epoch}]\n${replayInstruction}`,
        }
      : compiled.instructionMessage;
    const messagesToAppend = [historyInstructionMessage, assistant].map(message => structuredClone(message));
    const next = cloneGoalAgentState(state);
    next.budget.llmCalls = modelCallIndex;
    next.budget.promptTokens += promptTokens;
    next.budget.completionTokens += completionTokens;

    const trace: GoalAgentModelTrace = {
      callId,
      sessionId: state.sessionId,
      node: invocation.node,
      contextRevision: state.revision,
      modelCallIndex,
      epoch: state.epoch,
      projectedMessages: compiled.projectedHistoryMessages,
      omittedHistoryMessages: compiled.omittedHistoryMessages,
      promptTokens,
      completionTokens,
    };
    this.options.trace?.(trace);
    return {
      value,
      assistant,
      messagesToAppend,
      ...(compiled.compaction ? { compaction: structuredClone(compiled.compaction) } : {}),
      budget: next.budget,
      promptTokens,
      completionTokens,
      modelCallIndex,
      contextRevision: state.revision,
      toolCalls,
    };
  }

  /**
   * Quarantined read-only reflection. It never appends to the main model
   * message surface and cannot change or revive terminal GoalAgent state.
   */
  async reflectTerminal(
    state: Readonly<GoalAgentStateV1>,
    signal: AbortSignal,
  ): Promise<GoalAgentTerminalReflectionResult> {
    if (!state.terminal || !isTerminalPhase(state.phase)) {
      throw new GoalAgentModelContextConflictError('terminal reflection requires immutable terminal state');
    }
    if (signal.aborted) throw abortError();
    const projection = this.eventLog.projectMessages(state.sessionId);
    const compiled = this.compiler.compile({
      state,
      node: 'terminal',
      instruction: [
        'Read the immutable terminal facts and summarize the reusable lesson.',
        'Do not claim success beyond the terminal outcome or evidence.',
        'Return JSON only: {"summary":"concise factual lesson"}.',
      ].join('\n'),
      historyMessages: projection.messages,
      ...(projection.compactionSummary
        ? { compaction: {
            summary: projection.compactionSummary,
            throughMessageIndex: projection.compactedThroughMessageIndex,
          } }
        : {}),
    });
    const callId = `goalagent-reflection-${randomUUID()}`;
    const modelCallIndex = state.budget.llmCalls + 1;
    this.eventLog.appendSessionEvent({
      eventId: `${state.sessionId}:model-request:${callId}`,
      sessionId: state.sessionId,
      occurredAt: new Date().toISOString(),
      type: 'model.requested',
      node: 'terminal',
      stateRevision: state.revision,
      epoch: state.epoch,
      payload: {
        callId, modelCallIndex, purpose: 'quarantined_reflection',
        messages: structuredClone(compiled.messages), tools: [], toolChoice: 'none',
        contextSources: structuredClone(compiled.contextSources),
      },
    });
    let raw: LLMToolCallResult | null;
    try {
      raw = await this.client.callWithTools({
        messages: compiled.messages,
        tools: [],
        toolChoice: 'none',
        maxTokens: Math.min(1_024, this.maxTokensPerCall),
        timeoutMs: this.timeoutMs,
        signal,
        traceContext: {
          callId,
          agent: 'goalagent',
          correlationId: state.request.meta.correlationId,
          interactionSessionId: goalAgentTraceInteractionId(state),
          goalSessionId: state.sessionId,
          taskId: state.requestId,
          node: 'terminal',
          modelCallIndex,
          stateRevision: state.revision,
          epoch: state.epoch,
          contextSources: compiled.contextSources,
          abortReason: 'goalagent_reflection_cancel',
        },
      });
    } catch (error) {
      this.recordModelFailure(state, 'terminal', callId, modelCallIndex, error);
      throw error;
    }
    if (!raw) {
      const error = new GoalAgentModelUnavailableError();
      this.recordModelFailure(state, 'terminal', callId, modelCallIndex, error);
      throw error;
    }
    this.eventLog.appendSessionEvent({
      eventId: `${state.sessionId}:model-response:${callId}`,
      sessionId: state.sessionId,
      occurredAt: new Date().toISOString(),
      type: 'model.responded',
      node: 'terminal',
      stateRevision: state.revision,
      epoch: state.epoch,
      payload: {
        callId, modelCallIndex, purpose: 'quarantined_reflection',
        content: raw.content, toolCalls: structuredClone(raw.toolCalls),
      },
    });
    const summary = reflectionSummary(raw.content);
    const promptTokens = estimateTokens(compiled.messages.map(message => message.content).join('\n'));
    const completionTokens = estimateTokens(raw.content);
    this.options.trace?.({
      callId, sessionId: state.sessionId, node: 'terminal', contextRevision: state.revision,
      modelCallIndex, epoch: state.epoch, projectedMessages: compiled.projectedHistoryMessages,
      omittedHistoryMessages: compiled.omittedHistoryMessages, promptTokens, completionTokens,
    });
    return { callId, modelCallIndex, summary, promptTokens, completionTokens };
  }

  private recordModelFailure(
    state: Readonly<GoalAgentStateV1>,
    node: GoalAgentNodeId,
    callId: string,
    modelCallIndex: number,
    error: unknown,
  ): void {
    this.eventLog.appendSessionEvent({
      eventId: `${state.sessionId}:model-failed:${callId}`,
      sessionId: state.sessionId,
      occurredAt: new Date().toISOString(),
      type: 'model.failed',
      node,
      stateRevision: state.revision,
      epoch: state.epoch,
      payload: {
        callId,
        modelCallIndex,
        name: error instanceof Error ? error.name : 'Error',
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }
}

function assertInvocation<T>(invocation: GoalAgentModelInvocation<T>): void {
  if (invocation.sessionId !== invocation.state.sessionId) {
    throw new GoalAgentModelContextConflictError('GoalAgent model invocation sessionId does not match shared state');
  }
  if (invocation.expectedRevision !== invocation.state.revision) {
    throw new GoalAgentModelContextConflictError('GoalAgent model invocation revision is stale');
  }
  if (invocation.state.terminal) {
    throw new GoalAgentModelContextConflictError('GoalAgent model cannot run after terminal');
  }
  if (!invocation.instruction.trim()) throw new Error('GoalAgent model instruction is required');
}

function assistantMessage(result: LLMToolCallResult): LLMChatMessage {
  return {
    role: 'assistant',
    content: result.content,
    ...(result.toolCalls.length
      ? {
          tool_calls: result.toolCalls.map(call => ({
            id: call.id,
            type: 'function' as const,
            function: { name: call.name, arguments: JSON.stringify(call.arguments) },
          })),
        }
      : {}),
  };
}

function totalTokens(state: Readonly<GoalAgentStateV1>): number {
  return state.budget.promptTokens + state.budget.completionTokens;
}

function estimateTokens(content: string): number {
  return Math.max(1, Math.ceil(content.length / 4));
}

function abortError(): Error {
  const error = new Error('GoalAgent model invocation aborted');
  error.name = 'AbortError';
  return error;
}

function isTerminalPhase(phase: GoalAgentStateV1['phase']): boolean {
  return phase === 'completed' || phase === 'failed' || phase === 'cancelled' || phase === 'timed_out';
}

function reflectionSummary(content: string): string {
  try {
    const parsed = JSON.parse(content) as { summary?: unknown };
    if (typeof parsed.summary === 'string' && parsed.summary.trim()) return parsed.summary.trim();
  } catch {
    throw new Error('GoalAgent reflection response must be valid JSON');
  }
  throw new Error('GoalAgent reflection response requires summary');
}
