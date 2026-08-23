export type FailureOrigin =
  | 'decision'
  | 'contract'
  | 'atomic'
  | 'behavior'
  | 'navigation'
  | 'perception'
  | 'environment'
  | 'infra'
  | 'safety';

export type FailureStage = 'deciding' | 'preparing' | 'executing' | 'observing' | 'verifying';

export type FailureCategory =
  | 'contract'
  | 'precondition'
  | 'resource'
  | 'navigation'
  | 'environment'
  | 'transient'
  | 'timeout'
  | 'cancelled'
  | 'fatal';

export interface FailureEnvelope {
  code: string;
  origin: FailureOrigin;
  stage: FailureStage;
  category: FailureCategory;
  retryable: boolean;
  ownerActionable: boolean;
  evidenceRefs: string[];
  detail?: string;
}

export function isFailureEnvelope(value: unknown): value is FailureEnvelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<FailureEnvelope>;
  return typeof candidate.code === 'string'
    && typeof candidate.origin === 'string'
    && typeof candidate.stage === 'string'
    && typeof candidate.category === 'string'
    && typeof candidate.retryable === 'boolean'
    && typeof candidate.ownerActionable === 'boolean'
    && Array.isArray(candidate.evidenceRefs);
}

export function contractFailure(
  code: string,
  detail: string,
  ownerActionable = false,
): FailureEnvelope {
  return {
    code,
    origin: 'contract',
    stage: 'preparing',
    category: 'contract',
    retryable: true,
    ownerActionable,
    evidenceRefs: [],
    detail,
  };
}

/**
 * Transitional adapter for Atomic implementations that still return legacy strings.
 * Classification happens once at the execution boundary; recovery code only sees envelopes.
 */
export function failureFromLegacy(
  value: string | FailureEnvelope | null | undefined,
  defaults: Partial<Pick<FailureEnvelope, 'origin' | 'stage'>> = {},
): FailureEnvelope {
  if (isFailureEnvelope(value)) return value;
  const detail = String(value ?? 'atom_failed').trim() || 'atom_failed';
  const code = legacyCode(detail);
  const category = categoryFor(code, detail);
  const origin = defaults.origin ?? originFor(code, category);
  const stage = defaults.stage ?? 'executing';
  return {
    code,
    origin,
    stage,
    category,
    retryable: !['cancelled', 'fatal'].includes(category),
    ownerActionable: category === 'fatal' || code === 'safety.permission_required',
    evidenceRefs: [],
    detail,
  };
}

export function failureDetail(failure: FailureEnvelope): string {
  return failure.detail && failure.detail !== failure.code
    ? `${failure.code}: ${failure.detail}`
    : failure.code;
}

function legacyCode(detail: string): string {
  const lower = detail.toLowerCase();
  if (/requires target\.|missing parameter|invalid parameter/.test(lower)) return 'contract.invalid_parameter';
  if (/cancel|preempt/.test(lower)) return 'execution.cancelled';
  if (/timeout|timed out/.test(lower)) return lower.includes('nav') ? 'navigation.timeout' : 'execution.timeout';
  if (/unreachable|no_path|pathfinder|nav_failed|stuck|stall/.test(lower)) return 'navigation.failed';
  if (/died|dead|fatal/.test(lower)) return 'execution.fatal';
  if (/_need_|need_table|missing_slot|precondition|gate_unmet|no_tool/.test(lower)) return 'precondition.unsatisfied';
  if (/no_resource|no_block_nearby|no_item|no_fuel|no_furnace|no_recipe|no_craftable/.test(lower)) return 'resource.unavailable';
  if (/lava|monster_nearby|not_night|hazard|environment/.test(lower)) return 'environment.blocked';
  const token = lower.match(/[a-z][a-z0-9_.-]*/)?.[0];
  return token ? `atomic.${token.replace(/[^a-z0-9_.-]/g, '_')}` : 'atomic.failed';
}

function categoryFor(code: string, detail: string): FailureCategory {
  if (code.startsWith('contract.')) return 'contract';
  if (code.startsWith('precondition.')) return 'precondition';
  if (code.startsWith('resource.')) return 'resource';
  if (code.startsWith('navigation.')) return 'navigation';
  if (code.startsWith('environment.')) return 'environment';
  if (code.endsWith('.timeout')) return 'timeout';
  if (code.endsWith('.cancelled')) return 'cancelled';
  if (code.endsWith('.fatal')) return 'fatal';
  if (/permission|safety/.test(detail.toLowerCase())) return 'fatal';
  return 'transient';
}

function originFor(code: string, category: FailureCategory): FailureOrigin {
  if (category === 'contract') return 'contract';
  if (category === 'navigation') return 'navigation';
  if (category === 'environment') return 'environment';
  if (code.startsWith('behavior.')) return 'behavior';
  if (code.startsWith('safety.')) return 'safety';
  return 'atomic';
}
