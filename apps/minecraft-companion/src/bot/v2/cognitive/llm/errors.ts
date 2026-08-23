export type LLMFailureKind =
  | 'not_configured'
  | 'unsupported'
  | 'auth'
  | 'billing'
  | 'rate_limit'
  | 'timeout'
  | 'unavailable'
  | 'bad_request'
  | 'network'
  | 'trace_unavailable'
  | 'unknown';

export interface LLMFailure {
  kind: LLMFailureKind;
  status?: number;
}

/** Provider 边界使用的脱敏错误；不得携带 API Key 或完整响应体。 */
export class LLMProviderError extends Error {
  constructor(
    readonly failure: LLMFailure,
    message = `LLM provider failure: ${failure.kind}`,
  ) {
    super(message);
    this.name = 'LLMProviderError';
  }
}

export function failureFromHttpStatus(status: number): LLMFailure {
  if (status === 401 || status === 403) return { kind: 'auth', status };
  if (status === 402) return { kind: 'billing', status };
  if (status === 408 || status === 504) return { kind: 'timeout', status };
  if (status === 429) return { kind: 'rate_limit', status };
  if (status >= 500) return { kind: 'unavailable', status };
  if (status >= 400) return { kind: 'bad_request', status };
  return { kind: 'unknown', status };
}

export function failureFromError(error: unknown): LLMFailure {
  if (error instanceof LLMProviderError) return error.failure;
  return { kind: 'unknown' };
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}
