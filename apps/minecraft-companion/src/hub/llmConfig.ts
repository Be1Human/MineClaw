import { normalizeLlmApi, type LlmApi } from '../llm/api.js';

export interface LlmConfig {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  api?: LlmApi;
}

export interface ResolvedLlmConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  api: LlmApi;
  routeId?: string;
}

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-4o-mini';

function clean(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function hasOwn(value: object, key: keyof LlmConfig): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

/**
 * Endpoint（Base URL + Model）必须来自同一配置层。
 *
 * 历史 Profile 可能只保存了 Key 或 Model。若继续逐字段 fallback，
 * 会把旧 Profile 与服务器默认 Provider 拼成一组无效身份。
 */
export function resolveProfileLlmConfig(
  profile: LlmConfig | undefined,
  fallback: LlmConfig | null | undefined,
  override?: LlmConfig,
): ResolvedLlmConfig {
  const defaultConfig: ResolvedLlmConfig = {
    apiKey: clean(fallback?.apiKey) ?? '',
    baseUrl: clean(fallback?.baseUrl) ?? DEFAULT_BASE_URL,
    model: clean(fallback?.model) ?? DEFAULT_MODEL,
    api: normalizeLlmApi(fallback?.api),
  };

  // llm-test 显式传来的空 Endpoint 表示测试服务器默认配置，
  // 不得悄悄回退到 Profile 已保存的 Endpoint。
  const endpointSource = override && (hasOwn(override, 'baseUrl') || hasOwn(override, 'model'))
    ? override
    : profile;
  const baseUrl = clean(endpointSource?.baseUrl);
  const model = clean(endpointSource?.model);

  if (!baseUrl || !model) return defaultConfig;

  return {
    apiKey: clean(override?.apiKey)
      ?? clean(profile?.apiKey)
      ?? defaultConfig.apiKey,
    baseUrl,
    model,
    api: normalizeLlmApi(endpointSource?.api),
  };
}
