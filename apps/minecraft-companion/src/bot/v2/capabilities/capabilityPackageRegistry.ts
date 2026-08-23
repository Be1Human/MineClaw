import type {
  CapabilityPackageDefinition,
  CapabilityPackageEnvironment,
  CapabilityPackageSnapshot,
} from './types.js';

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
    if (targets.length === 0) throw new Error(`capability package ${packageId} requires manifest goalTargets`);
    if (declaredSkills.length === 0) throw new Error(`capability package ${packageId} requires Skill references`);
    if (declaredKnowledge.length === 0) throw new Error(`capability package ${packageId} requires Knowledge references`);
    if (atomics.length === 0) throw new Error(`capability package ${packageId} requires Atomic references`);
    if (definition.actionProviders.length === 0) throw new Error(`capability package ${packageId} has no execution path`);
    if (definition.predicateEvaluators.length === 0) throw new Error(`capability package ${packageId} has no verification path`);

    const packageBehaviorIds = ids(definition.behaviors ?? [], 'behavior');
    const packageProviderIds = ids(definition.actionProviders, 'action provider');
    const packageWorldFactProviderIds = ids(definition.worldFactProviders ?? [], 'world fact provider');
    const packageEvaluatorIds = ids(definition.predicateEvaluators, 'predicate evaluator');
    const packageTargetIds = targets.map(target => requiredId(target.registryId, 'goal target'));
    rejectLocalDuplicates(packageBehaviorIds, 'behavior');
    rejectLocalDuplicates(packageProviderIds, 'action provider');
    rejectLocalDuplicates(packageWorldFactProviderIds, 'world fact provider');
    rejectLocalDuplicates(packageEvaluatorIds, 'predicate evaluator');
    rejectLocalDuplicates(packageTargetIds, 'goal target');
    rejectLocalDuplicates(declaredSkills.map(value => requiredId(value, 'Skill reference')), 'Skill reference');
    rejectLocalDuplicates(declaredKnowledge.map(value => requiredId(value, 'Knowledge reference')), 'Knowledge reference');
    rejectLocalDuplicates(atomics.map(value => requiredId(value, 'Atomic reference')), 'Atomic reference');

    rejectExisting(packageBehaviorIds, this.behaviorIds, 'behavior');
    rejectExisting(packageProviderIds, this.providerIds, 'action provider');
    rejectExisting(packageWorldFactProviderIds, this.worldFactProviderIds, 'world fact provider');
    rejectExisting(packageEvaluatorIds, this.evaluatorIds, 'predicate evaluator');
    rejectExisting(packageTargetIds, this.goalTargetIds, 'goal target');

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
    }),
    behaviors: Object.freeze([...(definition.behaviors ?? [])]),
    actionProviders: Object.freeze([...definition.actionProviders]),
    worldFactProviders: Object.freeze([...(definition.worldFactProviders ?? [])]),
    predicateEvaluators: Object.freeze([...definition.predicateEvaluators]),
  });
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
