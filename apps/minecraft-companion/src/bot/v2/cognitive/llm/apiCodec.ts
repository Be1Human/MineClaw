import type { LlmApi } from '../../../../llm/api.js';
import type { CanonicalLlmCall, CanonicalLlmResult } from './types.js';

export interface LlmCodecRoute {
  routeId: string;
  model: string;
  baseUrl: string;
}

export interface ExactModelRequest {
  path: string;
  body: Record<string, unknown>;
  replay?: {
    nativeMessages: number;
    rebuiltMessages: number;
    reasons: string[];
  };
}

export interface LlmApiCodec {
  readonly api: LlmApi;
  buildRequest(call: CanonicalLlmCall, route: LlmCodecRoute): ExactModelRequest;
  parseResponse(raw: unknown, route: LlmCodecRoute): CanonicalLlmResult;
}

export class LlmApiCodecError extends Error {
  readonly name = 'LlmApiCodecError';
}
