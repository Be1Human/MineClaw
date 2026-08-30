import type {
  CapabilityPackageDefinition,
  CapabilityPackageEnvironment,
  CapabilityPackageSnapshot,
} from './types.js';
import type {
  ProactiveConfigFieldDefinition,
  ProactiveTickManifestEntry,
  RegisteredProactiveTickCapability,
} from '../proactive/contracts.js';

/**
 * Startup-only registry. Validation is completed before any map is mutated,
 * so a rejected package cannot leave a partially installed vertical slice.
 */
export class CapabilityPackageRegistry {
  private readonly packages = new Map<string, CapabilityPackageDefinition>();
  private readonly goalTargetIds: Set<string>;
  private readonly behaviorIds: Set<string>;
  private readonly providerIds = new Set<string>();
  private readonly worldFactProviderIds = new Set<string>();
  private readonly evaluatorIds = new Set<string>();
  private readonly proactiveTickIds = new Set<string>();
  private readonly atomicIds: Set<string>;
  private readonly strategyIds: Set<string>;
  private readonly skillNames: Set<string>;
  private readonly knowledgeIds: Set<string>;

  constructor(environment: CapabilityPackageEnvironment) {
    this.atomicIds = normalizedSet(environment.atomicIds);
    this.behaviorIds = normalizedSet(environment.behaviorIds);
    this.strategyIds = normalizedSet(environment.strategyIds ?? []);
    this.skillNames = normalizedSet(environment.skillNames);
    this.knowledgeIds = normalizedSet(environment.knowledgeIds);
    this.goalTargetIds = normalizedSet(environment.goalTargetIds ?? []);
  }

  register(definition: CapabilityPackageDefinition): void {
    const packageId = requiredId(definition.manifest?.id, 'package');
    if (this.packages.has(packageId)) throw new Error(`duplicate capability package id: ${packageId}`);
    if (definition.manifest?.schema !== 'mineclaw/capability-manifest@1') {
      throw new Error(`capability package ${packageId} has unsupported manifest schema`);
    }
    if (!Number.isInteger(definition.manifest.version) || definition.manifest.version < 1) {
      throw new Error(`capability package ${packageId} has invalid manifest version`);
    }
    requiredId(definition.manifest.description, 'manifest description');

    const targets = definition.manifest?.goalTargets ?? [];
    const declaredSkills = definition.manifest?.skills ?? [];
    const declaredKnowledge = definition.manifest?.knowledge ?? [];
    const atomics = definition.manifest?.requires?.atomics ?? [];
    const proactiveManifests = definition.manifest.proactiveTicks ?? [];
    const proactiveOnly = targets.length === 0 && proactiveManifests.length > 0;
    if (!proactiveOnly && targets.length === 0) throw new Error(`capability package ${packageId} requires manifest goalTargets`);
    if (!proactiveOnly && declaredSkills.length === 0) throw new Error(`capability package ${packageId} requires Skill references`);
    if (!proactiveOnly && declaredKnowledge.length === 0) throw new Error(`capability package ${packageId} requires Knowledge references`);
    if (!proactiveOnly && atomics.length === 0) throw new Error(`capability package ${packageId} requires Atomic references`);
    if (!proactiveOnly && definition.actionProviders.length === 0) throw new Error(`capability package ${packageId} has no execution path`);
    if (!proactiveOnly && definition.predicateEvaluators.length === 0) throw new Error(`capability package ${packageId} has no verification path`);

    const packageBehaviorIds = ids(definition.behaviors ?? [], 'behavior');
    const packageProviderIds = ids(definition.actionProviders, 'action provider');
    const packageWorldFactProviderIds = ids(definition.worldFactProviders ?? [], 'world fact provider');
    const packageEvaluatorIds = ids(definition.predicateEvaluators, 'predicate evaluator');
    const packageTargetIds = targets.map(target => requiredId(target.registryId, 'goal target'));
    const proactiveImplementations = definition.proactiveTicks ?? [];
    const proactiveManifestIds = proactiveManifests.map(value => requiredId(value.id, 'proactive Tick manifest'));
    const proactiveImplementationIds = proactiveImplementations.map(value => requiredId(value.id, 'proactive Tick implementation'));
    rejectLocalDuplicates(packageBehaviorIds, 'behavior');
    rejectLocalDuplicates(packageProviderIds, 'action provider');
    rejectLocalDuplicates(packageWorldFactProviderIds, 'world fact provider');
    rejectLocalDuplicates(packageEvaluatorIds, 'predicate evaluator');
    rejectLocalDuplicates(packageTargetIds, 'goal target');
    rejectLocalDuplicates(proactiveManifestIds, 'proactive Tick manifest');
    rejectLocalDuplicates(proactiveImplementationIds, 'proactive Tick implementation');
    rejectLocalDuplicates(declaredSkills.map(value => requiredId(value, 'Skill reference')), 'Skill reference');
    rejectLocalDuplicates(declaredKnowledge.map(value => requiredId(value, 'Knowledge reference')), 'Knowledge reference');
    rejectLocalDuplicates(atomics.map(value => requiredId(value, 'Atomic reference')), 'Atomic reference');

    rejectExisting(packageBehaviorIds, this.behaviorIds, 'behavior');
    rejectExisting(packageProviderIds, this.providerIds, 'action provider');
    rejectExisting(packageWorldFactProviderIds, this.worldFactProviderIds, 'world fact provider');
    rejectExisting(packageEvaluatorIds, this.evaluatorIds, 'predicate evaluator');
    rejectExisting(packageTargetIds, this.goalTargetIds, 'goal target');
    rejectExisting(proactiveManifestIds, this.proactiveTickIds, 'proactive Tick');

    if (!sameIds(proactiveManifestIds, proactiveImplementationIds)) {
      throw new Error(`capability package ${packageId} proactive Tick declarations and implementations must match`);
    }
    const availableTargets = new Set([...this.goalTargetIds, ...packageTargetIds]);
    for (const manifest of proactiveManifests) {
      validateProactiveManifest(packageId, manifest, availableTargets);
    }
    for (const implementation of proactiveImplementations) {
      if (typeof implementation.evaluate !== 'function') {
        throw new Error(`capability package ${packageId} proactive Tick ${implementation.id} has no evaluator`);
      }
    }

    for (const atomicId of atomics) requireAvailable(atomicId, this.atomicIds, packageId, 'Atomic');
    const availableBehaviors = new Set([...this.behaviorIds, ...packageBehaviorIds]);
    for (const behaviorId of definition.manifest.requires.behaviors ?? []) {
      requireAvailable(behaviorId, availableBehaviors, packageId, 'Behavior');
    }
    const availableStrategies = new Set(this.strategyIds);
    for (const strategyId of definition.manifest.requires.strategies ?? []) {
      requireAvailable(strategyId, availableStrategies, packageId, 'Strategy');
    }
    for (const skillName of declaredSkills) requireAvailable(skillName, this.skillNames, packageId, 'Skill');
    for (const knowledgeId of declaredKnowledge) requireAvailable(knowledgeId, this.knowledgeIds, packageId, 'Knowledge');

    const evaluatorSet = new Set(packageEvaluatorIds);
    for (const target of targets) {
      const predicates = (target.successCriteria ?? [])
        .filter(criterion => criterion.type === 'predicate')
        .map(criterion => requiredId(criterion.predicate, 'predicate criterion'));
      if (predicates.length === 0) {
        throw new Error(`capability target ${target.registryId} has no package-owned predicate criterion`);
      }
      for (const predicate of predicates) {
        if (!evaluatorSet.has(predicate) && !this.evaluatorIds.has(predicate)) {
          throw new Error(`capability target ${target.registryId} has no evaluator for ${predicate}`);
        }
      }
    }

    // Commit only after the complete validation pass above.
    this.packages.set(packageId, freezePackage(definition));
    packageBehaviorIds.forEach(id => this.behaviorIds.add(id));
    packageProviderIds.forEach(id => this.providerIds.add(id));
    packageWorldFactProviderIds.forEach(id => this.worldFactProviderIds.add(id));
    packageEvaluatorIds.forEach(id => this.evaluatorIds.add(id));
    packageTargetIds.forEach(id => this.goalTargetIds.add(id));
    proactiveManifestIds.forEach(id => this.proactiveTickIds.add(id));
  }

  snapshot(): CapabilityPackageSnapshot {
    const packages = [...this.packages.values()];
    return Object.freeze({
      packages: Object.freeze([...packages]),
      goalTargets: Object.freeze(packages.flatMap(value => [...value.manifest.goalTargets])),
      behaviors: Object.freeze(packages.flatMap(value => [...(value.behaviors ?? [])])),
      actionProviders: Object.freeze(packages.flatMap(value => [...value.actionProviders])),
      worldFactProviders: Object.freeze(packages.flatMap(value => [...(value.worldFactProviders ?? [])])),
      predicateEvaluators: Object.freeze(packages.flatMap(value => [...value.predicateEvaluators])),
      proactiveTicks: Object.freeze(packages.flatMap(toRegisteredProactiveTicks)),
    });
  }
}

function freezePackage(definition: CapabilityPackageDefinition): CapabilityPackageDefinition {
  return Object.freeze({
    ...definition,
    manifest: Object.freeze({
      ...definition.manifest,
      goalTargets: Object.freeze([...definition.manifest.goalTargets]),
      skills: Object.freeze([...definition.manifest.skills]),
      knowledge: Object.freeze([...definition.manifest.knowledge]),
      requires: Object.freeze({
        atomics: Object.freeze([...definition.manifest.requires.atomics]),
        ...(definition.manifest.requires.behaviors ? { behaviors: Object.freeze([...definition.manifest.requires.behaviors]) } : {}),
        ...(definition.manifest.requires.strategies ? { strategies: Object.freeze([...definition.manifest.requires.strategies]) } : {}),
      }),
      proactiveTicks: Object.freeze([...(definition.manifest.proactiveTicks ?? [])].map(freezeProactiveManifest)),
    }),
    behaviors: Object.freeze([...(definition.behaviors ?? [])]),
    actionProviders: Object.freeze([...definition.actionProviders]),
    worldFactProviders: Object.freeze([...(definition.worldFactProviders ?? [])]),
    predicateEvaluators: Object.freeze([...definition.predicateEvaluators]),
    proactiveTicks: Object.freeze([...(definition.proactiveTicks ?? [])]),
  });
}

function toRegisteredProactiveTicks(definition: CapabilityPackageDefinition): RegisteredProactiveTickCapability[] {
  const implementations = new Map((definition.proactiveTicks ?? []).map(value => [value.id, value]));
  return (definition.manifest.proactiveTicks ?? []).map(manifest => Object.freeze({
    packageId: definition.manifest.id,
    manifest,
    implementation: implementations.get(manifest.id)!,
  }));
}

function freezeProactiveManifest(value: ProactiveTickManifestEntry): ProactiveTickManifestEntry {
  return Object.freeze({
    ...value,
    conflictGroups: Object.freeze([...(value.conflictGroups ?? [])]),
    configSchema: Object.freeze(Object.fromEntries(Object.entries(value.configSchema ?? {}).map(([key, field]) => [
      key,
      Object.freeze({ ...field, ...(field.enum ? { enum: Object.freeze([...field.enum]) } : {}) }),
    ]))),
  });
}

function validateProactiveManifest(
  packageId: string,
  value: ProactiveTickManifestEntry,
  availableTargets: ReadonlySet<string>,
): void {
  requiredId(value.label, 'proactive Tick label');
  requiredId(value.description, 'proactive Tick description');
  const target = requiredId(value.goalTarget, 'proactive Tick goal target');
  if (!availableTargets.has(target)) {
    throw new Error(`capability package ${packageId} proactive Tick ${value.id} references unavailable goal target: ${target}`);
  }
  if (typeof value.defaultEnabled !== 'boolean') {
    throw new Error(`capability package ${packageId} proactive Tick ${value.id} defaultEnabled must be boolean`);
  }
  if (!['fast', 'std', 'slow', 'idle'].includes(value.rate)) {
    throw new Error(`capability package ${packageId} proactive Tick ${value.id} has invalid rate`);
  }
  if (!Number.isFinite(value.priority)) {
    throw new Error(`capability package ${packageId} proactive Tick ${value.id} has invalid priority`);
  }
  if (value.decisionMode !== 'deterministic' && value.decisionMode !== 'deliberative') {
    throw new Error(`capability package ${packageId} proactive Tick ${value.id} has invalid decisionMode`);
  }
  const conflictGroups = [...(value.conflictGroups ?? [])].map(group => requiredId(group, 'proactive Tick conflict group'));
  rejectLocalDuplicates(conflictGroups, 'proactive Tick conflict group');
  for (const [key, field] of Object.entries(value.configSchema ?? {})) {
    requiredId(key, 'proactive Tick config key');
    validateConfigField(packageId, value.id, key, field);
  }
}

function validateConfigField(
  packageId: string,
  tickId: string,
  key: string,
  field: ProactiveConfigFieldDefinition,
): void {
  if (!['boolean', 'number', 'string'].includes(field.type)) {
    throw new Error(`capability package ${packageId} proactive Tick ${tickId} config ${key} has invalid type`);
  }
  requiredId(field.label, 'proactive Tick config label');
  const matches = (field.type === 'boolean' && typeof field.default === 'boolean')
    || (field.type === 'number' && typeof field.default === 'number' && Number.isFinite(field.default))
    || (field.type === 'string' && typeof field.default === 'string');
  if (!matches) throw new Error(`capability package ${packageId} proactive Tick ${tickId} config ${key} has invalid default`);
  if (field.type !== 'number' && (field.min !== undefined || field.max !== undefined)) {
    throw new Error(`capability package ${packageId} proactive Tick ${tickId} config ${key} has invalid bounds`);
  }
  if (field.min !== undefined && field.max !== undefined && field.min > field.max) {
    throw new Error(`capability package ${packageId} proactive Tick ${tickId} config ${key} min exceeds max`);
  }
  if (field.type === 'number') {
    const value = field.default as number;
    if (field.min !== undefined && value < field.min) throw new Error(`capability package ${packageId} proactive Tick ${tickId} config ${key} default below min`);
    if (field.max !== undefined && value > field.max) throw new Error(`capability package ${packageId} proactive Tick ${tickId} config ${key} default above max`);
  }
  if (field.enum && (field.type !== 'string' || !field.enum.includes(field.default as string))) {
    throw new Error(`capability package ${packageId} proactive Tick ${tickId} config ${key} has invalid enum default`);
  }
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every(value => right.includes(value));
}

function ids(values: readonly { readonly id: string }[], label: string): string[] {
  return values.map(value => requiredId(value.id, label));
}

function requiredId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} id is required`);
  return value.trim();
}

function normalizedSet(values: readonly string[]): Set<string> {
  return new Set(values.map(value => requiredId(value, 'environment resource')));
}

function rejectLocalDuplicates(values: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new Error(`duplicate ${label} id: ${value}`);
    seen.add(value);
  }
}

function rejectExisting(values: readonly string[], existing: ReadonlySet<string>, label: string): void {
  for (const value of values) {
    if (existing.has(value)) throw new Error(`duplicate ${label} id: ${value}`);
  }
}

function requireAvailable(value: string, available: ReadonlySet<string>, packageId: string, label: string): void {
  const id = requiredId(value, `${label} reference`);
  if (!available.has(id)) throw new Error(`capability package ${packageId} requires unavailable ${label}: ${id}`);
}
