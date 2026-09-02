/**
 * Ten discriminated contribution kinds (kernel design §5.2).
 * Each branch carries only its own mandatory fields — no optional empty methods,
 * no universal registrar. Adding a brand-new contribution category requires a
 * Plugin SDK version bump; adding implementations of a category never touches core.
 */
import { parseContributionRequirements, type ContributionRequirement } from './dependencies.js';
import { pluginError } from './errors.js';
import { isValidSemVer } from './semver.js';
import type { PluginBindingProvider, PluginCandidateProvider, PluginProgressProvider } from './contracts/planning.js';
import type { PluginPredicateEvaluator } from './contracts/verification.js';
import type { PluginBehaviorFactory, PluginActivityFactory, PluginAtomicExecutor } from './contracts/execution.js';
import type { PluginResultProjection } from './contracts/result.js';
import type { PluginObservationProviderFactory } from './contracts/observation.js';
import type { PluginSystemIntegration } from './contracts/integration.js';

export type PluginContributionKind =
  | 'knowledge'
  | 'skill'
  | 'observation'
  | 'goal'
  | 'planning'
  | 'verification'
  | 'execution'
  | 'result'
  | 'proactive'
  | 'integration';

export interface KnowledgeContribution {
  readonly kind: 'knowledge';
  readonly id: string;
  readonly version: string;
  readonly contentRef: string;
  readonly contentSchema?: Readonly<Record<string, unknown>>;
  readonly requirements?: readonly ContributionRequirement[];
}

export interface SkillContribution {
  readonly kind: 'skill';
  readonly id: string;
  readonly version: string;
  readonly entryRef: string;
  readonly requirements?: readonly ContributionRequirement[];
}

export interface ObservationContribution {
  readonly kind: 'observation';
  readonly id: string;
  readonly version: string;
  readonly factory: PluginObservationProviderFactory;
}

export interface PluginGoalTargetDeclaration {
  readonly registryId: string;
  readonly goalKind: 'item' | 'entity' | 'location' | 'composite';
  readonly aliases: readonly string[];
  readonly successCriteria: readonly {
    readonly type: 'inventory' | 'entity_dead' | 'reached' | 'predicate';
    readonly predicate?: string;
    readonly args?: Readonly<Record<string, unknown>>;
  }[];
}

export interface GoalContribution {
  readonly kind: 'goal';
  readonly id: string;
  readonly version: string;
  readonly target: PluginGoalTargetDeclaration;
  readonly bindingProvider?: PluginBindingProvider;
}

export interface PluginOperationDeclaration {
  readonly operationId: string;
  readonly goalContributionId: string;
  readonly bindingContributionId: string;
  readonly factKinds: readonly string[];
  readonly candidateContributionId: string;
  readonly predicateContributionId: string;
  readonly progressContributionId: string;
  readonly resultContributionId: string;
  readonly cancellable: boolean;
}

export interface PlanningContribution {
  readonly kind: 'planning';
  readonly id: string;
  readonly version: string;
  readonly candidateProvider: PluginCandidateProvider;
  readonly progressProvider?: PluginProgressProvider;
  readonly operationSemantics?: {
    readonly operationId: string;
    readonly version: string;
    readonly scope: Readonly<Record<string, unknown>>;
  };
}

export interface VerificationContribution {
  readonly kind: 'verification';
  readonly id: string;
  readonly version: string;
  readonly predicates: readonly PluginPredicateEvaluator[];
}

export interface ExecutionContribution {
  readonly kind: 'execution';
  readonly id: string;
  readonly version: string;
  /** Present for domain operations (nine-segment closure applies); absent for catalog-only system primitives. */
  readonly operation?: PluginOperationDeclaration;
  readonly behaviorFactory?: PluginBehaviorFactory;
  readonly activityFactory?: PluginActivityFactory;
  /** Only first-party system plugins may register atomics (primitive catalog, no closure requirement). */
  readonly atomicCatalog?: {
    readonly atomicId: string;
    readonly version: string;
    readonly executor: PluginAtomicExecutor;
  }[];
}

export interface ResultContribution {
  readonly kind: 'result';
  readonly id: string;
  readonly version: string;
  readonly projection: PluginResultProjection;
}

export interface ProactiveContribution {
  readonly kind: 'proactive';
  readonly id: string;
  readonly version: string;
  readonly label: string;
  readonly description: string;
  readonly goalTarget: string;
  readonly rate: 'fast' | 'std' | 'slow' | 'idle';
  readonly priority: number;
  readonly evaluator: (input: Readonly<Record<string, unknown>>) => boolean;
}

export interface IntegrationContribution {
  readonly kind: 'integration';
  readonly id: string;
  readonly version: string;
  readonly integration: PluginSystemIntegration;
}

export type PluginContribution =
  | KnowledgeContribution
  | SkillContribution
  | ObservationContribution
  | GoalContribution
  | PlanningContribution
  | VerificationContribution
  | ExecutionContribution
  | ResultContribution
  | ProactiveContribution
  | IntegrationContribution;

export function contributionKindOf(value: unknown): PluginContributionKind | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const kind = (value as Record<string, unknown>).kind;
  if (typeof kind !== 'string') return null;
  return CONTRIBUTION_KINDS.includes(kind as PluginContributionKind) ? (kind as PluginContributionKind) : null;
}

export const CONTRIBUTION_KINDS: readonly PluginContributionKind[] = [
  'knowledge', 'skill', 'observation', 'goal', 'planning', 'verification',
  'execution', 'result', 'proactive', 'integration',
];

export const DATA_PLUGIN_CONTRIBUTION_KINDS: readonly PluginContributionKind[] = ['knowledge', 'skill'];

/**
 * Manifest-side validation of a single contribution. Structural failures throw
 * `manifest_invalid`; runtime `requirements` are parsed separately.
 */
export function parseContribution(
  value: unknown,
  pluginId: string,
  pluginKind: 'data' | 'domain' | 'system',
  index: number,
): PluginContribution {
  const kind = contributionKindOf(value);
  if (!kind) throw pluginError('manifest_invalid', `contribution[${index}] has unknown kind`);
  const record = value as Record<string, unknown>;
  const id = requireContribId(record.id, pluginId, `contribution[${index}]`);
  const version = requireContribVersion(record.version, id);
  const allRequirements = parseContributionRequirements(record.requirements);
  const requirements = allRequirements.length > 0 ? allRequirements : undefined;

  switch (kind) {
    case 'knowledge':
      return freeze({
        kind, id, version,
        contentRef: requireString(record.contentRef, 'knowledge contentRef', id),
        contentSchema: freezeSchema(record.contentSchema),
        ...(requirements ? { requirements } : {}),
      });
    case 'skill':
      return freeze({
        kind, id, version,
        entryRef: requireString(record.entryRef, 'skill entryRef', id),
        ...(requirements ? { requirements } : {}),
      });
    case 'observation':
      if (pluginKind === 'data') throw pluginError('manifest_invalid', `data plugin may not carry observation ${id}`);
      if (!isRecord(record.factory) || typeof (record.factory as unknown as Record<string, unknown>).create !== 'function') {
        throw pluginError('manifest_invalid', `observation ${id} requires a code-owned factory`);
      }
      return freeze({
        kind, id, version,
        factory: record.factory as unknown as ObservationContribution['factory'],
      });
    case 'goal': {
      if (pluginKind === 'data') throw pluginError('manifest_invalid', `data plugin may not carry goal ${id}`);
      const target = record.target;
      if (!isRecord(target)) throw pluginError('manifest_invalid', `goal ${id} requires a target declaration`);
      const registryId = requireString(target.registryId, 'goal target registryId', id);
      const goalKind = requireKindOf(target.goalKind, ['item', 'entity', 'location', 'composite'], `goal ${id} goalKind`);
      if (!Array.isArray(target.aliases)) throw pluginError('manifest_invalid', `goal ${id} aliases must be an array`);
      if (!Array.isArray(target.successCriteria) || target.successCriteria.length === 0) {
        throw pluginError('manifest_invalid', `goal ${id} requires success criteria`);
      }
      const binding = record.bindingProvider;
      if (binding !== undefined && (typeof binding !== 'object' || binding === null || typeof (binding as unknown as Record<string, unknown>).list !== 'function')) {
        throw pluginError('manifest_invalid', `goal ${id} bindingProvider must be code-owned`);
      }
      return freeze({
        kind, id, version,
        target: Object.freeze({
          registryId,
          goalKind,
          aliases: Object.freeze([...target.aliases] as string[]),
          successCriteria: Object.freeze([...target.successCriteria] as PluginGoalTargetDeclaration['successCriteria']),
        }),
        ...(binding ? { bindingProvider: binding as unknown as GoalContribution['bindingProvider'] } : {}),
      });
    }
    case 'planning':
      if (pluginKind === 'data') throw pluginError('manifest_invalid', `data plugin may not carry planning ${id}`);
      if (!isRecord(record.candidateProvider) || typeof (record.candidateProvider as unknown as Record<string, unknown>).list !== 'function') {
        throw pluginError('manifest_invalid', `planning ${id} requires a code-owned candidateProvider`);
      }
      return freeze({
        kind, id, version,
        candidateProvider: record.candidateProvider as unknown as PlanningContribution['candidateProvider'],
        ...(isRecord(record.progressProvider) && typeof (record.progressProvider as unknown as Record<string, unknown>).assess === 'function'
          ? { progressProvider: record.progressProvider as unknown as PlanningContribution['progressProvider'] } : {}),
        ...(isRecord(record.operationSemantics) ? { operationSemantics: Object.freeze({ ...record.operationSemantics }) as PlanningContribution['operationSemantics'] } : {}),
      });
    case 'verification':
      if (pluginKind === 'data') throw pluginError('manifest_invalid', `data plugin may not carry verification ${id}`);
      if (!Array.isArray(record.predicates) || record.predicates.length === 0) {
        throw pluginError('manifest_invalid', `verification ${id} requires predicates`);
      }
      for (const predicate of record.predicates) {
        if (!isRecord(predicate) || typeof predicate.evaluate !== 'function') {
          throw pluginError('manifest_invalid', `verification ${id} predicate must be code-owned`);
        }
      }
      return freeze({
        kind, id, version,
        predicates: Object.freeze([...record.predicates]) as VerificationContribution['predicates'],
      });
    case 'execution':
      if (pluginKind === 'data') throw pluginError('manifest_invalid', `data plugin may not carry execution ${id}`);
      const catalog = record.atomicCatalog;
      if (catalog !== undefined && pluginKind !== 'system') {
        throw pluginError('permission_denied', `execution ${id} atomicCatalog requires system plugin kind`);
      }
      if (!isRecord(record.operation) && !Array.isArray(catalog)) {
        throw pluginError('manifest_invalid', `execution ${id} requires an operation declaration (or a system atomic catalog)`);
      }
      return freeze({
        kind, id, version,
        ...(isRecord(record.operation) ? { operation: Object.freeze({ ...record.operation }) as unknown as ExecutionContribution['operation'] } : {}),
        ...(isRecord(record.behaviorFactory) && typeof (record.behaviorFactory as unknown as Record<string, unknown>).create === 'function'
          ? { behaviorFactory: record.behaviorFactory as unknown as ExecutionContribution['behaviorFactory'] } : {}),
        ...(isRecord(record.activityFactory) && typeof (record.activityFactory as unknown as Record<string, unknown>).create === 'function'
          ? { activityFactory: record.activityFactory as unknown as ExecutionContribution['activityFactory'] } : {}),
        ...(Array.isArray(catalog) ? { atomicCatalog: Object.freeze([...catalog]) as ExecutionContribution['atomicCatalog'] } : {}),
      });
    case 'result':
      if (pluginKind === 'data') throw pluginError('manifest_invalid', `data plugin may not carry result ${id}`);
      if (!isRecord(record.projection) || typeof (record.projection as unknown as Record<string, unknown>).project !== 'function') {
        throw pluginError('manifest_invalid', `result ${id} requires a code-owned projection`);
      }
      return freeze({
        kind, id, version,
        projection: record.projection as unknown as ResultContribution['projection'],
      });
    case 'proactive':
      if (pluginKind === 'data') throw pluginError('manifest_invalid', `data plugin may not carry proactive ${id}`);
      const label = requireString(record.label, 'proactive label', id);
      const description = requireString(record.description, 'proactive description', id);
      const goalTarget = requireString(record.goalTarget, 'proactive goalTarget', id);
      if (!['fast', 'std', 'slow', 'idle'].includes(String(record.rate))) throw pluginError('manifest_invalid', `proactive ${id} has invalid rate`);
      if (typeof record.priority !== 'number' || !Number.isFinite(record.priority)) throw pluginError('manifest_invalid', `proactive ${id} priority must be a finite number`);
      if (typeof record.evaluator !== 'function') throw pluginError('manifest_invalid', `proactive ${id} requires a code-owned evaluator`);
      return freeze({
        kind, id, version, label, description, goalTarget,
        rate: record.rate as ProactiveContribution['rate'],
        priority: record.priority,
        evaluator: record.evaluator as ProactiveContribution['evaluator'],
      });
    case 'integration':
      if (pluginKind !== 'system') throw pluginError('permission_denied', `integration ${id} requires system plugin kind`);
      if (!isRecord(record.integration) || typeof record.integration.start !== 'function' || typeof record.integration.stop !== 'function') {
        throw pluginError('manifest_invalid', `integration ${id} requires code-owned start/stop`);
      }
      return freeze({
        kind, id, version,
        integration: record.integration as unknown as IntegrationContribution['integration'],
      });
  }
}

function requireContribId(value: unknown, pluginId: string, label: string): string {
  if (typeof value !== 'string' || !value.startsWith(`${pluginId}.`)) {
    throw pluginError('manifest_invalid', `${label}.id must live in plugin namespace ${pluginId}.`);
  }
  return value;
}

function requireContribVersion(value: unknown, id: string): string {
  if (typeof value !== 'string' || !isValidSemVer(value)) {
    throw pluginError('manifest_invalid', `contribution ${id} version must be valid SemVer (independent of plugin version)`);
  }
  return value;
}

function requireString(value: unknown, label: string, id: string): string {
  if (typeof value !== 'string' || !value.trim()) throw pluginError('manifest_invalid', `${label} required for ${id}`);
  return value;
}

function requireKindOf(value: unknown, allowed: readonly string[], label: string): PluginGoalTargetDeclaration['goalKind'] {
  if (typeof value !== 'string' || !allowed.includes(value)) throw pluginError('manifest_invalid', `${label} must be one of ${allowed.join('/')}`);
  return value as PluginGoalTargetDeclaration['goalKind'];
}

function freezeSchema(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw pluginError('schema_invalid', 'contribution contentSchema must be an object');
  return Object.freeze({ ...value });
}

function freeze<T extends object>(value: T): T {
  return Object.freeze(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/* ------------------------------------------------------------------ *
 * Manifest declaration layer (kernel design §5.2).
 * A YAML manifest carries ONLY declarative metadata — no code. The factory
 * (from the build index for code plugins, from the loader for data plugins)
 * produces matching PluginContribution implementations at construct time;
 * the registration transaction enforces a one-to-one id/version/kind match.
 * ------------------------------------------------------------------ */

export type ManifestContribution =
  | { readonly kind: 'knowledge'; readonly id: string; readonly version: string; readonly contentRef: string; readonly contentSchema?: Readonly<Record<string, unknown>>; readonly requirements?: readonly ContributionRequirement[] }
  | { readonly kind: 'skill'; readonly id: string; readonly version: string; readonly entryRef: string; readonly requirements?: readonly ContributionRequirement[] }
  | { readonly kind: 'observation'; readonly id: string; readonly version: string; readonly factKinds: readonly string[] }
  | { readonly kind: 'goal'; readonly id: string; readonly version: string; readonly target: PluginGoalTargetDeclaration }
  | { readonly kind: 'planning'; readonly id: string; readonly version: string; readonly operationIds: readonly string[] }
  | { readonly kind: 'verification'; readonly id: string; readonly version: string }
  | { readonly kind: 'execution'; readonly id: string; readonly version: string; readonly operation?: PluginOperationDeclaration; readonly atomicIds?: readonly string[] }
  | { readonly kind: 'result'; readonly id: string; readonly version: string }
  | { readonly kind: 'proactive'; readonly id: string; readonly version: string; readonly label: string; readonly description: string; readonly goalTarget: string; readonly rate: 'fast' | 'std' | 'slow' | 'idle'; readonly priority: number }
  | { readonly kind: 'integration'; readonly id: string; readonly version: string };

export function parseManifestContribution(value: unknown, pluginId: string, pluginKind: 'data' | 'domain' | 'system', index: number): ManifestContribution {
  const kind = contributionKindOf(value);
  if (!kind) throw pluginError('manifest_invalid', `contribution[${index}] has unknown kind`);
  const record = value as Record<string, unknown>;
  const id = requireContribId(record.id, pluginId, `contribution[${index}]`);
  const version = requireContribVersion(record.version, id);
  const allRequirements = parseContributionRequirements(record.requirements);
  const requirements = allRequirements.length > 0 ? allRequirements : undefined;
  switch (kind) {
    case 'knowledge':
      return Object.freeze({
        kind, id, version,
        contentRef: requireString(record.contentRef, 'knowledge contentRef', id),
        ...(record.contentSchema !== undefined ? { contentSchema: freezeSchema(record.contentSchema)! } : {}),
        ...(requirements ? { requirements } : {}),
      });
    case 'skill':
      return Object.freeze({
        kind, id, version,
        entryRef: requireString(record.entryRef, 'skill entryRef', id),
        ...(requirements ? { requirements } : {}),
      });
    case 'observation':
      if (pluginKind === 'data') throw pluginError('manifest_invalid', `data plugin may not carry observation ${id}`);
      if (!Array.isArray(record.factKinds) || record.factKinds.length === 0) {
        throw pluginError('manifest_invalid', `observation ${id} requires factKinds`);
      }
      return Object.freeze({ kind, id, version, factKinds: Object.freeze([...record.factKinds] as string[]) });
    case 'goal':
      if (pluginKind === 'data') throw pluginError('manifest_invalid', `data plugin may not carry goal ${id}`);
      if (!isRecord(record.target)) throw pluginError('manifest_invalid', `goal ${id} requires a target declaration`);
      const registryId = requireString(record.target.registryId, 'goal target registryId', id);
      const goalKind = requireKindOf(record.target.goalKind, ['item', 'entity', 'location', 'composite'], `goal ${id} goalKind`);
      if (!Array.isArray(record.target.aliases)) throw pluginError('manifest_invalid', `goal ${id} aliases must be an array`);
      if (!Array.isArray(record.target.successCriteria) || record.target.successCriteria.length === 0) {
        throw pluginError('manifest_invalid', `goal ${id} requires success criteria`);
      }
      return Object.freeze({
        kind, id, version,
        target: Object.freeze({
          registryId,
          goalKind,
          aliases: Object.freeze([...record.target.aliases] as string[]),
          successCriteria: Object.freeze([...record.target.successCriteria] as PluginGoalTargetDeclaration['successCriteria']),
        }),
      });
    case 'planning':
      if (pluginKind === 'data') throw pluginError('manifest_invalid', `data plugin may not carry planning ${id}`);
      if (!Array.isArray(record.operationIds)) throw pluginError('manifest_invalid', `planning ${id} requires operationIds`);
      return Object.freeze({ kind, id, version, operationIds: Object.freeze([...record.operationIds] as string[]) });
    case 'verification':
      if (pluginKind === 'data') throw pluginError('manifest_invalid', `data plugin may not carry verification ${id}`);
      return Object.freeze({ kind, id, version });
    case 'execution':
      if (pluginKind === 'data') throw pluginError('manifest_invalid', `data plugin may not carry execution ${id}`);
      if (!isRecord(record.operation) && (pluginKind !== 'system' || !Array.isArray(record.atomicIds) || record.atomicIds.length === 0)) {
        throw pluginError('manifest_invalid', `execution ${id} requires an operation declaration (or a system atomic catalog)`);
      }
      return Object.freeze({
        kind, id, version,
        ...(isRecord(record.operation) ? { operation: Object.freeze({ ...record.operation }) as unknown as PluginOperationDeclaration } : {}),
        ...(Array.isArray(record.atomicIds) ? { atomicIds: Object.freeze([...record.atomicIds] as string[]) } : {}),
      });
    case 'result':
      if (pluginKind === 'data') throw pluginError('manifest_invalid', `data plugin may not carry result ${id}`);
      return Object.freeze({ kind, id, version });
    case 'proactive':
      if (pluginKind === 'data') throw pluginError('manifest_invalid', `data plugin may not carry proactive ${id}`);
      const label = requireString(record.label, 'proactive label', id);
      const description = requireString(record.description, 'proactive description', id);
      const goalTarget = requireString(record.goalTarget, 'proactive goalTarget', id);
      if (!['fast', 'std', 'slow', 'idle'].includes(String(record.rate))) throw pluginError('manifest_invalid', `proactive ${id} has invalid rate`);
      if (typeof record.priority !== 'number' || !Number.isFinite(record.priority)) throw pluginError('manifest_invalid', `proactive ${id} priority must be a finite number`);
      return Object.freeze({
        kind, id, version, label, description, goalTarget,
        rate: record.rate as 'fast' | 'std' | 'slow' | 'idle',
        priority: record.priority,
      });
    case 'integration':
      if (pluginKind !== 'system') throw pluginError('permission_denied', `integration ${id} requires system plugin kind`);
      return Object.freeze({ kind, id, version });
  }
}

export function toDataContribution(declaration: ManifestContribution & { kind: 'knowledge' | 'skill' }): PluginContribution {
  return Object.freeze({ ...declaration }) as unknown as PluginContribution;
}
