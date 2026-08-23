/**
 * OpenAI Chat Completions 兼容协议 —— 默认 fallback 实现
 *
 * 适用于：
 * - OpenAI 官方
 * - DeepSeek / 月之暗面 / 智谱 / Moonshot 等绝大多数国产兼容厂商
 * - 火山引擎 Ark（也兼容此协议，故同时由 arkProvider 显式声明）
 */
import type {
  LLMProvider, LLMCallOptions,
  LLMProviderCallResult, LLMProviderResult,
  LLMProviderToolCallResult, LLMToolCallOptions, LLMToolCallResult,
} from './types.js';
import { failureFromHttpStatus, isAbortError, LLMProviderError } from './errors.js';
import { normalizeOpenAICompatibleUsage } from './usage.js';

export class OpenAICompatibleProvider implements LLMProvider {
  readonly name: string = 'openai_compatible';

  /** 通用兜底：任何 baseUrl 都匹配。registry 应把它放到最后。 */
  matches(_baseUrl: string): boolean {
    return true;
  }

  async call(opts: LLMCallOptions): Promise<LLMProviderCallResult> {
    const { apiKey, baseUrl, model, system, user, temperature, maxTokens, timeoutMs, signal } = opts;

    const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs ?? 30_000);
    const linkedSignal = signal
      ? mergeSignals(ctrl.signal, signal)
      : ctrl.signal;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            ...(system ? [{ role: 'system', content: system }] : []),
            { role: 'user', content: user },
          ],
          temperature: temperature ?? 0.7,
          max_tokens: maxTokens ?? 1500,
        }),
        signal: linkedSignal,
      });

      if (!response.ok) {
        throw new LLMProviderError(failureFromHttpStatus(response.status));
      }

      const data = await response.json() as {
        choices?: Array<{
          finish_reason?: string;
          message?: { content?: string; reasoning_content?: string };
        }>;
        usage?: unknown;
      };
      const choice = data.choices?.[0];
      const msg = choice?.message;
      // 推理模型（如 DeepSeek-R1/V4-Flash）将回答放在 reasoning_content，content 为空。
      // FEAT-WEBUI-09 · 剥 <think> 标签，思考不外泄进回答（与 callWithTools 对齐）。
      const stripThink = (s: string): string =>
        s.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<think>[\s\S]*$/i, '').trim();
      const content = stripThink(msg?.content ?? '');
      const usage = normalizeOpenAICompatibleUsage(data.usage);
      if (content) return providerResult(content, usage, choice?.finish_reason);
      const reasoning = stripThink(msg?.reasoning_content ?? '');
      return providerResult(reasoning || null, usage, choice?.finish_reason);
    } catch (error) {
      if (error instanceof LLMProviderError) throw error;
      if (signal?.aborted && isAbortError(error)) throw error;
      if (ctrl.signal.aborted) throw new LLMProviderError({ kind: 'timeout' });
      throw new LLMProviderError({ kind: 'network' });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Function calling · 与 hermes_bridge.py 的 _LLMClient.call_with_tools 对等。
   * 自动注入 DeepSeek thinking-disabled hack（思考模型支持工具调用的必需开关）。
   */
  async callWithTools(opts: LLMToolCallOptions): Promise<LLMProviderToolCallResult> {
    const { apiKey, baseUrl, model, messages, tools, toolChoice, temperature, maxTokens, timeoutMs, signal } = opts;

    const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs ?? 60_000);
    const linkedSignal = signal
      ? mergeSignals(ctrl.signal, signal)
      : ctrl.signal;

    const body: Record<string, unknown> = {
      model,
      messages,
      tools,
      tool_choice: toolChoice ?? 'auto',
      temperature: temperature ?? 0.1,
      max_tokens: maxTokens ?? 512,
    };

    // DeepSeek 思考模型 → 关思考（兼容 + 加速 + 支持 tool calling）
    // hermes_bridge.py:228-229 的等价物
    if (baseUrl.toLowerCase().includes('deepseek')) {
      body['thinking'] = { type: 'disabled' };
    }

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: linkedSignal,
      });

      if (!response.ok) {
        // BUG-CROSS-43：只传递状态类别，不记录可能包含敏感细节的完整响应体。
        console.error(`[LLM] HTTP ${response.status} provider=openai_compatible model=${model}`);
        throw new LLMProviderError(failureFromHttpStatus(response.status));
      }

      const data = await response.json() as {
        choices?: Array<{
          finish_reason?: string;
          message?: {
            content?: string;
            tool_calls?: Array<{
              id: string;
              type?: string;
              function?: { name?: string; arguments?: string };
            }>;
          };
        }>;
        usage?: unknown;
      };

      const choice = data.choices?.[0];
      const msg = choice?.message;
      const usage = normalizeOpenAICompatibleUsage(data.usage);
      if (!msg) return providerResult(null, usage, choice?.finish_reason);

      const toolCalls: LLMToolCallResult['toolCalls'] = [];
      for (const tc of msg.tool_calls ?? []) {
        const name = tc.function?.name;
        if (!name || !tc.id) continue;
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.function?.arguments || '{}') as Record<string, unknown>;
        } catch {
          args = {};
        }
        toolCalls.push({ id: tc.id, name, arguments: args });
      }

      // 清理 <think>...</think> 段（部分思考模型即使禁用 thinking 仍会留标签）
      let content = msg.content ?? '';
      content = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

      return providerResult({ toolCalls, content }, usage, choice?.finish_reason);
    } catch (error) {
      if (error instanceof LLMProviderError) throw error;
      if (signal?.aborted && isAbortError(error)) throw error;
      if (ctrl.signal.aborted) throw new LLMProviderError({ kind: 'timeout' });
      throw new LLMProviderError({ kind: 'network' });
    } finally {
      clearTimeout(timer);
    }
  }
}

function providerResult<T>(
  value: T,
  usage: LLMProviderResult<T>['usage'],
  finishReason?: string,
): LLMProviderResult<T> {
  return {
    value,
    usage,
    ...(finishReason ? { finishReason } : {}),
  };
}

function mergeSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  if (a.aborted) return a;
  if (b.aborted) return b;
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  a.addEventListener('abort', onAbort);
  b.addEventListener('abort', onAbort);
  return ctrl.signal;
}
