/**
 * LLMClient —— 上层调用 LLM 的唯一入口
 *
 * 除 provider 路由外，这里也是生产 LLM 请求唯一的持久观测边界：
 * 最终模型输入必须先 durable append，才允许发给 provider。
 */
import { createHash, randomUUID } from 'node:crypto';
import type {
  LLMCallOptions,
  LLMChatMessage,
  LLMProvider,
  LLMToolCallOptions,
  LLMToolCallResult,
  LLMToolSchema,
} from './types.js';
import { ArkProvider } from './arkProvider.js';
import { OpenAICompatibleProvider } from './openaiCompatibleProvider.js';
import {
  failureFromError,
  isAbortError,
  type LLMFailure,
} from './errors.js';
import type {
  LlmRequestEnvelopeV1,
  LlmTraceCallContext,
  LlmTraceEventInputV1,
  LlmTraceJsonValue,
  LlmTraceRecorderPort,
} from '../../infra/llmTrace/index.js';
import { asProviderResult } from './usage.js';

export interface LLMClientConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  /** 显式指定 function calling 模型；不按模型名猜测。 */
  toolModel?: string;
}

export interface CallWithToolsArgs {
  messages: LLMChatMessage[];
  tools: LLMToolSchema[];
  toolChoice?: 'auto' | 'none' | { type: 'function'; function: { name: string } };
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  onError?: (failure: LLMFailure) => void;
  /** 调用方只标注业务来源，最终 request snapshot 由 LLMClient 生成。 */
  traceContext?: LlmTraceCallContext;
}

export interface LLMClientRuntimeOptions {
  traceRecorder?: LlmTraceRecorderPort;
  now?: () => Date;
  createId?: () => string;
}

export class LLMClient {
  private providers: LLMProvider[] = [];
  private readonly traceRecorder?: LlmTraceRecorderPort;
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly pendingPersistenceGaps: LlmTraceEventInputV1[] = [];

  constructor(
    private readonly config: LLMClientConfig,
    private readonly log: (category: string, message: string) => void,
    options: LLMClientRuntimeOptions = {},
  ) {
    this.traceRecorder = options.traceRecorder;
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
    this.providers.push(new ArkProvider());
    this.providers.push(new OpenAICompatibleProvider());
  }

  /** 允许运行时注册第三方 provider（通用 fallback 始终保持在最后）。 */
  register(provider: LLMProvider): void {
    const fallbackIndex = this.providers.length - 1;
    this.providers.splice(fallbackIndex, 0, provider);
  }

  /** 发起普通文本调用；失败维持既有 null 合同。 */
  async call(
    prompt: string,
    system?: string,
    traceContext?: LlmTraceCallContext,
  ): Promise<string | null> {
    const { apiKey, baseUrl, model } = this.config;
    if (!apiKey || !baseUrl) {
      this.log('brain:llm', 'LLM 未配置');
      return null;
    }
    const provider = this.providers.find(candidate => candidate.matches(baseUrl));
    if (!provider) {
      this.log('brain:llm', `无 provider 匹配 baseUrl=${baseUrl}`);
      return null;
    }

    const timeoutMs = 90_000;
    const providerRequest: LLMCallOptions = {
      apiKey,
      baseUrl,
      model,
      system,
      user: prompt,
      temperature: 0.7,
      maxTokens: 1_500,
      timeoutMs,
    };
    const request: LlmRequestEnvelopeV1 = {
      provider: provider.name,
      baseUrlOrigin: safeBaseUrlOrigin(baseUrl),
      model,
      messages: jsonClone([
        ...(system ? [{ role: 'system', content: system }] : []),
        { role: 'user', content: prompt },
      ]) as LlmTraceJsonValue[],
      tools: [],
      temperature: providerRequest.temperature,
      maxTokens: providerRequest.maxTokens,
      timeoutMs,
      context: traceContext?.contextSources ?? { selected: [], omitted: [] },
    };
    const startedAt = performance.now();
    const callId = await this.recordRequest(request, traceContext);
    if (callId === null) return null;

    try {
      const providerResult = asProviderResult(await provider.call(providerRequest));
      const content = providerResult.value;
      if (!content) this.log('brain:llm', `${provider.name} 返回空`);
      await this.recordTerminal({
        type: 'llm.response.recorded',
        callId,
        context: traceContext,
        payload: {
          content: content ?? '',
          empty: !content,
          durationMs: elapsedMs(startedAt),
          usage: jsonClone(providerResult.usage) as unknown as LlmTraceJsonValue,
          ...(providerResult.finishReason ? { finishReason: providerResult.finishReason } : {}),
        },
      });
      return content;
    } catch (error) {
      const failure = failureFromError(error);
      await this.recordTerminal({
        type: 'llm.call.failed',
        callId,
        context: traceContext,
        payload: failurePayload(failure, startedAt),
      });
      this.log('brain:llm', `${provider.name} 异常: ${(error as Error).message}`);
      return null;
    }
  }

  /** Function calling 调用；请求持久化失败时 provider 调用被硬阻断。 */
  async callWithTools(args: CallWithToolsArgs): Promise<LLMToolCallResult | null> {
    const { apiKey, baseUrl } = this.config;
    if (!apiKey || !baseUrl) {
      this.log('brain:llm', 'LLM 未配置');
      args.onError?.({ kind: 'not_configured' });
      return null;
    }
    const provider = this.providers.find(candidate => candidate.matches(baseUrl));
    if (!provider?.callWithTools) {
      this.log('brain:llm', `provider 不支持 function calling: ${provider?.name ?? '<none>'}`);
      args.onError?.({ kind: 'unsupported' });
      return null;
    }

    const model = this.resolveToolModel();
    const timeoutMs = args.timeoutMs ?? 90_000;
    const toolChoice: NonNullable<CallWithToolsArgs['toolChoice']> = args.toolChoice ?? 'auto';
    const providerRequest: LLMToolCallOptions = {
      apiKey,
      baseUrl,
      model,
      messages: args.messages,
      tools: args.tools,
      toolChoice,
      temperature: args.temperature ?? 0.1,
      maxTokens: args.maxTokens ?? 512,
      timeoutMs,
      signal: args.signal,
    };
    const request: LlmRequestEnvelopeV1 = {
      provider: provider.name,
      baseUrlOrigin: safeBaseUrlOrigin(baseUrl),
      model,
      messages: jsonClone(args.messages) as unknown as LlmTraceJsonValue[],
      tools: jsonClone(args.tools) as unknown as LlmTraceJsonValue[],
      toolChoice: jsonClone(toolChoice) as unknown as LlmTraceJsonValue,
      temperature: providerRequest.temperature,
      maxTokens: providerRequest.maxTokens,
      timeoutMs,
      context: args.traceContext?.contextSources ?? { selected: [], omitted: [] },
    };
    const startedAt = performance.now();
    const callId = await this.recordRequest(request, args.traceContext);
    if (callId === null) {
      args.onError?.({ kind: 'trace_unavailable' });
      return null;
    }

    try {
      const providerResult = asProviderResult(await provider.callWithTools(providerRequest));
      const result = providerResult.value;
      if (!result) this.log('brain:llm', `${provider.name} callWithTools 返回空`);
      await this.recordTerminal({
        type: 'llm.response.recorded',
        callId,
        context: args.traceContext,
        payload: {
          content: result?.content ?? '',
          toolCalls: jsonClone(result?.toolCalls ?? []) as unknown as LlmTraceJsonValue,
          empty: !result,
          durationMs: elapsedMs(startedAt),
          usage: jsonClone(providerResult.usage) as unknown as LlmTraceJsonValue,
          ...(providerResult.finishReason ? { finishReason: providerResult.finishReason } : {}),
        },
      });
      return result;
    } catch (error) {
      if (args.signal?.aborted && isAbortError(error)) {
        await this.recordTerminal({
          type: 'llm.call.cancelled',
          callId,
          context: args.traceContext,
          payload: {
            reason: args.traceContext?.abortReason ?? 'caller_abort',
            durationMs: elapsedMs(startedAt),
          },
        });
        return null;
      }
      const failure = failureFromError(error);
      await this.recordTerminal({
        type: 'llm.call.failed',
        callId,
        context: args.traceContext,
        payload: failurePayload(failure, startedAt),
      });
      this.log('brain:llm', `${provider.name} callWithTools 异常: ${(error as Error).message}`);
      args.onError?.(failure);
      return null;
    }
  }

  private resolveToolModel(): string {
    return this.config.toolModel ?? this.config.model;
  }

  private async recordRequest(
    request: LlmRequestEnvelopeV1,
    context: LlmTraceCallContext | undefined,
  ): Promise<string | null> {
    const callId = context?.callId ?? this.createId();
    if (!this.traceRecorder) return callId;
    try {
      await this.flushPendingPersistenceGaps();
      await this.traceRecorder.append(traceEventInput({
        type: 'llm.request.recorded',
        callId,
        context,
        occurredAt: this.now().toISOString(),
        payload: {
          request: jsonClone(request) as unknown as LlmTraceJsonValue,
          inputHash: hashRequest(request),
          recordedBeforeDispatch: true,
        },
      }));
      return callId;
    } catch (error) {
      this.log('brain:llm', `trace_unavailable: ${safeErrorName(error)}`);
      return null;
    }
  }

  private async recordTerminal(input: {
    type: 'llm.response.recorded' | 'llm.call.failed' | 'llm.call.cancelled';
    callId: string;
    context: LlmTraceCallContext | undefined;
    payload: Record<string, LlmTraceJsonValue>;
  }): Promise<void> {
    if (!this.traceRecorder) return;
    const event = traceEventInput({
      type: input.type,
      callId: input.callId,
      context: input.context,
      occurredAt: this.now().toISOString(),
      payload: input.payload,
    });
    try {
      await this.traceRecorder.append(event);
    } catch (error) {
      this.pendingPersistenceGaps.push(traceEventInput({
        type: 'trace.persistence_gap',
        callId: input.callId,
        context: input.context,
        occurredAt: this.now().toISOString(),
        payload: {
          missingEventType: input.type,
          reason: safeErrorName(error),
        },
      }));
      this.log('brain:llm', `trace:fatal terminal append failed callId=${input.callId} type=${input.type}`);
    }
  }

  private async flushPendingPersistenceGaps(): Promise<void> {
    if (!this.traceRecorder) return;
    while (this.pendingPersistenceGaps.length > 0) {
      await this.traceRecorder.append(this.pendingPersistenceGaps[0]!);
      this.pendingPersistenceGaps.shift();
    }
  }

  static parseJSON<T = unknown>(content: string): T | { __unparsed: string } {
    let cleaned = content.trim();
    cleaned = cleaned.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '');
    cleaned = cleaned.trim();
    try {
      return JSON.parse(cleaned) as T;
    } catch {
      return { __unparsed: cleaned.slice(0, 120) };
    }
  }
}

function traceEventInput(input: {
  type: LlmTraceEventInputV1['type'];
  callId: string;
  context: LlmTraceCallContext | undefined;
  occurredAt: string;
  payload: Record<string, LlmTraceJsonValue>;
}): LlmTraceEventInputV1 {
  const context = input.context;
  return {
    occurredAt: input.occurredAt,
    type: input.type,
    callId: input.callId,
    parentCallId: context?.parentCallId,
    correlationId: context?.correlationId,
    interactionSessionId: context?.interactionSessionId,
    goalSessionId: context?.goalSessionId,
    taskId: context?.taskId,
    agent: context?.agent ?? 'unknown',
    node: context?.node,
    turn: context?.turn,
    modelCallIndex: context?.modelCallIndex,
    stateRevision: context?.stateRevision,
    epoch: context?.epoch,
    payload: input.payload,
  };
}

function failurePayload(failure: LLMFailure, startedAt: number): Record<string, LlmTraceJsonValue> {
  return {
    failure: failure.kind,
    ...(failure.status === undefined ? {} : { status: failure.status }),
    durationMs: elapsedMs(startedAt),
  };
}

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function hashRequest(request: LlmRequestEnvelopeV1): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(request)).digest('hex')}`;
}

function safeBaseUrlOrigin(baseUrl: string): string | undefined {
  try {
    return new URL(baseUrl).origin;
  } catch {
    return undefined;
  }
}

function elapsedMs(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

function safeErrorName(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}
