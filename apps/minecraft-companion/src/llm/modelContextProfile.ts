import type { LlmApi } from './api.js';

export const MODEL_CONTEXT_PROFILE_BINDING_SCHEMA = 'mineclaw.model-context-profile-binding/v1' as const;
export const MODEL_CONTEXT_PROFILE_SCHEMA = 'mineclaw.model-context-profile/v1' as const;

export type ModelWindowAccounting = 'input_plus_output' | 'input_only';
export type ModelContextProfileSourceKind = 'explicit_config' | 'builtin_catalog' | 'provider_discovery';

/**
 * Route-owned physical limits. This is configuration data, not runtime tuning:
 * tuning may choose to use less capacity but may never enlarge these values.
 */
export interface ModelContextProfileBindingV1 {
  schema: typeof MODEL_CONTEXT_PROFILE_BINDING_SCHEMA;
  profileId: string;
  contextWindowTokens: number;
  maxOutputTokens: number;
  windowAccounting: ModelWindowAccounting;
  tokenizerRef: string;
  version: string;
  verifiedAt: string;
}

export interface ModelContextProfileV1 {
  schema: typeof MODEL_CONTEXT_PROFILE_SCHEMA;
  profileId: string;
  routeId: string;
  model: string;
  api: LlmApi;
  contextWindowTokens: number;
  maxOutputTokens: number;
  windowAccounting: ModelWindowAccounting;
  tokenizerRef: string;
  source: {
    kind: ModelContextProfileSourceKind;
    version: string;
    verifiedAt: string;
  };
}

export interface ModelContextRouteIdentity {
  routeId: string;
  adapterId: string;
  api: LlmApi;
  baseUrl: string;
  model: string;
}

export type ModelContextProfileResolution =
  | { kind: 'resolved'; profile: Readonly<ModelContextProfileV1> }
  | {
      kind: 'unresolved';
      reason: 'invalid_route' | 'invalid_explicit_profile' | 'retired_model_alias' | 'profile_not_found' | 'source_unavailable';
      routeId: string;
      model: string;
      detail: string;
      replacementModel?: string;
    };

export type ModelContextProfileSourceResult =
  | { kind: 'match'; binding: Readonly<ModelContextProfileBindingV1> }
  | { kind: 'miss' }
  | { kind: 'reject'; reason: 'retired_model_alias'; detail: string; replacementModel?: string }
  | { kind: 'unavailable'; detail: string };

/** Cached/discovered sources obey the same fail-closed result contract as the builtin catalog. */
export interface ModelContextProfileSource {
  readonly kind: Exclude<ModelContextProfileSourceKind, 'explicit_config'>;
  resolve(route: Readonly<ModelContextRouteIdentity>): ModelContextProfileSourceResult;
}

interface CatalogEntry {
  adapterId: string;
  baseUrlOrigin: string;
  model: string;
  api: LlmApi;
  binding: ModelContextProfileBindingV1;
}

interface RetiredAlias {
  adapterId: string;
  baseUrlOrigin: string;
  model: string;
  api: LlmApi;
  replacementModel: string;
  detail: string;
}

export class BuiltinModelContextProfileCatalog implements ModelContextProfileSource {
  readonly kind = 'builtin_catalog' as const;

  constructor(
    private readonly entries: readonly CatalogEntry[] = BUILTIN_PROFILE_ENTRIES,
    private readonly retiredAliases: readonly RetiredAlias[] = BUILTIN_RETIRED_ALIASES,
  ) {}

  resolve(route: Readonly<ModelContextRouteIdentity>): ModelContextProfileSourceResult {
    const origin = baseUrlOrigin(route.baseUrl);
    if (!origin) return { kind: 'unavailable', detail: 'route baseUrl is not a valid absolute URL' };
    const identityMatches = (candidate: Pick<CatalogEntry, 'adapterId' | 'baseUrlOrigin' | 'model' | 'api'>) => (
      candidate.adapterId === route.adapterId
      && candidate.baseUrlOrigin === origin
      && candidate.model === route.model
      && candidate.api === route.api
    );
    const entry = this.entries.find(identityMatches);
    if (entry) return { kind: 'match', binding: freezeBinding(entry.binding) };
    const retired = this.retiredAliases.find(identityMatches);
    if (retired) {
      return {
        kind: 'reject',
        reason: 'retired_model_alias',
        detail: retired.detail,
        replacementModel: retired.replacementModel,
      };
    }
    return { kind: 'miss' };
  }
}

export class ModelContextProfileResolver {
  constructor(
    private readonly catalog: ModelContextProfileSource = new BuiltinModelContextProfileCatalog(),
    private readonly discoverySources: readonly ModelContextProfileSource[] = [],
  ) {}

  resolve(
    route: Readonly<ModelContextRouteIdentity>,
    explicit?: Readonly<ModelContextProfileBindingV1>,
  ): ModelContextProfileResolution {
    const routeProblem = validateRoute(route);
    if (routeProblem) return unresolved(route, 'invalid_route', routeProblem);

    if (explicit) {
      const problem = validateModelContextProfileBinding(explicit);
      if (problem) return unresolved(route, 'invalid_explicit_profile', problem);
      return resolved(route, explicit, 'explicit_config');
    }

    const catalogResult = this.safeResolve(this.catalog, route);
    const catalogResolution = fromSourceResult(route, this.catalog.kind, catalogResult);
    if (catalogResolution) return catalogResolution;

    for (const source of this.discoverySources) {
      const result = this.safeResolve(source, route);
      const resolution = fromSourceResult(route, source.kind, result);
      if (resolution) return resolution;
    }

    return unresolved(
      route,
      'profile_not_found',
      `no exact model context profile for ${route.adapterId}/${baseUrlOrigin(route.baseUrl) ?? '<invalid>'}/${route.model}/${route.api}`,
    );
  }

  private safeResolve(
    source: ModelContextProfileSource,
    route: Readonly<ModelContextRouteIdentity>,
  ): ModelContextProfileSourceResult {
    try {
      return source.resolve(Object.freeze({ ...route }));
    } catch (error) {
      return { kind: 'unavailable', detail: `${source.kind}: ${(error as Error).message}` };
    }
  }
}

export function validateModelContextProfileBinding(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'context profile must be an object';
  const candidate = value as Partial<ModelContextProfileBindingV1>;
  if (candidate.schema !== MODEL_CONTEXT_PROFILE_BINDING_SCHEMA) return `schema must be ${MODEL_CONTEXT_PROFILE_BINDING_SCHEMA}`;
  if (!nonBlank(candidate.profileId)) return 'profileId is required';
  if (!positiveSafeInteger(candidate.contextWindowTokens)) return 'contextWindowTokens must be a positive safe integer';
  if (!positiveSafeInteger(candidate.maxOutputTokens)) return 'maxOutputTokens must be a positive safe integer';
  if (candidate.maxOutputTokens! > candidate.contextWindowTokens!) return 'maxOutputTokens cannot exceed contextWindowTokens';
  if (candidate.windowAccounting !== 'input_plus_output' && candidate.windowAccounting !== 'input_only') {
    return 'windowAccounting must be input_plus_output or input_only';
  }
  if (!nonBlank(candidate.tokenizerRef)) return 'tokenizerRef is required';
  if (!nonBlank(candidate.version)) return 'version is required';
  if (!nonBlank(candidate.verifiedAt) || !Number.isFinite(Date.parse(candidate.verifiedAt!))) {
    return 'verifiedAt must be an ISO date-time';
  }
  return null;
}

export function isModelContextProfileBindingV1(value: unknown): value is ModelContextProfileBindingV1 {
  return validateModelContextProfileBinding(value) === null;
}

function fromSourceResult(
  route: Readonly<ModelContextRouteIdentity>,
  sourceKind: Exclude<ModelContextProfileSourceKind, 'explicit_config'>,
  result: ModelContextProfileSourceResult,
): ModelContextProfileResolution | null {
  if (result.kind === 'miss') return null;
  if (result.kind === 'unavailable') return unresolved(route, 'source_unavailable', result.detail);
  if (result.kind === 'reject') {
    return unresolved(route, result.reason, result.detail, result.replacementModel);
  }
  const problem = validateModelContextProfileBinding(result.binding);
  if (problem) return unresolved(route, 'source_unavailable', `${sourceKind} returned an invalid profile: ${problem}`);
  return resolved(route, result.binding, sourceKind);
}

function resolved(
  route: Readonly<ModelContextRouteIdentity>,
  binding: Readonly<ModelContextProfileBindingV1>,
  sourceKind: ModelContextProfileSourceKind,
): ModelContextProfileResolution {
  return Object.freeze({
    kind: 'resolved' as const,
    profile: Object.freeze({
      schema: MODEL_CONTEXT_PROFILE_SCHEMA,
      profileId: binding.profileId,
      routeId: route.routeId,
      model: route.model,
      api: route.api,
      contextWindowTokens: binding.contextWindowTokens,
      maxOutputTokens: binding.maxOutputTokens,
      windowAccounting: binding.windowAccounting,
      tokenizerRef: binding.tokenizerRef,
      source: Object.freeze({ kind: sourceKind, version: binding.version, verifiedAt: binding.verifiedAt }),
    }),
  });
}

function unresolved(
  route: Pick<ModelContextRouteIdentity, 'routeId' | 'model'>,
  reason: Extract<ModelContextProfileResolution, { kind: 'unresolved' }>['reason'],
  detail: string,
  replacementModel?: string,
): ModelContextProfileResolution {
  return Object.freeze({
    kind: 'unresolved' as const,
    reason,
    routeId: route.routeId,
    model: route.model,
    detail,
    ...(replacementModel ? { replacementModel } : {}),
  });
}

function validateRoute(route: Readonly<ModelContextRouteIdentity>): string | null {
  if (!nonBlank(route.routeId)) return 'routeId is required';
  if (!nonBlank(route.adapterId)) return 'adapterId is required';
  if (!nonBlank(route.model)) return 'model is required';
  if (!baseUrlOrigin(route.baseUrl)) return 'baseUrl must be an absolute HTTP(S) URL';
  return null;
}

function baseUrlOrigin(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.origin.toLowerCase();
  } catch {
    return null;
  }
}

function freezeBinding(binding: ModelContextProfileBindingV1): Readonly<ModelContextProfileBindingV1> {
  return Object.freeze({ ...binding });
}

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

const DEEPSEEK_V4_1M: Omit<ModelContextProfileBindingV1, 'profileId'> = {
  schema: MODEL_CONTEXT_PROFILE_BINDING_SCHEMA,
  contextWindowTokens: 1_048_576,
  maxOutputTokens: 393_216,
  windowAccounting: 'input_plus_output',
  tokenizerRef: 'wire-json-utf8-upper-bound/v1',
  version: 'deepseek-official-2026-04-24',
  verifiedAt: '2026-04-24T00:00:00.000Z',
};

const BUILTIN_PROFILE_ENTRIES: readonly CatalogEntry[] = Object.freeze(
  (['openai-completions', 'openai-responses'] as const).flatMap(api => [
    {
      adapterId: 'openai-http',
      baseUrlOrigin: 'https://api.deepseek.com',
      model: 'deepseek-v4-flash',
      api,
      binding: { ...DEEPSEEK_V4_1M, profileId: `deepseek-v4-flash-1m-${api}` },
    },
    {
      adapterId: 'openai-http',
      baseUrlOrigin: 'https://api.deepseek.com',
      model: 'deepseek-v4-pro',
      api,
      binding: { ...DEEPSEEK_V4_1M, profileId: `deepseek-v4-pro-1m-${api}` },
    },
  ]),
);

const BUILTIN_RETIRED_ALIASES: readonly RetiredAlias[] = Object.freeze(
  (['openai-completions', 'openai-responses'] as const).flatMap(api => [
    {
      adapterId: 'openai-http',
      baseUrlOrigin: 'https://api.deepseek.com',
      model: 'deepseek-chat',
      api,
      replacementModel: 'deepseek-v4-flash',
      detail: 'deepseek-chat is a retired alias; select and verify an active model id before enabling governed calls',
    },
    {
      adapterId: 'openai-http',
      baseUrlOrigin: 'https://api.deepseek.com',
      model: 'deepseek-reasoner',
      api,
      replacementModel: 'deepseek-v4-pro',
      detail: 'deepseek-reasoner is a retired alias; select and verify an active model id before enabling governed calls',
    },
  ]),
);
