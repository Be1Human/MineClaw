import {
  isLLMProviderResult,
  type LLMProviderResult,
  type LLMUsage,
} from './types.js';

type JsonRecord = Record<string, unknown>;

const UNSUPPORTED_SOURCE = 'usage_without_cache_details';
const MISSING_SOURCE = 'usage_not_reported';

/**
 * 归一化 OpenAI Chat Completions 兼容 usage。
 *
 * 支持两类生产字段族：
 * - prompt_tokens_details.cached_tokens / input_tokens_details.cached_tokens
 * - prompt_cache_hit_tokens / prompt_cache_miss_tokens
 */
export function normalizeOpenAICompatibleUsage(raw: unknown): LLMUsage {
  if (!isRecord(raw)) return unsupportedUsage(MISSING_SOURCE);

  const input = integerField(raw, ['prompt_tokens', 'input_tokens']);
  const output = integerField(raw, ['completion_tokens', 'output_tokens']);
  const total = integerField(raw, ['total_tokens']);
  if (input.invalid || output.invalid || total.invalid) {
    return unavailableUsage('invalid_usage_tokens');
  }

  const hit = integerField(raw, ['prompt_cache_hit_tokens']);
  const miss = integerField(raw, ['prompt_cache_miss_tokens']);
  if (hit.present || miss.present) {
    if (hit.invalid || miss.invalid || !hit.present || !miss.present) {
      return unavailableUsage('invalid_prompt_cache_tokens');
    }
    const eligible = hit.value! + miss.value!;
    if (input.present && input.value !== eligible) {
      return unavailableUsage('inconsistent_prompt_cache_tokens');
    }
    return reportedUsage({
      input: input.value ?? eligible,
      output: output.value,
      total: total.value,
      cached: hit.value!,
      miss: miss.value!,
      eligible,
      source: 'prompt_cache_hit_tokens+prompt_cache_miss_tokens',
    });
  }

  const detailResult = cacheDetails(raw, input);
  if (detailResult) {
    if ('error' in detailResult) return unavailableUsage(detailResult.error);
    return reportedUsage({
      input: input.value!,
      output: output.value,
      total: total.value,
      cached: detailResult.cached,
      miss: input.value! - detailResult.cached,
      eligible: input.value!,
      source: detailResult.source,
    });
  }

  return {
    ...(input.present ? { inputTokens: input.value } : {}),
    ...(output.present ? { outputTokens: output.value } : {}),
    ...(total.present ? { totalTokens: total.value } : {}),
    cacheStatus: 'unsupported',
    source: UNSUPPORTED_SOURCE,
  };
}

/** Responses usage adds cache-write and reasoning-token detail to the common fields. */
export function normalizeOpenAIResponsesUsage(raw: unknown): LLMUsage {
  const usage = normalizeOpenAICompatibleUsage(raw);
  if (!isRecord(raw)) return usage;

  const inputDetails = raw.input_tokens_details;
  const cacheWrite = isRecord(inputDetails)
    ? integerField(inputDetails, ['cache_write_tokens'])
    : { present: false, invalid: false } satisfies IntegerField;
  const outputDetails = raw.output_tokens_details;
  const reasoning = isRecord(outputDetails)
    ? integerField(outputDetails, ['reasoning_tokens'])
    : { present: false, invalid: false } satisfies IntegerField;

  if (cacheWrite.invalid || reasoning.invalid) {
    return { ...usage, source: `${usage.source}+invalid_responses_usage_details` };
  }
  return {
    ...usage,
    ...(cacheWrite.present ? { cacheWriteInputTokens: cacheWrite.value } : {}),
    ...(reasoning.present ? { reasoningOutputTokens: reasoning.value } : {}),
    source: `${usage.source}+responses_details`,
  };
}

export function unsupportedUsage(source = MISSING_SOURCE): LLMUsage {
  return { cacheStatus: 'unsupported', source };
}

export function unavailableUsage(source: string): LLMUsage {
  return { cacheStatus: 'unavailable', source };
}

/** 兼容旧 Provider/测试替身的裸返回值，并统一为结果信封。 */
export function asProviderResult<T>(value: T | LLMProviderResult<T>): LLMProviderResult<T> {
  if (isLLMProviderResult<T>(value)) return value;
  return { value, usage: unsupportedUsage() };
}

function reportedUsage(input: {
  input: number;
  output?: number;
  total?: number;
  cached: number;
  miss: number;
  eligible: number;
  source: string;
}): LLMUsage {
  return {
    inputTokens: input.input,
    ...(input.output === undefined ? {} : { outputTokens: input.output }),
    ...(input.total === undefined ? {} : { totalTokens: input.total }),
    cachedInputTokens: input.cached,
    cacheMissInputTokens: input.miss,
    cacheEligibleInputTokens: input.eligible,
    cacheStatus: 'reported',
    source: input.source,
  };
}

function cacheDetails(
  raw: JsonRecord,
  input: IntegerField,
): { cached: number; source: string } | { error: string } | null {
  const candidates: Array<[string, string]> = [
    ['prompt_tokens_details', 'cached_tokens'],
    ['input_tokens_details', 'cached_tokens'],
  ];
  for (const [containerName, fieldName] of candidates) {
    const container = raw[containerName];
    if (container === undefined) continue;
    if (!isRecord(container)) return { error: `invalid_${containerName}` };
    const cached = integerField(container, [fieldName]);
    if (!cached.present || cached.invalid || !input.present || cached.value! > input.value!) {
      return { error: `invalid_${containerName}_cached_tokens` };
    }
    return { cached: cached.value!, source: `${containerName}.${fieldName}` };
  }
  return null;
}

interface IntegerField {
  present: boolean;
  invalid: boolean;
  value?: number;
}

function integerField(record: JsonRecord, names: string[]): IntegerField {
  for (const name of names) {
    if (!(name in record)) continue;
    const value = record[name];
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
      return { present: true, invalid: true };
    }
    return { present: true, invalid: false, value: value as number };
  }
  return { present: false, invalid: false };
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
