/**
 * LLMProvider 接口 —— 一种 LLM 厂商的最小抽象
 *
 * 设计原则：
 * - 每个厂商实现一个 LLMProvider 文件（OCP：加新厂商只需新建文件 + 注册一行）
 * - 上层（Brain / LLMClient）不感知具体厂商
 */
import type { LlmApi } from '../../../../llm/api.js';

export interface LLMCallOptions {
  routeId: string;
  api: LlmApi;
  apiKey: string;
  baseUrl: string;
  model: string;
  system?: string;
  user: string;
  temperature?: number;
  maxTokens?: number;
  /** 超时毫秒，默认 30000 */
  timeoutMs?: number;
  /** 中断信号（外部主动 abort） */
  signal?: AbortSignal;
}

export interface LLMProvider {
  /** 厂商唯一名 —— 用于注册表查找 */
  readonly name: string;
  /**
   * 判断该厂商是否能处理这个 baseUrl。
   * registry 按注册顺序询问，第一个返回 true 的就采用。
   */
  matches(baseUrl: string): boolean;
  /**
   * 发起一次 LLM 调用，返回 assistant message 的 content 字符串；失败返回 null。
   */
  call(opts: LLMCallOptions): Promise<LLMProviderCallResult>;
  /**
   * OpenAI 兼容的 function calling 调用 · 可选实现。
   * 不支持的 provider 不必实现（LLMClient.callWithTools 会返回 null 兜底）。
   */
  callWithTools?(opts: LLMToolCallOptions): Promise<LLMProviderToolCallResult>;
}

// ── Provider 响应与 Usage 协议 ───────────────────────────────────────────

export type LLMCacheMetricStatus = 'reported' | 'unsupported' | 'unavailable' | 'bypass';

/** Provider API 返回的 token usage 归一化结果。 */
export interface LLMUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  cacheMissInputTokens?: number;
  cacheEligibleInputTokens?: number;
  cacheWriteInputTokens?: number;
  reasoningOutputTokens?: number;
  cacheStatus: LLMCacheMetricStatus;
  /** 稳定字段族，不保存完整 Provider 原始响应。 */
  source: string;
}

/** 新 Provider 应返回该信封；LLMClient 仍接受旧值以兼容现有扩展和测试替身。 */
export interface LLMProviderResult<T> {
  value: T;
  usage: LLMUsage;
  finishReason?: string;
  /** Protocol-neutral result used by migrated callers; legacy callers keep `value`. */
  canonical?: CanonicalLlmResult;
}

export type LLMProviderCallResult = string | null | LLMProviderResult<string | null>;
export type LLMProviderToolCallResult =
  | LLMToolCallResult
  | null
  | LLMProviderResult<LLMToolCallResult | null>;

export function isLLMProviderResult<T>(value: unknown): value is LLMProviderResult<T> {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<LLMProviderResult<T>>;
  return 'value' in candidate
    && Boolean(candidate.usage)
    && typeof candidate.usage === 'object'
    && typeof candidate.usage.cacheStatus === 'string'
    && typeof candidate.usage.source === 'string';
}

// ── Function Calling 协议 ─────────────────────────────────────────────────

export interface LLMToolSchema {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
}

export interface LLMChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /**
   * Protocol-neutral durable form. GoalAgent persists this alongside the
   * compatibility fields so Responses output items can be replayed safely.
   */
  canonical?: CanonicalLlmMessage;
  /** assistant 选择调用的工具列表 */
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  /** tool 角色消息对应的 call_id（必填） */
  tool_call_id?: string;
}

export interface LLMToolCallOptions {
  routeId: string;
  api: LlmApi;
  apiKey: string;
  baseUrl: string;
  model: string;
  messages: LLMChatMessage[];
  tools: LLMToolSchema[];
  toolChoice?: 'auto' | 'none' | { type: 'function'; function: { name: string } };
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface LLMToolCallResult {
  /** LLM 选择调用的工具（与 hermes_bridge 一致：只取第 0 个） */
  toolCalls: Array<{
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  }>;
  /** LLM 直接文字回复 · 无工具调用时使用 */
  content: string;
  /** Actual provider usage when the provider reports it. */
  usage?: LLMUsage;
  /** Structured result and optional provider-native replay envelope. */
  canonical?: CanonicalLlmResult;
}

// ── Protocol-neutral Agent contract ────────────────────────────────────────

export type LlmContentBlock =
  | { kind: 'text'; text: string }
  | { kind: 'reasoning'; text: string }
  | { kind: 'tool-call'; id: string; name: string; arguments: unknown }
  | { kind: 'tool-result'; callId: string; output: string };

export interface LlmReplayEnvelope {
  kind: 'openai-native';
  version: 1;
  api: LlmApi;
  providerRoute: string;
  model: string;
  response?: Record<string, unknown>;
  /** Opaque native metadata aligned one-to-one with the canonical blocks. */
  blocks: Array<Record<string, unknown> | null>;
}

export interface CanonicalLlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: LlmContentBlock[];
  source?: {
    providerRoute: string;
    model: string;
    replay?: LlmReplayEnvelope;
  };
}

export interface CanonicalLlmTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface CanonicalLlmCall {
  messages: CanonicalLlmMessage[];
  tools: CanonicalLlmTool[];
  toolChoice?: 'auto' | 'none' | { name: string };
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface CanonicalLlmResult {
  content: LlmContentBlock[];
  usage: LLMUsage;
  finishReason?: string;
  replay?: LlmReplayEnvelope;
}

export type LlmStreamChunk =
  | { type: 'block-start'; index: number; block: LlmContentBlock }
  | { type: 'block-delta'; index: number; delta: string }
  | { type: 'block-end'; index: number; block: LlmContentBlock }
  | { type: 'usage'; usage: LLMUsage }
  | { type: 'finish'; result: CanonicalLlmResult };
