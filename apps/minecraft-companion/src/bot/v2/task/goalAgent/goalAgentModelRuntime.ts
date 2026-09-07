import type {
  LLMChatMessage,
  LLMToolCallResult,
  LLMToolSchema,
} from '../../cognitive/llm/types.js';
import type { PreparedGovernedToolCall } from '../../cognitive/llm/LLMClient.js';
import {
  GovernedLlmPort,
  type ContextCandidateV1,
  type GovernedLlmTransport,
  type GovernanceReceiptV1,
} from '../../cognitive/llm/contextGovernance.js';
import type { AgentContextPolicyConfigV1 } from '../../cognitive/llm/contextBudget.js';
import type { ExactModelRequest } from '../../cognitive/llm/apiCodec.js';
import type { ModelContextProfileResolution } from '../../../../llm/modelContextProfile.js';
import { tuning } from '../../infra/tuning.js';
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
import {
  GoalAgentContextReducer,
  type GoalAgentCompactionDraftV2,
  type GoalAgentCompactionProposalV2,
} from './goalAgentContextReducer.js';

export interface GoalAgentLegacyModelClient {
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
  tokenUsageSource?: 'provider' | 'estimated' | 'mixed';
}

export interface GoalAgentModelRuntimeOptions {
  compiler?: GoalAgentContextCompiler;
  eventLog: GoalAgentSessionEventLogPort;
  trace?: (trace: GoalAgentModelTrace) => void;
  timeoutMs?: number;
  maxTokensPerCall?: number;
  /** Internal test seam only. GoalAgentOptions never exposes this escape hatch. */
  allowLegacyTestClient?: boolean;
  contextPolicy?: () => Readonly<AgentContextPolicyConfigV1>;
}

export interface GoalAgentTerminalReflectionResult {
  callId: string;
  modelCallIndex: number;
  summary: string;
  promptTokens: number;
  completionTokens: number;
  tokenUsageSource?: 'provider' | 'estimated' | 'mixed';
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
  private readonly client: GoalAgentModelClient | GoalAgentLegacyModelClient;
  private readonly legacyTestClient: boolean;

  constructor(
    client: GoalAgentModelClient | GoalAgentLegacyModelClient,
    private readonly options: GoalAgentModelRuntimeOptions,
  ) {
    this.client = client;
    this.legacyTestClient = !isGovernedClient(client);
    if (this.legacyTestClient && !options.allowLegacyTestClient) {
      throw new Error('GoalAgent production model client must implement governed exact-request preparation');
    }
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
      historyRefs: projection.messageRefs,
      ...(projection.compaction ? { compaction: projection.compaction } : {}),
    });
    const modelCallIndex = state.budget.llmCalls + 1;
    const callId = `goalagent-${randomUUID()}`;
    const tools = invocation.tools ?? [];
    const toolChoice = invocation.toolChoice ?? (tools.length ? 'auto' : 'none');
    let raw: LLMToolCallResult;
    let governanceReceipt: GovernanceReceiptV1;
    let compaction: GoalAgentCompactionProposalV2 | undefined;
    let dispatchedMessages = compiled.messages;
    try {
      const transport = new GoalAgentGovernedTransport(this.client, this.legacyTestClient, {
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
      }, compiled.segments, (prepared, receiptPending) => {
        dispatchedMessages = structuredClone(prepared.messages);
        this.eventLog.appendSessionEvent({
          eventId: `${state.sessionId}:model-request:${callId}`,
          sessionId: state.sessionId,
          occurredAt: new Date().toISOString(),
          type: 'model.requested',
          node: invocation.node,
          stateRevision: state.revision,
          epoch: state.epoch,
          payload: {
            callId, modelCallIndex,
            messages: structuredClone(prepared.messages), tools: structuredClone(tools),
            toolChoice: structuredClone(toolChoice), exactRequest: structuredClone(prepared.exact),
            contextSources: structuredClone(prepared.contextSources),
            governance: structuredClone(receiptPending),
          },
        });
      });
      const governed = await new GovernedLlmPort<PreparedGoalAgentCall, LLMToolCallResult | null, GoalAgentCompactionDraftV2>({
        purpose: 'goalAgent',
        policy: this.options.contextPolicy ?? (() => tuning().agentContext),
        transport,
        reducer: new GoalAgentContextReducer(state),
      }).call(candidate(compiled.segments, tools, toolChoice, this.maxTokensPerCall), invocation.signal);
      if (governed.kind === 'cancelled') throw abortError();
      if (governed.kind !== 'completed') throw new GoalAgentContextGovernanceError(governed.reason, governed.detail);
      if (!governed.result) throw new GoalAgentModelUnavailableError();
      raw = governed.result;
      governanceReceipt = governed.receipt;
      compaction = governed.proposal ? finalizeCompaction(governed.proposal, governed.receipt) : undefined;
    } catch (error) {
      this.recordModelFailure(state, invocation.node, callId, modelCallIndex, error);
      throw error;
    }
    if (invocation.signal.aborted) {
      const error = abortError();
      this.recordModelFailure(state, invocation.node, callId, modelCallIndex, error);
      throw error;
    }
    const normalizedContent = raw.content.trim() || JSON.stringify({ toolCalls: raw.toolCalls });
    const estimatedPromptTokens = governanceReceipt.reconciliation?.actualInputTokens
      ?? governanceReceipt.measureAfter?.tokens ?? governanceReceipt.measureBefore.tokens;
    const estimatedCompletionTokens = estimateTokens(normalizedContent);
    const usage = selectTokenUsage(raw, estimatedPromptTokens, estimatedCompletionTokens);
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
        ...(raw.usage ? { usage: structuredClone(raw.usage) } : {}),
        ...(raw.canonical ? { canonical: structuredClone(raw.canonical) } : {}),
        tokenUsageSource: usage.source,
      },
    });
    const toolCalls = structuredClone(raw.toolCalls);
    const value = invocation.parse(normalizedContent, toolCalls);
    const assistant = assistantMessage(raw);
    const promptTokens = usage.promptTokens;
    const completionTokens = usage.completionTokens;
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
      omittedHistoryMessages: compaction?.omittedMessages ?? 0,
      promptTokens,
      completionTokens,
      tokenUsageSource: usage.source,
    };
    this.options.trace?.(trace);
    return {
      value,
      assistant,
      messagesToAppend,
      ...(compaction ? { compaction: structuredClone(compaction) } : {}),
      budget: next.budget,
      promptTokens,
      completionTokens,
      tokenUsageSource: usage.source,
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
      historyRefs: projection.messageRefs,
      ...(projection.compaction ? { compaction: projection.compaction } : {}),
    });
    const callId = `goalagent-reflection-${randomUUID()}`;
    const modelCallIndex = state.budget.llmCalls + 1;
    let raw: LLMToolCallResult;
    let governanceReceipt: GovernanceReceiptV1;
    try {
      const outputTokens = Math.min(1_024, this.maxTokensPerCall);
      const transport = new GoalAgentGovernedTransport(this.client, this.legacyTestClient, {
        messages: compiled.messages,
        tools: [],
        toolChoice: 'none',
        maxTokens: outputTokens,
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
      }, compiled.segments, prepared => {
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
            messages: structuredClone(prepared.messages), tools: [], toolChoice: 'none',
            exactRequest: structuredClone(prepared.exact),
            contextSources: structuredClone(prepared.contextSources),
          },
        });
      });
      const governed = await new GovernedLlmPort<PreparedGoalAgentCall, LLMToolCallResult | null, GoalAgentCompactionDraftV2>({
        purpose: 'background', policy: this.options.contextPolicy ?? (() => tuning().agentContext), transport,
        reducer: new GoalAgentContextReducer(state),
      }).call(candidate(compiled.segments, [], 'none', outputTokens), signal);
      if (governed.kind === 'cancelled') throw abortError();
      if (governed.kind !== 'completed') throw new GoalAgentContextGovernanceError(governed.reason, governed.detail);
      if (!governed.result) throw new GoalAgentModelUnavailableError();
      raw = governed.result;
      governanceReceipt = governed.receipt;
    } catch (error) {
      this.recordModelFailure(state, 'terminal', callId, modelCallIndex, error);
      throw error;
    }
    const estimatedPromptTokens = governanceReceipt.reconciliation?.actualInputTokens
      ?? governanceReceipt.measureAfter?.tokens ?? governanceReceipt.measureBefore.tokens;
    const estimatedCompletionTokens = estimateTokens(raw.content);
    const usage = selectTokenUsage(raw, estimatedPromptTokens, estimatedCompletionTokens);
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
        ...(raw.usage ? { usage: structuredClone(raw.usage) } : {}),
        ...(raw.canonical ? { canonical: structuredClone(raw.canonical) } : {}),
        tokenUsageSource: usage.source,
      },
    });
    const summary = reflectionSummary(raw.content);
    const promptTokens = usage.promptTokens;
    const completionTokens = usage.completionTokens;
    this.options.trace?.({
      callId, sessionId: state.sessionId, node: 'terminal', contextRevision: state.revision,
      modelCallIndex, epoch: state.epoch, projectedMessages: compiled.projectedHistoryMessages,
      omittedHistoryMessages: 0, promptTokens, completionTokens,
      tokenUsageSource: usage.source,
    });
    return { callId, modelCallIndex, summary, promptTokens, completionTokens, tokenUsageSource: usage.source };
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

interface PreparedGoalAgentCall {
  exact: Readonly<ExactModelRequest>;
  messages: LLMChatMessage[];
  contextSources: LlmTraceCallContext['contextSources'];
  production?: PreparedGovernedToolCall;
  legacyArgs?: Parameters<GoalAgentLegacyModelClient['callWithTools']>[0];
}

class GoalAgentGovernedTransport implements GovernedLlmTransport<PreparedGoalAgentCall, LLMToolCallResult | null> {
  constructor(
    private readonly client: GoalAgentModelClient | GoalAgentLegacyModelClient,
    private readonly legacyTestClient: boolean,
    private readonly baseArgs: Parameters<GoalAgentLegacyModelClient['callWithTools']>[0],
    private readonly originalSegments: readonly import('../../cognitive/llm/contextGovernance.js').ContextSegmentV1[],
    private readonly beforeDispatch: (prepared: PreparedGoalAgentCall, preflight: Record<string, unknown>) => void,
  ) {}

  profile(): ModelContextProfileResolution {
    return isGovernedClient(this.client) ? this.client.contextProfile() : legacyTestProfile();
  }

  prepare(candidateValue: Readonly<ContextCandidateV1>) {
    const messages = canonicalMessagesToLegacy(candidateValue.segments.flatMap(segment => segment.messages));
    const tools: LLMToolSchema[] = candidateValue.tools.map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: structuredClone(tool.parameters) as LLMToolSchema['function']['parameters'],
      },
    }));
    const toolChoice = typeof candidateValue.toolChoice === 'object'
      ? { type: 'function' as const, function: { name: candidateValue.toolChoice.name } }
      : candidateValue.toolChoice;
    const contextSources = contextSourcesForSegments(candidateValue.segments, this.originalSegments);
    const args = {
      ...this.baseArgs,
      messages,
      tools,
      ...(toolChoice ? { toolChoice } : {}),
      temperature: candidateValue.temperature ?? this.baseArgs.temperature,
      maxTokens: candidateValue.requestedOutputTokens,
      traceContext: this.baseArgs.traceContext
        ? { ...this.baseArgs.traceContext, contextSources }
        : undefined,
    };
    if (isGovernedClient(this.client)) {
      const production = this.client.prepareGovernedToolCall(args);
      return {
        exact: production.exact,
        prepared: { exact: production.exact, messages, contextSources, production },
      };
    }
    if (!this.legacyTestClient) throw new Error('legacy GoalAgent transport is disabled');
    const exact = legacyExactRequest(args);
    return { exact, prepared: { exact, messages, contextSources, legacyArgs: args } };
  }

  async dispatch(prepared: PreparedGoalAgentCall, signal?: AbortSignal) {
    const profile = this.profile();
    this.beforeDispatch(prepared, {
      profile: profile.kind === 'resolved' ? profile.profile.profileId : 'unresolved',
      exactRequestDigest: shortDigest(JSON.stringify(prepared.exact)),
    });
    const value = prepared.production && isGovernedClient(this.client)
      ? await this.client.dispatchPreparedGovernedToolCall(prepared.production)
      : await this.client.callWithTools({ ...prepared.legacyArgs!, signal: signal ?? prepared.legacyArgs!.signal });
    if (signal?.aborted) throw abortError();
    return { value, ...(value?.usage?.inputTokens !== undefined ? { actualInputTokens: value.usage.inputTokens } : {}) };
  }
}

function candidate(
  segments: ContextCandidateV1['segments'],
  tools: readonly LLMToolSchema[],
  toolChoice: NonNullable<Parameters<GoalAgentLegacyModelClient['callWithTools']>[0]['toolChoice']>,
  requestedOutputTokens: number,
): ContextCandidateV1 {
  return Object.freeze({
    segments: Object.freeze([...segments]),
    tools: Object.freeze(tools.map(tool => Object.freeze({
      name: tool.function.name,
      description: tool.function.description,
      parameters: structuredClone(tool.function.parameters),
    }))),
    toolChoice: typeof toolChoice === 'object' ? { name: toolChoice.function.name } : toolChoice,
    temperature: 0.1,
    requestedOutputTokens,
  });
}

function finalizeCompaction(
  draft: GoalAgentCompactionDraftV2,
  receipt: GovernanceReceiptV1,
): GoalAgentCompactionProposalV2 {
  return {
    ...structuredClone(draft),
    profileRef: receipt.profileId,
    policyRevision: receipt.policyRevision,
    tokensBefore: receipt.measureBefore.upperBoundTokens,
    tokensAfter: receipt.measureAfter?.upperBoundTokens ?? receipt.measureBefore.upperBoundTokens,
  };
}

function isGovernedClient(client: GoalAgentModelClient | GoalAgentLegacyModelClient): client is GoalAgentModelClient {
  const value = client as Partial<GoalAgentModelClient>;
  return typeof value.contextProfile === 'function'
    && typeof value.prepareGovernedToolCall === 'function'
    && typeof value.dispatchPreparedGovernedToolCall === 'function';
}

/** Explicit test adapter; production composition must inject LLMClient directly. */
export function createGoalAgentTestModelClient(client: GoalAgentLegacyModelClient): GoalAgentModelClient {
  return {
    callWithTools: args => client.callWithTools(args),
    contextProfile: legacyTestProfile,
    prepareGovernedToolCall(args) {
      const detached = { ...args, messages: structuredClone(args.messages), tools: structuredClone(args.tools) };
      return Object.freeze({ exact: Object.freeze(legacyExactRequest(detached)), args: detached });
    },
    dispatchPreparedGovernedToolCall(prepared) { return client.callWithTools(prepared.args); },
  };
}

function legacyTestProfile(): ModelContextProfileResolution {
  return { kind: 'resolved', profile: Object.freeze({
    schema: 'mineclaw.model-context-profile/v1', profileId: 'goalagent-legacy-test-double/v1',
    routeId: 'goalagent-test', model: 'goalagent-test-double', api: 'openai-completions',
    contextWindowTokens: 1_048_576, maxOutputTokens: 65_536,
    windowAccounting: 'input_plus_output', tokenizerRef: 'wire-json-utf8-upper-bound/v1',
    source: { kind: 'explicit_config' as const, version: 'test-only/v1', verifiedAt: '2026-09-06T00:00:00.000Z' },
  }) };
}

function legacyExactRequest(args: Parameters<GoalAgentLegacyModelClient['callWithTools']>[0]): ExactModelRequest {
  return {
    path: '/v1/chat/completions',
    body: {
      model: 'goalagent-test-double', messages: structuredClone(args.messages), tools: structuredClone(args.tools),
      tool_choice: structuredClone(args.toolChoice), temperature: args.temperature, max_tokens: args.maxTokens,
    },
  };
}

function canonicalMessagesToLegacy(messages: readonly import('../../cognitive/llm/types.js').CanonicalLlmMessage[]): LLMChatMessage[] {
  return messages.map(message => {
    const toolResult = message.content.length === 1 && message.content[0].kind === 'tool-result'
      ? message.content[0] : undefined;
    if (toolResult?.kind === 'tool-result') {
      return { role: 'tool', content: toolResult.output, tool_call_id: toolResult.callId, canonical: structuredClone(message) };
    }
    const text = message.content.filter(block => block.kind === 'text' || block.kind === 'reasoning')
      .map(block => block.kind === 'text' || block.kind === 'reasoning' ? block.text : '').join('\n');
    const calls = message.content.filter(block => block.kind === 'tool-call');
    return {
      role: message.role,
      content: text,
      canonical: structuredClone(message),
      ...(calls.length ? { tool_calls: calls.map(block => {
        if (block.kind !== 'tool-call') throw new Error('unreachable');
        return { id: block.id, type: 'function' as const, function: { name: block.name, arguments: JSON.stringify(block.arguments) } };
      }) } : {}),
    };
  });
}

function contextSourcesForSegments(
  segments: readonly import('../../cognitive/llm/contextGovernance.js').ContextSegmentV1[],
  original: readonly import('../../cognitive/llm/contextGovernance.js').ContextSegmentV1[],
) {
  let offset = 0;
  const selectedIds = new Set(segments.map(segment => segment.id));
  return {
    selected: segments.map(segment => {
      const messageIndexes = segment.messages.map(() => offset++);
      return { kind: segment.kind, ref: segment.sourceRefs.join(','), messageIndexes };
    }),
    omitted: original.filter(segment => !selectedIds.has(segment.id)).map(segment => ({
      kind: segment.kind,
      ref: segment.sourceRefs.join(','),
      reason: 'context_budget_reduced/v1',
    })),
  };
}

function shortDigest(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
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
    ...(result.canonical
      ? {
          canonical: {
            role: 'assistant' as const,
            content: structuredClone(result.canonical.content),
            ...(result.canonical.replay
              ? {
                  source: {
                    providerRoute: result.canonical.replay.providerRoute,
                    model: result.canonical.replay.model,
                    replay: structuredClone(result.canonical.replay),
                  },
                }
              : {}),
          },
        }
      : {}),
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

export class GoalAgentContextGovernanceError extends Error {
  constructor(readonly reason: string, detail?: string) {
    super(`GoalAgent context governance rejected the call: ${reason}${detail ? ` (${detail})` : ''}`);
    this.name = 'GoalAgentContextGovernanceError';
  }
}

/** Production GoalAgent clients must expose exact preparation and a frozen model profile. */
export interface GoalAgentModelClient extends GoalAgentLegacyModelClient {
  contextProfile(): ModelContextProfileResolution;
  prepareGovernedToolCall(args: Parameters<GoalAgentLegacyModelClient['callWithTools']>[0]): PreparedGovernedToolCall;
  dispatchPreparedGovernedToolCall(prepared: PreparedGovernedToolCall): Promise<LLMToolCallResult | null>;
}

function selectTokenUsage(
  result: LLMToolCallResult,
  estimatedPromptTokens: number,
  estimatedCompletionTokens: number,
): {
  promptTokens: number;
  completionTokens: number;
  source: 'provider' | 'estimated' | 'mixed';
} {
  const reportedPrompt = validTokenCount(result.usage?.inputTokens);
  const reportedCompletion = validTokenCount(result.usage?.outputTokens);
  return {
    promptTokens: reportedPrompt ?? estimatedPromptTokens,
    completionTokens: reportedCompletion ?? estimatedCompletionTokens,
    source: reportedPrompt !== undefined && reportedCompletion !== undefined
      ? 'provider'
      : reportedPrompt === undefined && reportedCompletion === undefined
        ? 'estimated'
        : 'mixed',
  };
}

function validTokenCount(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
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
