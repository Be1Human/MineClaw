import type { WorldStateView } from '../types.js';
import type {
  ProactiveCapabilityConfigScalar,
  ProactiveCapabilityPreferenceV1,
  ProactiveCapabilityPreferencesV1,
} from '../../../character/types.js';

export type ProactiveTickRate = 'fast' | 'std' | 'slow' | 'idle';
export type ProactiveDecisionMode = 'deterministic' | 'deliberative';
export type ProactiveConfigScalar = ProactiveCapabilityConfigScalar;

export interface ProactiveConfigFieldDefinition {
  readonly type: 'boolean' | 'number' | 'string';
  readonly label: string;
  readonly description?: string;
  readonly default: ProactiveConfigScalar;
  readonly min?: number;
  readonly max?: number;
  readonly enum?: readonly string[];
}

export type ProactiveConfigSchema = Readonly<Record<string, ProactiveConfigFieldDefinition>>;

/** YAML/manifest-owned metadata. It is safe to expose through the catalog API. */
export interface ProactiveTickManifestEntry {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly goalTarget: string;
  readonly defaultEnabled: boolean;
  readonly rate: ProactiveTickRate;
  readonly priority: number;
  readonly decisionMode: ProactiveDecisionMode;
  readonly conflictGroups?: readonly string[];
  readonly configSchema?: ProactiveConfigSchema;
}

export interface ProactiveIntentCandidate {
  readonly requestText: string;
  readonly constraints?: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly idempotencyKey: string;
  readonly params?: Readonly<Record<string, unknown>>;
}

export type ProactiveTickEvaluation =
  | { readonly kind: 'idle'; readonly reason: string }
  | { readonly kind: 'release'; readonly reason: string; readonly activationId?: string }
  | { readonly kind: 'candidate'; readonly candidate: ProactiveIntentCandidate };

/** Deliberately read-only: no TaskRuntime, Motor, adapter or command port is available here. */
export interface ProactiveTickContext {
  readonly profileId: string;
  readonly now: number;
  readonly world: WorldStateView | null;
  readonly config: Readonly<Record<string, ProactiveConfigScalar>>;
  readonly foregroundBusy: boolean;
  readonly activeActivation?: Readonly<{ capabilityId: string; activationId: string; idempotencyKey: string }>;
  readonly signal: AbortSignal;
}

/** Code-owned evaluator paired one-to-one with a manifest entry. */
export interface ProactiveTickCapabilityImplementation {
  readonly id: string;
  evaluate(
    context: ProactiveTickContext,
  ): ProactiveTickEvaluation | Promise<ProactiveTickEvaluation>;
}

export interface RegisteredProactiveTickCapability {
  readonly packageId: string;
  readonly manifest: ProactiveTickManifestEntry;
  readonly implementation: ProactiveTickCapabilityImplementation;
}

export type ProactiveCapabilityPreference = Readonly<ProactiveCapabilityPreferenceV1>;
export type ProactiveCapabilityPreferences = Readonly<ProactiveCapabilityPreferencesV1>;

export interface ProactiveCapabilityCatalogEntry {
  readonly packageId: string;
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly goalTarget: string;
  readonly defaultEnabled: boolean;
  readonly enabled: boolean;
  readonly rate: ProactiveTickRate;
  readonly priority: number;
  readonly decisionMode: ProactiveDecisionMode;
  readonly conflictGroups: readonly string[];
  readonly configSchema: ProactiveConfigSchema;
  readonly config: Readonly<Record<string, ProactiveConfigScalar>>;
}

export interface ProactiveCapabilityPreferenceIssue {
  readonly path: string;
  readonly message: string;
}

export function validateProactiveCapabilityPreferences(
  capabilities: readonly RegisteredProactiveTickCapability[],
  preferences: ProactiveCapabilityPreferences,
): readonly ProactiveCapabilityPreferenceIssue[] {
  const manifests = new Map(capabilities.map(capability => [capability.manifest.id, capability.manifest]));
  const issues: ProactiveCapabilityPreferenceIssue[] = [];
  for (const [capabilityId, preference] of Object.entries(preferences)) {
    const manifest = manifests.get(capabilityId);
    // Unknown plugin settings are intentionally retained for downgrade/upgrade compatibility,
    // but they are never executable because no registered implementation exists.
    if (!manifest) continue;
    if (preference.enabled !== undefined && typeof preference.enabled !== 'boolean') {
      issues.push({ path: `${capabilityId}.enabled`, message: 'enabled must be boolean' });
    }
    for (const [key, value] of Object.entries(preference.config ?? {})) {
      const field = manifest.configSchema?.[key];
      if (!field) {
        issues.push({ path: `${capabilityId}.config.${key}`, message: 'unknown config field' });
        continue;
      }
      const matches = field.type === typeof value && !(typeof value === 'number' && !Number.isFinite(value));
      if (!matches) {
        issues.push({ path: `${capabilityId}.config.${key}`, message: `must be ${field.type}` });
        continue;
      }
      if (typeof value === 'number') {
        if (field.min !== undefined && value < field.min) issues.push({ path: `${capabilityId}.config.${key}`, message: `must be >= ${field.min}` });
        if (field.max !== undefined && value > field.max) issues.push({ path: `${capabilityId}.config.${key}`, message: `must be <= ${field.max}` });
      }
      if (typeof value === 'string' && field.enum && !field.enum.includes(value)) {
        issues.push({ path: `${capabilityId}.config.${key}`, message: 'must be an allowed value' });
      }
    }
  }
  return Object.freeze(issues.map(issue => Object.freeze(issue)));
}

export function resolveProactiveCapabilityCatalog(
  capabilities: readonly RegisteredProactiveTickCapability[],
  preferences: ProactiveCapabilityPreferences = {},
): readonly ProactiveCapabilityCatalogEntry[] {
  const issues = validateProactiveCapabilityPreferences(capabilities, preferences);
  if (issues.length > 0) {
    throw new Error(`invalid proactive capability preferences: ${issues.map(issue => `${issue.path} ${issue.message}`).join('; ')}`);
  }
  return Object.freeze(capabilities.map(capability => {
    const preference = preferences[capability.manifest.id];
    const config = Object.fromEntries(Object.entries(capability.manifest.configSchema ?? {}).map(([key, field]) => [
      key,
      preference?.config?.[key] ?? field.default,
    ]));
    return Object.freeze({
      packageId: capability.packageId,
      id: capability.manifest.id,
      label: capability.manifest.label,
      description: capability.manifest.description,
      goalTarget: capability.manifest.goalTarget,
      defaultEnabled: capability.manifest.defaultEnabled,
      enabled: preference?.enabled ?? capability.manifest.defaultEnabled,
      rate: capability.manifest.rate,
      priority: capability.manifest.priority,
      decisionMode: capability.manifest.decisionMode,
      conflictGroups: Object.freeze([...(capability.manifest.conflictGroups ?? [])]),
      configSchema: capability.manifest.configSchema ?? Object.freeze({}),
      config: Object.freeze(config),
    });
  }));
}
