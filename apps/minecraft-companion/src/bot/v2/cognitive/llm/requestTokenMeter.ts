import type { ModelContextProfileV1 } from '../../../../llm/modelContextProfile.js';
import type { ExactModelRequest } from './apiCodec.js';

export const TOKEN_MEASURE_SCHEMA = 'mineclaw.token-measure/v1' as const;

export interface TokenMeasureV1 {
  schema: typeof TOKEN_MEASURE_SCHEMA;
  tokens: number;
  upperBoundTokens: number;
  precision: 'exact' | 'conservative_upper_bound';
  tokenizerRef: string;
  sectionTokens: ReadonlyArray<{ sectionId: string; tokens: number }>;
}

export type TokenMeasureResult =
  | { kind: 'measured'; measure: Readonly<TokenMeasureV1> }
  | {
      kind: 'unavailable';
      tokenizerRef: string;
      reason: 'tokenizer_not_registered' | 'meter_failed' | 'invalid_measurement' | 'meter_fused_after_underestimate';
      detail: string;
    };

export interface RequestTokenMeasureInput {
  profile: Readonly<ModelContextProfileV1>;
  request: Readonly<ExactModelRequest>;
  sectionRequests?: ReadonlyArray<{ sectionId: string; request: Readonly<ExactModelRequest> }>;
}

export interface WireRequestTokenCount {
  tokens: number;
  upperBoundTokens: number;
  precision: 'exact' | 'conservative_upper_bound';
}

/** Minimal replaceable tokenizer/meter contract. Implementations may not return an unsafe lower bound. */
export interface WireRequestTokenizer {
  readonly tokenizerRef: string;
  measure(request: Readonly<ExactModelRequest>): WireRequestTokenCount;
}

export type TokenMeasureReconciliation =
  | { kind: 'verified'; actualInputTokens: number; headroomTokens: number }
  | { kind: 'underestimated'; actualInputTokens: number; upperBoundTokens: number; tokenizerRef: string };

/**
 * Registry and fuse are centralized so callers never branch on concrete tokenizer types.
 * A measured request is immutable and a failed/unknown meter never becomes a zero-token success.
 */
export class RequestTokenMeter {
  private readonly tokenizers = new Map<string, WireRequestTokenizer>();
  private readonly fused = new Set<string>();

  constructor(tokenizers: readonly WireRequestTokenizer[] = [new Utf8JsonWireUpperBoundTokenizer()]) {
    for (const tokenizer of tokenizers) this.register(tokenizer);
  }

  register(tokenizer: WireRequestTokenizer): void {
    const ref = tokenizer.tokenizerRef.trim();
    if (!ref) throw new Error('tokenizer_ref_required');
    if (this.tokenizers.has(ref)) throw new Error(`tokenizer_already_registered:${ref}`);
    this.tokenizers.set(ref, tokenizer);
  }

  measure(input: Readonly<RequestTokenMeasureInput>): TokenMeasureResult {
    const ref = input.profile.tokenizerRef;
    if (this.fused.has(ref)) {
      return unavailable(ref, 'meter_fused_after_underestimate', 'previous provider usage exceeded the reported upper bound');
    }
    const tokenizer = this.tokenizers.get(ref);
    if (!tokenizer) return unavailable(ref, 'tokenizer_not_registered', `no request token meter registered for ${ref}`);

    try {
      const total = tokenizer.measure(input.request);
      const totalProblem = validateCount(total);
      if (totalProblem) return unavailable(ref, 'invalid_measurement', totalProblem);
      const sectionTokens = (input.sectionRequests ?? []).map(section => {
        if (!section.sectionId.trim()) throw new Error('section_id_required');
        const count = tokenizer.measure(section.request);
        const problem = validateCount(count);
        if (problem) throw new Error(`section ${section.sectionId}: ${problem}`);
        return Object.freeze({ sectionId: section.sectionId, tokens: count.upperBoundTokens });
      });
      return Object.freeze({
        kind: 'measured' as const,
        measure: Object.freeze({
          schema: TOKEN_MEASURE_SCHEMA,
          tokens: total.tokens,
          upperBoundTokens: total.upperBoundTokens,
          precision: total.precision,
          tokenizerRef: ref,
          sectionTokens: Object.freeze(sectionTokens),
        }),
      });
    } catch (error) {
      return unavailable(ref, 'meter_failed', (error as Error).message);
    }
  }

  reconcile(measure: Readonly<TokenMeasureV1>, actualInputTokens: number): TokenMeasureReconciliation {
    if (!Number.isSafeInteger(actualInputTokens) || actualInputTokens < 0) throw new Error('actual_input_tokens_invalid');
    if (actualInputTokens > measure.upperBoundTokens) {
      this.fused.add(measure.tokenizerRef);
      return Object.freeze({
        kind: 'underestimated' as const,
        actualInputTokens,
        upperBoundTokens: measure.upperBoundTokens,
        tokenizerRef: measure.tokenizerRef,
      });
    }
    return Object.freeze({
      kind: 'verified' as const,
      actualInputTokens,
      headroomTokens: measure.upperBoundTokens - actualInputTokens,
    });
  }
}

/**
 * Conservative OpenAI-compatible fallback. Byte-level BPE cannot emit more
 * content tokens than UTF-8 bytes; the fixed allowance covers protocol framing
 * not represented by the exact JSON body. Provider usage reconciliation fuses
 * this implementation if a compatible endpoint violates that bound.
 */
export class Utf8JsonWireUpperBoundTokenizer implements WireRequestTokenizer {
  readonly tokenizerRef = 'wire-json-utf8-upper-bound/v1';

  constructor(private readonly protocolFramingAllowanceTokens = 256) {
    if (!Number.isSafeInteger(protocolFramingAllowanceTokens) || protocolFramingAllowanceTokens < 0) {
      throw new Error('protocol_framing_allowance_invalid');
    }
  }

  measure(request: Readonly<ExactModelRequest>): WireRequestTokenCount {
    const serialized = JSON.stringify(request.body);
    if (serialized === undefined) throw new Error('wire_request_body_not_serializable');
    const bytes = Buffer.byteLength(serialized, 'utf8');
    const upperBoundTokens = bytes + this.protocolFramingAllowanceTokens;
    return {
      tokens: Math.ceil(bytes / 4),
      upperBoundTokens,
      precision: 'conservative_upper_bound',
    };
  }
}

function validateCount(count: Readonly<WireRequestTokenCount>): string | null {
  if (!Number.isSafeInteger(count.tokens) || count.tokens < 0) return 'tokens must be a non-negative safe integer';
  if (!Number.isSafeInteger(count.upperBoundTokens) || count.upperBoundTokens < 0) {
    return 'upperBoundTokens must be a non-negative safe integer';
  }
  if (count.upperBoundTokens < count.tokens) return 'upperBoundTokens cannot be lower than tokens';
  if (count.precision === 'exact' && count.tokens !== count.upperBoundTokens) {
    return 'exact measurement requires tokens === upperBoundTokens';
  }
  if (count.precision !== 'exact' && count.precision !== 'conservative_upper_bound') {
    return 'precision is invalid';
  }
  return null;
}

function unavailable(
  tokenizerRef: string,
  reason: Extract<TokenMeasureResult, { kind: 'unavailable' }>['reason'],
  detail: string,
): TokenMeasureResult {
  return Object.freeze({ kind: 'unavailable' as const, tokenizerRef, reason, detail });
}
