/** Wire protocols supported by the first-party OpenAI HTTP adapter. */
export const LLM_APIS = ['openai-completions', 'openai-responses'] as const;

export type LlmApi = typeof LLM_APIS[number];

export const DEFAULT_LLM_API: LlmApi = 'openai-completions';

export function isLlmApi(value: unknown): value is LlmApi {
  return typeof value === 'string' && (LLM_APIS as readonly string[]).includes(value);
}

export function normalizeLlmApi(value: unknown): LlmApi {
  return isLlmApi(value) ? value : DEFAULT_LLM_API;
}
