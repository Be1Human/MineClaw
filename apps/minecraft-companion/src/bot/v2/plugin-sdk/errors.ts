/**
 * Stable machine failure codes for the plugin contract surface (kernel design §5.2).
 * Every rejection path must map to exactly one code; generic fallbacks are not allowed.
 */
export const PLUGIN_FAILURE_CODES = [
  'manifest_invalid',
  'plugin_api_incompatible',
  'dependency_missing',
  'dependency_cycle',
  'id_conflict',
  'schema_invalid',
  'reference_unresolved',
  'permission_denied',
  'package_incomplete',
  'generation_conflict',
  'plugin_start_failed',
  'plugin_runtime_fault',
  'plugin_cancelled',
] as const;

export type PluginFailureCode = (typeof PLUGIN_FAILURE_CODES)[number];

/** Contract-side availability of a contribution inside a generation (kernel design §5.5). */
export const CONTRIBUTION_AVAILABILITY = [
  'available',
  'needs_observation',
  'needs_owner',
  'missing_dependency',
  'incompatible',
  'draining',
  'disabled',
  'faulted',
  'unsupported',
] as const;

export type ContributionAvailability = (typeof CONTRIBUTION_AVAILABILITY)[number];

/** Structured contract rejection; never thrown across the host boundary as a generic Error. */
export class PluginContractError extends Error {
  readonly code: PluginFailureCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: PluginFailureCode, message: string, details: Readonly<Record<string, unknown>> = {}) {
    super(message);
    this.name = 'PluginContractError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }

  withDetail(key: string, value: unknown): PluginContractError {
    return new PluginContractError(this.code, this.message, { ...this.details, [key]: value });
  }

  toJSON(): Readonly<Record<string, unknown>> {
    return { name: this.name, code: this.code, message: this.message, details: this.details };
  }
}

export function pluginError(code: PluginFailureCode, message: string, details?: Readonly<Record<string, unknown>>): PluginContractError {
  return new PluginContractError(code, message, details);
}

/** Normalize an unknown thrown value so callers can expose machine-readable cause. */
export function toPluginFailure(value: unknown): PluginContractError {
  if (value instanceof PluginContractError) return value;
  const message = value instanceof Error ? value.message : String(value);
  return new PluginContractError('plugin_runtime_fault', message);
}
