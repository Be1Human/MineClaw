/**
 * LLMProvider 接口 —— 一种 LLM 厂商的最小抽象
 *
 * 设计原则：
 * - 每个厂商实现一个 LLMProvider 文件（OCP：加新厂商只需新建文件 + 注册一行）
 * - 上层（Brain / LLMClient）不感知具体厂商
 */

export interface LLMCallOptions {
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
  cacheStatus: LLMCacheMetricStatus;
  /** 稳定字段族，不保存完整 Provider 原始响应。 */
  source: string;
}

/** 新 Provider 应返回该信封；LLMClient 仍接受旧值以兼容现有扩展和测试替身。 */
export interface LLMProviderResult<T> {
  value: T;
  usage: LLMUsage;
  finishReason?: string;
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
}
