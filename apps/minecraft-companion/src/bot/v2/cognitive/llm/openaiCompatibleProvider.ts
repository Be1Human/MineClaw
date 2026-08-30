/**
 * OpenAI HTTP Adapter with a compatibility class name retained for extensions.
 * Wire payload construction and parsing live in API codecs.
 */
import { DEFAULT_LLM_API, type LlmApi } from '../../../../llm/api.js';
import type {
  CanonicalLlmCall,
  CanonicalLlmResult,
  LLMCallOptions,
  LLMProvider,
  LLMProviderCallResult,
  LLMProviderResult,
  LLMProviderToolCallResult,
  LLMToolCallOptions,
} from './types.js';
import { failureFromHttpStatus, isAbortError, LLMProviderError } from './errors.js';
import { canonicalizeChatMessages, canonicalizeChatTools } from './canonical.js';
import {
  ChatCompletionsCodec,
  canonicalResultToLegacyText,
  canonicalResultToLegacyToolResult,
} from './chatCompletionsCodec.js';
import {
  LlmApiCodecError,
  type ExactModelRequest,
  type LlmApiCodec,
  type LlmCodecRoute,
} from './apiCodec.js';
import { ResponsesCodec } from './responsesCodec.js';

const OPENAI_CODECS = new Map<LlmApi, LlmApiCodec>([
  ['openai-completions', new ChatCompletionsCodec()],
  ['openai-responses', new ResponsesCodec()],
]);

export interface PreparedOpenAIRequest {
  api: LlmApi;
  route: LlmCodecRoute;
  exact: ExactModelRequest;
}

/** Shared deterministic request preparation used by both Trace and dispatch. */
export function prepareOpenAIRequest(
  opts: Pick<LLMCallOptions, 'routeId' | 'api' | 'baseUrl' | 'model'>,
  call: CanonicalLlmCall,
): PreparedOpenAIRequest {
  const api = opts.api ?? DEFAULT_LLM_API;
  const codec = OPENAI_CODECS.get(api);
  if (!codec) throw new LLMProviderError({ kind: 'unsupported' });
  const route = {
    routeId: opts.routeId ?? 'inline',
    baseUrl: opts.baseUrl.replace(/\/$/, ''),
    model: opts.model,
  };
  return { api, route, exact: codec.buildRequest(call, route) };
}

export class OpenAICompatibleProvider implements LLMProvider {
  readonly name: string = 'openai_compatible';

  /** Generic fallback. Ark remains a higher-priority provider route. */
  matches(_baseUrl: string): boolean {
    return true;
  }

  async call(opts: LLMCallOptions): Promise<LLMProviderCallResult> {
    const call: CanonicalLlmCall = {
      messages: [
        ...(opts.system ? [{ role: 'system' as const, content: [{ kind: 'text' as const, text: opts.system }] }] : []),
        { role: 'user', content: [{ kind: 'text', text: opts.user }] },
      ],
      tools: [],
      temperature: opts.temperature,
      maxTokens: opts.maxTokens,
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
    };
    const result = await this.execute(opts, call, 30_000);
    return providerResult(canonicalResultToLegacyText(result), result);
  }

  async callWithTools(opts: LLMToolCallOptions): Promise<LLMProviderToolCallResult> {
    const call: CanonicalLlmCall = {
      messages: canonicalizeChatMessages(opts.messages),
      tools: canonicalizeChatTools(opts.tools),
      toolChoice: opts.tools.length
        ? (typeof opts.toolChoice === 'object'
            ? { name: opts.toolChoice.function.name }
            : opts.toolChoice)
        : undefined,
      temperature: opts.temperature,
      maxTokens: opts.maxTokens,
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
    };
    const result = await this.execute(opts, call, 60_000);
    return providerResult(canonicalResultToLegacyToolResult(result), result);
  }

  private async execute(
    opts: Pick<LLMCallOptions, 'routeId' | 'api' | 'apiKey' | 'baseUrl' | 'model' | 'timeoutMs' | 'signal'>,
    call: CanonicalLlmCall,
    defaultTimeoutMs: number,
  ): Promise<CanonicalLlmResult> {
    const { api, route, exact } = prepareOpenAIRequest(opts, call);
    const codec = OPENAI_CODECS.get(api)!;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? defaultTimeoutMs);
    const linkedSignal = opts.signal ? mergeSignals(ctrl.signal, opts.signal) : ctrl.signal;

    try {
      const response = await fetch(`${route.baseUrl}${exact.path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${opts.apiKey}`,
        },
        body: JSON.stringify(exact.body),
        signal: linkedSignal,
      });
      if (!response.ok) {
        console.error(`[LLM] HTTP ${response.status} provider=${this.name} model=${opts.model}`);
        throw new LLMProviderError(failureFromHttpStatus(response.status));
      }
      return codec.parseResponse(await response.json() as unknown, route);
    } catch (error) {
      if (error instanceof LLMProviderError) throw error;
      if (error instanceof LlmApiCodecError) throw new LLMProviderError({ kind: 'bad_request' });
      if (opts.signal?.aborted && isAbortError(error)) throw error;
      if (ctrl.signal.aborted) throw new LLMProviderError({ kind: 'timeout' });
      throw new LLMProviderError({ kind: 'network' });
    } finally {
      clearTimeout(timer);
    }
  }
}

function providerResult<T>(value: T, result: CanonicalLlmResult): LLMProviderResult<T> {
  return {
    value,
    usage: result.usage,
    ...(result.finishReason ? { finishReason: result.finishReason } : {}),
    canonical: result,
  };
}

function mergeSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  if (a.aborted) return a;
  if (b.aborted) return b;
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  a.addEventListener('abort', onAbort, { once: true });
  b.addEventListener('abort', onAbort, { once: true });
  return ctrl.signal;
}
