import { assertBehaviorDefinition } from '../behavior/behaviorDefinition.js';
import type {
  CapabilityPackageDefinition,
  CapabilityPackageEnvironment,
  CapabilityPackageSnapshot,
} from './types.js';
import { jsonSnapshot } from '../infra/jsonSnapshot.js';
import { parseCapabilityOperation, type CapabilityOperationDefinition } from './capabilityOperation.js';
import { assertSchemaSupported } from '../infra/closedJsonSchema.js';
import { validatePredicateArguments } from '../task/goalRunner/goalPredicateEvaluation.js';
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
  private readonly operationIds = new Set<string>();
  private readonly goalBindingProviderIds = new Set<string>();
  private readonly progressProviderIds = new Set<string>();
  private readonly atomicIds: Set<string>;
  private readonly strategyIds: Set<string>;
  private readonly skillNames: Set<string>;
  private readonly knowledgeIds: Set<string>;
  private readonly taskKinds: Set<string>;

  constructor(environment: CapabilityPackageEnvironment) {
    this.atomicIds = normalizedSet(environment.atomicIds);
    this.behaviorIds = normalizedSet(environment.behaviorIds);
    this.strategyIds = normalizedSet(environment.strategyIds ?? []);
    this.skillNames = normalizedSet(environment.skillNames);
    this.knowledgeIds = normalizedSet(environment.knowledgeIds);
    this.goalTargetIds = normalizedSet(environment.goalTargetIds ?? []);
    this.taskKinds = normalizedSet(environment.taskKinds ?? []);
  }

  register(definition: CapabilityPackageDefinition): void {
    const packageId = requiredId(definition.manifest?.id, 'package');
    if (this.packages.has(packageId)) throw new Error(`duplicate capability package id: ${packageId}`);
    if (!['mineclaw/capability-manifest@1', 'mineclaw/capability-manifest@2'].includes(definition.manifest?.schema)) {
      throw new Error(`capability package ${packageId} has unsupported manifest schema`);
    }
    if (!Number.isInteger(definition.manifest.version) || definition.manifest.version < 1) {
      throw new Error(`capability package ${packageId} has invalid manifest version`);
    }
    requiredId(definition.manifest.description, 'manifest description');
    const v2 = definition.manifest.schema === 'mineclaw/capability-manifest@2';
    if (!v2 && definition.manifest.operations !== undefined) throw new Error('operations require manifest@2');
    const operations = (definition.manifest.operations ?? []).map(parseCapabilityOperation);
    rejectLocalDuplicates(operations.map(value => value.id), 'operation');
    rejectExisting(operations.map(value => value.id), this.operationIds, 'operation');
    const semantics = definition.operationSemantics ?? [];
    rejectLocalDuplicates(semantics.map(value => requiredId(value.operationId, 'operation semantics')), 'operation semantics');
    for (const resolver of semantics) {
      if (!v2 || !operations.some(operation => operation.id === resolver.operationId)) throw new Error('operation semantics must belong to this @2 package');
      requiredId(resolver.version, 'operation semantics version');
      if (typeof resolver.resolve !== 'function') throw new Error('operation semantics requires code-owned resolve');
    }

    const targets = definition.manifest?.goalTargets ?? [];
    const declaredSkills = definition.manifest?.skills ?? [];
    const declaredKnowledge = definition.manifest?.knowledge ?? [];
    const atomics = definition.manifest?.requires?.atomics ?? [];
    const proactiveManifests = definition.manifest.proactiveTicks ?? [];
    const declarativeOnly = targets.length === 0 && (proactiveManifests.length > 0 || (v2 && operations.length > 0));
    if (!declarativeOnly && targets.length === 0) throw new Error(`capability package ${packageId} requires manifest goalTargets`);
    if (!declarativeOnly && declaredSkills.length === 0) throw new Error(`capability package ${packageId} requires Skill references`);
    if (!declarativeOnly && declaredKnowledge.length === 0) throw new Error(`capability package ${packageId} requires Knowledge references`);
    if (!declarativeOnly && atomics.length === 0) throw new Error(`capability package ${packageId} requires Atomic references`);
    if (!declarativeOnly && definition.actionProviders.length === 0) throw new Error(`capability package ${packageId} has no execution path`);
    if (!declarativeOnly && definition.predicateEvaluators.length === 0) throw new Error(`capability package ${packageId} has no verification path`);

    const packageBehaviorIds = ids(definition.behaviors ?? [], 'behavior');
    const packageProviderIds = ids(definition.actionProviders, 'action provider');
    const packageWorldFactProviderIds = ids(definition.worldFactProviders ?? [], 'world fact provider');
    const packageGoalBindingIds = ids(definition.goalBindingProviders ?? [], 'goal binding provider');
    const packageProgressIds = ids(definition.progressProviders ?? [], 'progress provider');
    rejectLocalDuplicates(packageProgressIds, 'progress provider');
    rejectExisting(packageProgressIds, this.progressProviderIds, 'progress provider');
    for (const provider of definition.progressProviders ?? []) {
      if (!v2 || typeof provider.assess !== 'function' || typeof provider.project !== 'function') throw new Error('progress provider requires @2 code-owned assess/project');
    }
    rejectLocalDuplicates(packageGoalBindingIds, 'goal binding provider');
    rejectExisting(packageGoalBindingIds, this.goalBindingProviderIds, 'goal binding provider');
    if (packageGoalBindingIds.length && !v2) throw new Error('goal binding providers require manifest@2');
    for (const provider of definition.goalBindingProviders ?? []) {
      if (typeof provider.list !== 'function') throw new Error(`goal binding provider ${provider.id} has no list implementation`);
    }
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
    const resources = {
      atomic: this.atomicIds, behavior: availableBehaviors,
      strategy: this.strategyIds, task: this.taskKinds,
    };
    for (const provider of definition.actionProviders) {
      if (typeof provider.list !== 'function') throw new Error(`action provider ${provider.id} has no list implementation`);
    }
    for (const provider of definition.worldFactProviders ?? []) {
      if (typeof provider.observe !== 'function') throw new Error(`world fact provider ${provider.id} has no observe implementation`);
      if (provider.version !== undefined || provider.inputSchema !== undefined) {
        requiredId(provider.version, 'world fact version');
        if (provider.inputSchema?.type !== 'object' || provider.inputSchema.additionalProperties !== false) {
          throw new Error(`world fact ${provider.id} requires a closed input schema`);
        }
        assertSchemaSupported(jsonSnapshot(provider.inputSchema));
      }
    }
    for (const evaluator of definition.predicateEvaluators) {
      if (typeof evaluator.evaluate !== 'function') throw new Error(`predicate evaluator ${evaluator.id} has no evaluate implementation`);
      if (evaluator.version !== undefined || evaluator.argumentSchema !== undefined) {
        requiredId(evaluator.version, 'predicate version');
        if (evaluator.argumentSchema?.type !== 'object' || evaluator.argumentSchema.additionalProperties !== false) {
          throw new Error(`predicate ${evaluator.id} requires a closed argument schema`);
        }
        assertSchemaSupported(jsonSnapshot(evaluator.argumentSchema));
        if (evaluator.factRequirements !== undefined && typeof evaluator.factRequirements !== 'function') {
          throw new Error(`predicate ${evaluator.id} factRequirements must be code-owned`);
        }
        if (evaluator.authorizeGoal !== undefined && typeof evaluator.authorizeGoal !== 'function') throw new Error(`predicate ${evaluator.id} authorizeGoal must be code-owned`);
      }
    }
    for (const behavior of definition.behaviors ?? []) {
      assertBehaviorDefinition(behavior);
    }
    for (const operation of operations) {
      requireAvailable(operation.executorRef.id, resources[operation.kind], packageId, 'operation executor');
      requireAvailable(operation.actionProviderId, new Set(packageProviderIds), packageId, 'operation action provider');
      const evaluators = new Set([...this.evaluatorIds, ...packageEvaluatorIds]);
      for (const ref of operation.verificationRefs) requireAvailable(ref, evaluators, packageId, 'operation verifier');
      for (const effect of operation.effects) requireAvailable(effect.id, evaluators, packageId, 'operation effect verifier');
      for (const condition of operation.preconditions) requireAvailable(condition.id, evaluators, packageId, 'operation precondition verifier');
      for (const ref of operation.worldFactRefs) {
        requireAvailable(ref, new Set([...this.worldFactProviderIds, ...packageWorldFactProviderIds]), packageId, 'operation world fact');
      }
      if (operation.kind === 'atomic' && !atomics.includes(operation.executorRef.id)) {
        throw new Error(`operation ${operation.id} executor must be declared in requires.atomics`);
      }
      if (operation.kind === 'behavior' && !(definition.manifest.requires.behaviors ?? []).includes(operation.executorRef.id)) {
        throw new Error(`operation ${operation.id} executor must be declared in requires.behaviors`);
      }
      if (operation.kind === 'strategy' && !(definition.manifest.requires.strategies ?? []).includes(operation.executorRef.id)) {
        throw new Error(`operation ${operation.id} executor must be declared in requires.strategies`);
      }
    }
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
      for (const criterion of target.successCriteria ?? []) {
        if (criterion.type !== 'predicate') continue;
        const evaluator = [...definition.predicateEvaluators, ...this.snapshot().predicateEvaluators].find(value => value.id === criterion.predicate);
        if (evaluator?.version || criterion.predicateVersion !== undefined || criterion.args !== undefined) {
          validatePredicateArguments(criterion, evaluator!);
        }
      }
    }

    // Commit only after the complete validation pass above.
    this.packages.set(packageId, freezePackage(definition, operations));
    packageBehaviorIds.forEach(id => this.behaviorIds.add(id));
    packageProviderIds.forEach(id => this.providerIds.add(id));
    packageWorldFactProviderIds.forEach(id => this.worldFactProviderIds.add(id));
    packageEvaluatorIds.forEach(id => this.evaluatorIds.add(id));
    packageTargetIds.forEach(id => this.goalTargetIds.add(id));
    proactiveManifestIds.forEach(id => this.proactiveTickIds.add(id));
    operations.forEach(value => this.operationIds.add(value.id));
    packageGoalBindingIds.forEach(id => this.goalBindingProviderIds.add(id));
    packageProgressIds.forEach(id => this.progressProviderIds.add(id));
  }

  snapshot(): CapabilityPackageSnapshot {
    const packages = [...this.packages.values()];
    return Object.freeze({
      packages: Object.freeze([...packages]),
      goalTargets: Object.freeze(packages.flatMap(value => [...value.manifest.goalTargets])),
      behaviors: Object.freeze(packages.flatMap(value => [...(value.behaviors ?? [])])),
      actionProviders: Object.freeze(packages.flatMap(value => [...value.actionProviders])),
      worldFactProviders: Object.freeze(packages.flatMap(value => [...(value.worldFactProviders ?? [])])),
      goalBindingProviders: Object.freeze(packages.flatMap(value => [...(value.goalBindingProviders ?? [])])),
      operationSemantics: Object.freeze(packages.flatMap(value => [...(value.operationSemantics ?? [])])),
      progressProviders: Object.freeze(packages.flatMap(value => [...(value.progressProviders ?? [])])),
      predicateEvaluators: Object.freeze(packages.flatMap(value => [...value.predicateEvaluators])),
      proactiveTicks: Object.freeze(packages.flatMap(toRegisteredProactiveTicks)),
      operations: Object.freeze(packages.flatMap(value => (value.manifest.operations ?? []).map(definition => Object.freeze({
        packageId: value.manifest.id, packageVersion: value.manifest.version, definition,
      })))),
    });
  }
}

function freezePackage(definition: CapabilityPackageDefinition, operations: readonly CapabilityOperationDefinition[]): CapabilityPackageDefinition {
  return Object.freeze({
    ...definition,
    manifest: Object.freeze({
      ...definition.manifest,
      goalTargets: jsonSnapshot([...definition.manifest.goalTargets]),
      skills: Object.freeze([...definition.manifest.skills]),
      knowledge: Object.freeze([...definition.manifest.knowledge]),
      requires: Object.freeze({
        atomics: Object.freeze([...definition.manifest.requires.atomics]),
        ...(definition.manifest.requires.behaviors ? { behaviors: Object.freeze([...definition.manifest.requires.behaviors]) } : {}),
        ...(definition.manifest.requires.strategies ? { strategies: Object.freeze([...definition.manifest.requires.strategies]) } : {}),
      }),
      proactiveTicks: Object.freeze([...(definition.manifest.proactiveTicks ?? [])].map(freezeProactiveManifest)),
      ...(definition.manifest.schema === 'mineclaw/capability-manifest@2' ? { operations: Object.freeze([...operations]) } : {}),
    }),
    behaviors: Object.freeze([...(definition.behaviors ?? [])]),
    actionProviders: Object.freeze([...definition.actionProviders]),
    goalBindingProviders: Object.freeze((definition.goalBindingProviders ?? []).map(provider => Object.freeze({ id: provider.id, list: provider.list.bind(provider) }))),
    operationSemantics: Object.freeze((definition.operationSemantics ?? []).map(resolver => Object.freeze({ operationId: resolver.operationId, version: resolver.version, resolve: resolver.resolve.bind(resolver) }))),
    progressProviders: Object.freeze((definition.progressProviders ?? []).map(provider => Object.freeze({ id: provider.id, assess: provider.assess.bind(provider), project: provider.project.bind(provider) }))),
    worldFactProviders: Object.freeze((definition.worldFactProviders ?? []).map(provider => Object.freeze({
      id: provider.id,
      ...(provider.version !== undefined ? { version: provider.version } : {}),
      ...(provider.inputSchema ? { inputSchema: jsonSnapshot(provider.inputSchema) } : {}),
      observe: provider.observe.bind(provider),
    }))),
    predicateEvaluators: Object.freeze(definition.predicateEvaluators.map(evaluator => Object.freeze({
      id: evaluator.id,
      ...(evaluator.version !== undefined ? { version: evaluator.version } : {}),
      ...(evaluator.argumentSchema ? { argumentSchema: jsonSnapshot(evaluator.argumentSchema) } : {}),
      ...(evaluator.factRequirements ? { factRequirements: evaluator.factRequirements.bind(evaluator) } : {}),
      ...(evaluator.authorizeGoal ? { authorizeGoal: evaluator.authorizeGoal.bind(evaluator) } : {}),
      evaluate: evaluator.evaluate.bind(evaluator),
    }))),
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
