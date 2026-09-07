import type { PublishedGenerationSlot, StagedContributionRecord } from './registration.js';
import type { RegistrySnapshotRef, PluginGoalLease } from '../plugin-sdk/identity.js';
import type { PluginObservationFact, PluginObservationProviderFactory } from '../plugin-sdk/contracts/observation.js';
import type { PluginPlanningInput } from '../plugin-sdk/contracts/planning.js';
import type { GoalTargetDefinition } from '../knowledge/goalTargetKnowledge.js';
import type { GoalSuccessCriterion } from '../task/contracts/goalTypes.js';
import type { GoalScopeBinding } from '../task/contracts/goalDraft.js';
import type { GoalAgentStateV1 } from '../task/goalAgent/goalAgentState.js';
import type { GoalAgentActionCandidate } from '../task/goalAgent/ports/executionPort.js';
import type { GoalPredicateEvaluator } from '../task/goalRunner/goalCriteriaEvaluator.js';
import type { WorldFact } from '../task/contracts/worldFact.js';
import type { WorldStateView } from '../types.js';
import type { RegisteredProactiveTickCapability } from '../proactive/contracts.js';
import type { ResolvedGenerationOperation } from '../task/goalAgent/goalPlanAuthority.js';
import type { GoalProgressContributionPort } from '../task/goalAgent/ports/goalProgressPort.js';
import { createScopedHostContext } from '../plugin-sdk/contracts/scopedContext.js';
import { tuning } from '../infra/tuning.js';

export interface RuntimeActionCandidateProvider {
  readonly id: string;
  list(input: {
    readonly state: Readonly<GoalAgentStateV1>;
    readonly planNodeId?: string;
    readonly criteria: readonly GoalSuccessCriterion[];
    readonly goalText: string;
    readonly world: WorldStateView;
    readonly signal: AbortSignal;
  }): Promise<readonly GoalAgentActionCandidate[]>;
}

export interface RuntimeWorldFactProvider {
  readonly id: string;
  readonly version: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  observe(input: {
    readonly world: WorldStateView;
    readonly params?: Readonly<Record<string, unknown>>;
    readonly signal?: AbortSignal;
  }): Promise<WorldFact>;
}

export interface RuntimeActivityCapability {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly aliases: readonly string[];
  readonly contribution: StagedContributionRecord['ref'];
}

/**
 * Read-only application projection over one published Registry Generation.
 * It is the only bridge from typed plugin contributions into GoalAgent ports;
 * it owns no domain rules and never caches live implementations outside the
 * snapshot selected by the caller.
 */
export class GenerationRuntimeProjection {
  constructor(private readonly slot: PublishedGenerationSlot, private readonly hostApiVersion: string) {}

  activeSnapshot(): RegistrySnapshotRef {
    const active = this.slot.read().active;
    return { generationId: active.generationId, buildId: active.buildId, graphHash: active.graphHash };
  }

  goalTargets(snapshot: RegistrySnapshotRef): readonly GoalTargetDefinition[] {
    return this.entries(snapshot, 'goal').flatMap(entry => {
      if (entry.contribution.kind !== 'goal') return [];
      const target = entry.contribution.target;
      const operation = this.entries(snapshot, 'execution').find(candidate => candidate.contribution.kind === 'execution'
        && candidate.contribution.operation?.goalContributionId === entry.ref.contributionId);
      const criteria = target.successCriteria.map(criterion => {
        if (criterion.type !== 'predicate') return { ...criterion };
        const predicate = this.findPredicate(snapshot, criterion.predicate ?? '');
        return { ...criterion, predicateVersion: predicate?.version ?? '1.0.0', args: criterion.args ?? {} };
      });
      return [{
        contribution: entry.ref,
        kind: target.goalKind === 'composite' ? 'state' : target.goalKind,
        registryId: target.registryId,
        aliases: [...target.aliases],
        taskFamilies: target.taskFamilies?.length ? [...target.taskFamilies] : [entry.ref.pluginId],
        ...(operation?.contribution.kind === 'execution' && operation.contribution.operation
          ? { bindingContributionId: operation.contribution.operation.bindingContributionId }
          : {}),
        successCriteriaPolicy: criteria.some(criterion => criterion.type === 'predicate') ? 'authoritative' : 'fallback',
        successCriteria: criteria,
      } as GoalTargetDefinition];
    });
  }

  behaviorEntries(snapshot: RegistrySnapshotRef): readonly {
    readonly id: string;
    readonly contribution: StagedContributionRecord['ref'];
  }[] {
    return this.entries(snapshot, 'execution').flatMap(entry => entry.contribution.kind === 'execution' && entry.contribution.behaviorFactory
      ? [{ id: entry.contribution.behaviorFactory.id, contribution: entry.ref }]
      : []);
  }

  /** Persistent user-callable activities are derived from Goal + Execution registration, never a core switch. */
  activityCapabilities(snapshot: RegistrySnapshotRef): readonly RuntimeActivityCapability[] {
    const goals = this.entries(snapshot, 'goal').filter(entry => entry.contribution.kind === 'goal');
    return this.entries(snapshot, 'execution').flatMap(entry => {
      if (entry.contribution.kind !== 'execution' || !entry.contribution.activityFactory || !entry.contribution.operation) return [];
      const operation = entry.contribution.operation;
      const goal = goals.find(candidate => candidate.ref.contributionId === operation.goalContributionId);
      if (!goal || goal.contribution.kind !== 'goal') return [];
      return [{
        id: goal.contribution.target.registryId,
        title: goal.contribution.target.aliases[0] ?? goal.contribution.target.registryId,
        description: `持续执行 ${goal.contribution.target.registryId}，直到主人停止。`,
        aliases: [...goal.contribution.target.aliases],
        contribution: entry.ref,
      }];
    });
  }

  resolveOperation(snapshot: RegistrySnapshotRef, ref: StagedContributionRecord['ref']): ResolvedGenerationOperation {
    const entry = this.entry(snapshot, ref.contributionId);
    if (!entry || entry.contribution.kind !== 'execution' || !entry.contribution.operation
      || !sameContribution(entry.ref, ref)) throw new Error(`operation_contribution_unavailable:${ref.contributionId}`);
    const verification = this.entry(snapshot, entry.contribution.operation.predicateContributionId);
    if (!verification || verification.contribution.kind !== 'verification') {
      throw new Error(`operation_predicate_unavailable:${entry.contribution.operation.predicateContributionId}`);
    }
    return {
      contribution: entry.ref,
      operation: entry.contribution.operation,
      predicates: verification.contribution.predicates.map(predicate => ({
        contribution: verification.ref,
        id: predicate.id,
        version: predicate.version,
        argumentSchema: predicate.argumentSchema ?? { type: 'object', additionalProperties: true },
        evaluate: input => {
          const result = predicate.evaluate({
            goal: goalLease(undefined, snapshot), snapshot,
            evidence: input.evidence as unknown as Readonly<Record<string, unknown>>,
            facts: (input.facts ?? []).flatMap(fact => fact.pluginFact ? [fact.pluginFact] : []) as unknown as readonly Readonly<Record<string, unknown>>[],
            args: input.criterion.args ?? {},
            signal: new AbortController().signal,
          });
          if (result instanceof Promise) throw new Error(`async_predicate_not_supported_by_sync_verifier:${predicate.id}`);
          return { status: result.verdict, detail: result.reason ?? result.verdict, evidenceRefs: [...result.evidenceRefs] };
        },
      })),
    };
  }

  actionProviders(snapshot: RegistrySnapshotRef): readonly RuntimeActionCandidateProvider[] {
    const planning = this.entries(snapshot, 'planning');
    const executions = this.entries(snapshot, 'execution').filter(entry => entry.contribution.kind === 'execution'
      && entry.contribution.operation && entry.contribution.behaviorFactory);
    return planning.flatMap(entry => {
      if (entry.contribution.kind !== 'planning') return [];
      const operationEntry = executions.find(candidate => candidate.contribution.kind === 'execution'
        && candidate.contribution.operation?.candidateContributionId === entry.ref.contributionId);
      if (!operationEntry || operationEntry.contribution.kind !== 'execution' || !operationEntry.contribution.operation) return [];
      const operation = operationEntry.contribution.operation;
      const provider = entry.contribution.candidateProvider;
      return [{
        id: provider.id,
        list: async input => {
          const facts = await this.observeKinds(snapshot, input.world, operation.factKinds, input.signal);
          const base = planningParams(input.criteria, input.goalText, input.world);
          const bindingEntry = this.entry(snapshot, operation.bindingContributionId);
          const bindingProvider = bindingEntry?.contribution.kind === 'goal' ? bindingEntry.contribution.bindingProvider : undefined;
          const scopes = bindingProvider
            ? await bindingProvider.list(this.planningInput(input.state, snapshot, facts, base, input.signal))
            : null;
          if (scopes && !['complete', 'partial'].includes(scopes.status)) return [];
          const bound = scopes?.bindings.length ? scopes.bindings : [{ scope: {} }];
          const results = await Promise.all(bound.map(async binding => provider.list(this.planningInput(
            input.state,
            snapshot,
            facts,
            { ...base, ...binding.scope, bindingScope: binding.scope },
            input.signal,
          ))));
          return results.flatMap(result => !['complete', 'partial'].includes(result.status) ? [] : result.candidates.map(candidate => ({
            id: `plugin:${candidate.contribution.contributionId}:${candidate.candidateId}`,
            kind: 'behavior' as const,
            source: 'registered_behavior' as const,
            action: 'invoke_behavior',
            description: `Execute ${operation.operationId}`,
            fixedArgs: {
              behavior: candidate.operationContribution.contributionId,
              behaviorParams: structuredClone(candidate.params),
            },
            argumentSchema: { type: 'object', additionalProperties: false, properties: {} },
            authorization: candidate.authorization ?? { status: 'ready' as const, reasons: [] },
            ...(candidate.prerequisites ? { prerequisites: structuredClone(candidate.prerequisites) } : {}),
            operationRef: candidate.operationContribution,
            evidenceRefs: [...candidate.evidenceRefs, `contribution:${candidate.contribution.contributionId}@${candidate.contribution.contributionVersion}`],
          })));
        },
      } satisfies RuntimeActionCandidateProvider];
    });
  }

  async goalBindings(
    snapshot: RegistrySnapshotRef,
    state: Readonly<GoalAgentStateV1>,
    world: WorldStateView,
    signal: AbortSignal,
  ): Promise<readonly GoalScopeBinding[]> {
    const facts = await this.observeKinds(snapshot, world, null, signal);
    const params = planningParams(state.rootGoal?.successCriteria ?? [], state.request.requestText, world);
    const requestSurface = normalizeSurface(state.request.requestText);
    const executions = this.entries(snapshot, 'execution').filter(entry => entry.contribution.kind === 'execution' && entry.contribution.operation);
    const entries = this.entries(snapshot, 'goal').filter(entry => {
      if (entry.contribution.kind !== 'goal' || !entry.contribution.bindingProvider) return false;
      const operation = executions.find(candidate => candidate.contribution.kind === 'execution'
        && candidate.contribution.operation?.bindingContributionId === entry.ref.contributionId);
      if (!operation || operation.contribution.kind !== 'execution' || !operation.contribution.operation) return false;
      const goal = this.entry(snapshot, operation.contribution.operation.goalContributionId);
      return goal?.contribution.kind === 'goal'
        && goal.contribution.target.aliases.some(alias => requestSurface.includes(normalizeSurface(alias)));
    });
    const results = await Promise.all(entries.map(async entry => {
      if (entry.contribution.kind !== 'goal' || !entry.contribution.bindingProvider) return [];
      const result = await entry.contribution.bindingProvider.list(this.planningInput(state, snapshot, facts, params, signal));
      if (result.status === 'ambiguous' && result.needsOwner) {
        throw new Error(`needs_owner_scope:${result.needsOwner.questionKind}:${result.needsOwner.options.join('|')}`);
      }
      if (result.status === 'unavailable') throw new Error(`goal_binding_unavailable:${entry.ref.contributionId}:${result.reason ?? 'unknown'}`);
      if (!['complete', 'partial'].includes(result.status)) return [];
      return result.bindings.map(binding => projectGoalScopeBinding(
        entry,
        binding.bindingId,
        binding.scope,
        binding.evidenceRefs,
        world.environment.dimension,
      ));
    }));
    return results.flat();
  }

  worldFactProviders(snapshot: RegistrySnapshotRef): readonly RuntimeWorldFactProvider[] {
    return this.entries(snapshot, 'observation').flatMap(entry => {
      if (entry.contribution.kind !== 'observation') return [];
      const factory = entry.contribution.factory;
      return [{
        id: entry.ref.contributionId,
        version: entry.ref.contributionVersion,
        inputSchema: factory.descriptor.inputSchema,
        observe: async input => {
          const controller = linkedAbort(input.signal);
          const fact = await this.observeFactory(snapshot, entry, factory, input.world, input.params ?? {}, controller.signal);
          if (!fact) throw new Error(`world_fact_provider_unavailable:${entry.ref.contributionId}`);
          return pluginFactToWorldFact(fact);
        },
      }];
    });
  }

  predicateEvaluators(snapshot: RegistrySnapshotRef, state?: Readonly<GoalAgentStateV1>): readonly GoalPredicateEvaluator[] {
    return this.entries(snapshot, 'verification').flatMap(entry => {
      if (entry.contribution.kind !== 'verification') return [];
      return entry.contribution.predicates.map(predicate => ({
        contribution: entry.ref,
        id: predicate.id,
        version: predicate.version,
        argumentSchema: predicate.argumentSchema ?? { type: 'object', additionalProperties: true },
        evaluate: input => {
          const args = {
            ...(input.criterion.args ?? {}),
            ...behaviorParams(state?.action.proposal?.args),
          };
          const facts = (input.facts ?? input.evidence.worldFacts ?? input.world.capabilityFacts ?? [])
            .flatMap(fact => fact.pluginFact ? [fact.pluginFact] : []);
          const result = predicate.evaluate({
            goal: goalLease(state, snapshot), snapshot,
            evidence: input.evidence as unknown as Readonly<Record<string, unknown>>,
            facts: facts as unknown as readonly Readonly<Record<string, unknown>>[],
            args,
            signal: new AbortController().signal,
          });
          if (result instanceof Promise) throw new Error(`async_predicate_not_supported_by_sync_verifier:${predicate.id}`);
          return { status: result.verdict, detail: result.reason ?? result.verdict, evidenceRefs: [...result.evidenceRefs] };
        },
      } satisfies GoalPredicateEvaluator));
    });
  }

  async observeAll(snapshot: RegistrySnapshotRef, world: WorldStateView, signal: AbortSignal): Promise<readonly WorldFact[]> {
    const facts = await this.observeKinds(snapshot, world, null, signal);
    return facts.map(pluginFactToWorldFact);
  }

  /** Resolve and evaluate the goal's declared Progress Contribution in its pinned generation. */
  progressPort(): GoalProgressContributionPort {
    return {
      read: async (state, signal) => {
        const snapshot = state.snapshotRef;
        const world = state.world.latest;
        if (!snapshot || !world) throw new Error('progress_contribution_unavailable:missing_snapshot_or_world');
        const sourceIds = new Set(state.rootGoal && 'source' in state.rootGoal
          ? state.rootGoal.source.contributions.map(value => value.contributionId)
          : []);
        const execution = this.entries(snapshot, 'execution').find(entry => entry.contribution.kind === 'execution'
          && entry.contribution.operation
          && (sourceIds.has(entry.contribution.operation.goalContributionId)
            || sourceIds.has(entry.contribution.operation.bindingContributionId)));
        if (!execution || execution.contribution.kind !== 'execution' || !execution.contribution.operation) {
          throw new Error('progress_contribution_unavailable:goal_operation_not_bound');
        }
        const operation = execution.contribution.operation;
        const entry = this.entry(snapshot, operation.progressContributionId);
        if (!entry || entry.contribution.kind !== 'planning' || !entry.contribution.progressProvider) {
          throw new Error(`progress_contribution_unavailable:${operation.progressContributionId}`);
        }
        const facts = await this.observeKinds(snapshot, world, operation.factKinds, signal);
        const result = await entry.contribution.progressProvider.assess(this.planningInput(
          state,
          snapshot,
          facts,
          { ...planningParams(state.rootGoal?.successCriteria ?? [], state.request.requestText, world), ...behaviorParams(state.action.proposal?.args) },
          signal,
        ));
        if (result.status === 'cancelled') throw signal.reason ?? new Error('progress_read_cancelled');
        if (!result.progress || !['complete', 'partial'].includes(result.status)) {
          throw new Error(`progress_contribution_unavailable:${result.reason ?? result.status}`);
        }
        if (!sameContribution(result.progress.contribution, entry.ref)) {
          throw new Error(`progress_contribution_identity_mismatch:${entry.ref.contributionId}`);
        }
        const observedAt = facts.reduce((latest, fact) => Math.max(latest, Date.parse(fact.observedAt)), world.timestamp);
        const evidenceRefs = [...new Set([
          ...result.progress.evidenceRefs,
          ...facts.flatMap(fact => fact.evidenceRefs.map(evidence => evidence.ref)),
          `contribution:${entry.ref.contributionId}@${entry.ref.contributionVersion}`,
        ])];
        const incomplete = result.status === 'partial' || result.progress.truncated || facts.some(fact => !fact.complete || fact.truncated);
        return {
          snapshot,
          contribution: entry.ref,
          observedAt,
          semanticState: {
            completed: result.progress.completed,
            total: result.progress.total,
            blocked: result.progress.blocked,
            truncated: result.progress.truncated,
          },
          evidenceRefs,
          guidance: incomplete ? {
            kind: 'wait' as const,
            key: `progress:${entry.ref.contributionId}`,
            reason: result.reason ?? '进展观察不完整，等待固定代际的后续事实。',
            observedAt,
            evidenceRefs,
          } : null,
        };
      },
    };
  }

  proactive(snapshot: RegistrySnapshotRef): readonly RegisteredProactiveTickCapability[] {
    return this.entries(snapshot, 'proactive').flatMap(entry => {
      if (entry.contribution.kind !== 'proactive') return [];
      const contribution = entry.contribution;
      return [{
        packageId: entry.ref.pluginId,
        manifest: {
          id: contribution.id,
          label: contribution.label,
          description: contribution.description,
          goalTarget: contribution.goalTarget,
          defaultEnabled: contribution.defaultEnabled ?? true,
          rate: contribution.rate,
          priority: contribution.priority,
          decisionMode: 'deterministic',
          conflictGroups: contribution.conflictGroups,
          configSchema: contribution.configSchema,
        },
        implementation: {
          id: contribution.id,
          evaluate: context => contribution.evaluator({
            world: context.world,
            ownerPresent: context.world?.owner?.isVisible === true,
            config: context.config,
          })
            ? { kind: 'candidate', candidate: {
                requestText: contribution.description,
                evidenceRefs: [`contribution:${entry.ref.contributionId}@${entry.ref.contributionVersion}`],
                // A persistent capability must retain its existing lease while
                // its subject is unchanged. Tick-based keys re-created the
                // request on every evaluation and could repeatedly restart it.
                idempotencyKey: `${contribution.id}:${context.world?.owner?.entityId ?? 'world'}`,
              } }
            : { kind: 'idle', reason: 'plugin_evaluator_false' },
        },
      }];
    });
  }

  private planningInput(
    state: Readonly<GoalAgentStateV1>,
    snapshot: RegistrySnapshotRef,
    facts: readonly PluginObservationFact[],
    params: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
  ): PluginPlanningInput {
    return {
      goal: goalLease(state, snapshot), snapshot, facts, params, signal,
      budget: { remainingActions: state.budget.maxActions - state.budget.actions },
    };
  }

  private async observeKinds(
    snapshot: RegistrySnapshotRef,
    world: WorldStateView,
    kinds: readonly string[] | null,
    signal: AbortSignal,
  ): Promise<PluginObservationFact[]> {
    const entries = this.entries(snapshot, 'observation').filter(entry => entry.contribution.kind === 'observation'
      && (kinds === null || entry.contribution.factory.descriptor.factKinds.some(kind => kinds.includes(kind))));
    const observed = await Promise.all(entries.map(entry => entry.contribution.kind === 'observation'
      ? this.observeFactory(snapshot, entry, entry.contribution.factory, world, {}, signal)
      : null));
    return observed.filter((fact): fact is PluginObservationFact => fact !== null);
  }

  private async observeFactory(
    snapshot: RegistrySnapshotRef,
    entry: StagedContributionRecord,
    factory: PluginObservationProviderFactory,
    world: WorldStateView,
    params: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
  ): Promise<PluginObservationFact | null> {
    const provider = factory.create({
      scoped: createScopedHostContext(
        { version: this.hostApiVersion, buildId: snapshot.buildId },
        { pluginId: entry.ref.pluginId, pluginVersion: entry.ref.pluginVersion },
      ),
      identity: entry.ref,
      signal,
    });
    try {
      const limits = tuning().knowledgeQuery;
      const result = await provider.observe({
        params,
        signal,
        scope: {
          dimension: world.environment.dimension,
          anchor: { kind: 'bot_self' },
          radius: limits.defaultRadius,
        },
        budget: { timeoutMs: limits.timeoutMs, maxResults: limits.maxResultsPerFact },
      });
      if (result.status === 'fulfilled') return result.fact;
      if (result.status === 'timed_out' && result.partialFact) return result.partialFact;
      return null;
    } finally {
      provider.close();
    }
  }

  private findPredicate(snapshot: RegistrySnapshotRef, id: string) {
    return this.entries(snapshot, 'verification').flatMap(entry => entry.contribution.kind === 'verification' ? entry.contribution.predicates : [])
      .find(predicate => predicate.id === id);
  }

  private entry(snapshot: RegistrySnapshotRef, id: string): StagedContributionRecord | null {
    return this.record(snapshot).registry.byId.get(id) ?? null;
  }

  private entries(snapshot: RegistrySnapshotRef, kind: Parameters<typeof this.entriesForKind>[1]): readonly StagedContributionRecord[] {
    return this.entriesForKind(snapshot, kind);
  }

  private entriesForKind(snapshot: RegistrySnapshotRef, kind: import('../plugin-sdk/contributions.js').PluginContributionKind): readonly StagedContributionRecord[] {
    const record = this.record(snapshot);
    const disabled = new Set(record.registry.disabledIds);
    return (record.registry.byKind.get(kind) ?? []).flatMap(id => {
      const entry = record.registry.byId.get(id);
      return entry && !disabled.has(id) ? [entry] : [];
    });
  }

  private record(snapshot: RegistrySnapshotRef) {
    const set = this.slot.read();
    const record = set.active.generationId === snapshot.generationId ? set.active : set.drainingById.get(snapshot.generationId);
    if (!record || record.buildId !== snapshot.buildId || record.graphHash !== snapshot.graphHash) {
      throw new Error(`needs_rebind:generation_unavailable:${snapshot.generationId}`);
    }
    return record;
  }
}

function goalLease(state: Readonly<GoalAgentStateV1> | undefined, snapshot: RegistrySnapshotRef): PluginGoalLease {
  return Object.freeze({
    goalId: state?.rootGoal?.goalId ?? state?.requestId ?? 'catalog',
    sessionId: state?.sessionId ?? 'catalog',
    snapshot,
    ownerEpoch: state?.epoch ?? 0,
    operationEpoch: state?.plan.revision ?? 0,
    aborted: false,
  });
}

function planningParams(criteria: readonly GoalSuccessCriterion[], goalText: string, world: WorldStateView): Record<string, unknown> {
  const inventory = criteria.find(criterion => criterion.type === 'inventory');
  const entity = criteria.find(criterion => criterion.type === 'entity_dead');
  const reached = criteria.find(criterion => criterion.type === 'reached');
  const predicate = criteria.find(criterion => criterion.type === 'predicate');
  return {
    goalText,
    ...(inventory?.item ? { item: inventory.item, count: inventory.count ?? 1 } : {}),
    ...(entity ? { target: world.entities.find(value => entity.entityId ? String(value.id) === entity.entityId : value.name === entity.entityName) } : {}),
    ...(reached?.relativeTo === 'owner' && world.owner?.position ? { target: world.owner.position } : {}),
    ...(predicate?.args ?? {}),
  };
}

function behaviorParams(args: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const value = args?.behaviorParams;
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function normalizeSurface(value: string): string {
  return value.toLowerCase().replace(/[\s，。！？、；：,.!?;:'"“”‘’]+/g, '');
}

function pluginFactToWorldFact(fact: PluginObservationFact): WorldFact {
  return {
    providerId: fact.contribution.contributionId,
    version: fact.contribution.contributionVersion,
    observedAt: Date.parse(fact.observedAt),
    complete: fact.complete,
    truncated: fact.truncated,
    bounds: fact.observedBounds,
    value: fact.payload,
    evidenceRefs: fact.evidenceRefs.map(value => value.ref),
    pluginFact: fact,
  };
}

function linkedAbort(signal: AbortSignal | undefined): AbortController {
  const controller = new AbortController();
  if (signal?.aborted) controller.abort(signal.reason);
  else signal?.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  return controller;
}

function sameContribution(left: StagedContributionRecord['ref'], right: StagedContributionRecord['ref']): boolean {
  return left.pluginId === right.pluginId
    && left.pluginVersion === right.pluginVersion
    && left.contributionId === right.contributionId
    && left.contributionVersion === right.contributionVersion;
}

function projectGoalScopeBinding(
  entry: StagedContributionRecord,
  bindingId: string,
  scope: Readonly<Record<string, unknown>>,
  evidenceRefs: readonly string[],
  dimension: string,
): GoalScopeBinding {
  const region = isRegion(scope.region) ? scope.region : undefined;
  const position = firstPosition(scope.position, scope.ownerPosition, scope.target, scope.chest);
  const kind: GoalScopeBinding['kind'] = region
    ? 'region'
    : scope.chest !== undefined ? 'container'
      : scope.target !== undefined ? 'entity'
        : position ? 'self' : 'item';
  return Object.freeze({
    contribution: entry.ref,
    id: `${entry.ref.contributionId}:${bindingId}`,
    version: entry.ref.contributionVersion,
    kind,
    summary: `${entry.ref.contributionId} binding ${bindingId}`,
    dimension,
    ...(position ? { position } : {}),
    ...(region ? { region } : {}),
    mutationAllowed: Boolean(region),
    allowedAccess: Object.freeze(region ? ['observe', 'use', 'modify'] as const : ['observe', 'use'] as const),
    required: false,
    requiredPredicates: Object.freeze([]),
    evidenceRefs: Object.freeze([...new Set([
      ...evidenceRefs,
      `contribution:${entry.ref.contributionId}@${entry.ref.contributionVersion}`,
    ])]),
  });
}

function firstPosition(...values: unknown[]): { x: number; y: number; z: number } | undefined {
  for (const value of values) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const candidate = value as Record<string, unknown>;
    if ([candidate.x, candidate.y, candidate.z].every(Number.isFinite)) {
      return { x: Number(candidate.x), y: Number(candidate.y), z: Number(candidate.z) };
    }
    const nested = candidate.position;
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      const position = nested as Record<string, unknown>;
      if ([position.x, position.y, position.z].every(Number.isFinite)) {
        return { x: Number(position.x), y: Number(position.y), z: Number(position.z) };
      }
    }
  }
  return undefined;
}

function isRegion(value: unknown): value is import('../task/contracts/worldFact.js').FactRegion {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const region = value as Record<string, unknown>;
  return firstPosition(region.min) !== undefined && firstPosition(region.max) !== undefined;
}
