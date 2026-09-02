/**
 * FEAT-CROSS-28 · GoalAgent QueryRunner (design §5.4).
 * A read-only runner independent of the task round loop: no action tools, no
 * TaskRuntime, no LLM capability_search for provider selection. Provider choice
 * is deterministic (FactKind → catalog → plan), bounded by tuning budgets, and
 * fail-closed on invalid input / unregistered / timeout / cancel. `answer_player`
 * never creates or resumes tasks; cancelled results stay audit-only.
 */
import { tuning } from '../infra/tuning.js';
import type {
  KnowledgeQueryV1,
  KnowledgeAnswerV1,
  KnowledgeFact,
  KnowledgeAnswerOutcome,
} from './goalAgentPort/knowledgeQueryContracts.js';
import { replyKeyFor } from './goalAgentPort/knowledgeQueryContracts.js';
import type {
  PluginObservationProvider,
  PluginObservationResult,
  PluginObservationProviderFactory,
} from '../plugin-sdk/contracts/observation.js';
import type { FactKind } from '../plugin-sdk/contracts/observation.js';

/** The deterministic catalog projection a runner may consult (never the live product registries). */
export interface ObservationCatalogPort {
  readonly resolveProvider: (factKind: FactKind) => readonly PluginObservationProviderFactory[];
}

export interface ResolvedObservationPlan {
  readonly steps: readonly { readonly factKind: FactKind; readonly provider: PluginObservationProviderFactory }[];
  readonly omitted: readonly { readonly factKind: FactKind; readonly reason: string }[];
}

export class ObservationResolver {
  constructor(private readonly catalog: ObservationCatalogPort) {}

  resolve(query: KnowledgeQueryV1): ResolvedObservationPlan {
    const budget = tuning().knowledgeQuery.maxFanOut;
    const steps: { factKind: FactKind; provider: PluginObservationProviderFactory }[] = [];
    const omitted: { factKind: FactKind; reason: string }[] = [];
    for (const factKind of query.factKinds) {
      const providers = this.catalog.resolveProvider(factKind);
      if (providers.length === 0) {
        omitted.push({ factKind, reason: 'unsupported_fact_kind' });
        continue;
      }
      if (steps.length >= budget) {
        omitted.push({ factKind, reason: 'fan_out_budget' });
        continue;
      }
      steps.push({ factKind, provider: providers[0]! });
    }
    return { steps: Object.freeze(steps), omitted: Object.freeze(omitted) };
  }
}

export class KnowledgeAnswerValidator {
  validate(query: KnowledgeQueryV1, plan: ResolvedObservationPlan, results: readonly { readonly factKind: FactKind; readonly outcome: PluginObservationResult }[], aborted: boolean): KnowledgeAnswerV1 {
    const now = new Date().toISOString();
    const freshMax = tuning().knowledgeQuery.maxFreshnessMs;
    if (aborted) {
      return this.terminal(query, 'cancelled', now, [], 'not_applicable', 'query_cancelled');
    }
    const unsupported = query.factKinds.filter(kind => plan.omitted.some(o => o.factKind === kind && o.reason === 'unsupported_fact_kind'));
    if (unsupported.length === query.factKinds.length) {
      return this.terminal(query, 'unsupported', now, [], 'not_applicable', `unsupported_fact_kind:${unsupported.join(',')}`);
    }
    const facts: KnowledgeFact[] = [];
    let partial = false;
    let unavailableReason = '';
    for (const factKind of query.factKinds) {
      const result = results.find(r => r.factKind === factKind);
      if (!result) continue;
      if (result.outcome.status === 'fulfilled') {
        facts.push({
          factKind,
          payload: result.outcome.fact.payload,
          observedAt: result.outcome.fact.observedAt,
          requestedBounds: result.outcome.fact.requestedBounds,
          observedBounds: result.outcome.fact.observedBounds,
          complete: result.outcome.fact.complete,
          truncated: result.outcome.fact.truncated,
          evidenceRefs: result.outcome.fact.evidenceRefs,
        });
        if (!result.outcome.fact.complete || result.outcome.fact.truncated) partial = true;
      } else if (result.outcome.status === 'unavailable') {
        unavailableReason ||= result.outcome.reason;
      } else if (result.outcome.status === 'timed_out') {
        unavailableReason ||= 'provider_timeout';
      } else if (result.outcome.status === 'cancelled') {
        return this.terminal(query, 'cancelled', now, facts, 'partial', 'provider_cancelled');
      }
    }
    if (facts.length === 0 && unavailableReason) {
      return this.terminal(query, 'unavailable', now, [], 'not_applicable', unavailableReason);
    }
    if (facts.length === 0 && unsupported.length > 0) {
      return this.terminal(query, 'unsupported', now, [], 'not_applicable', `unsupported_fact_kind:${unsupported.join(',')}`);
    }
    if (facts.length === 0) {
      return this.terminal(query, 'not_found', now, [], 'complete', 'no_facts_in_scope');
    }
    const oldest = Math.min(...facts.map(fact => Date.parse(fact.observedAt)).filter(Number.isFinite));
    const fresh = Number.isFinite(oldest) && now !== undefined
      && Date.now() - oldest <= freshMax;
    return this.terminal(query, 'answered', now, facts, partial ? 'partial' : 'complete', undefined, fresh);
  }

  private terminal(
    query: KnowledgeQueryV1,
    outcome: KnowledgeAnswerOutcome,
    now: string,
    facts: KnowledgeFact[],
    completeness: KnowledgeAnswerV1['completeness'],
    reason: string | undefined,
    fresh = true,
  ): KnowledgeAnswerV1 {
    return Object.freeze({
      schemaVersion: 'mineclaw.knowledge-answer/v1',
      kind: 'knowledge_answer',
      requestId: query.requestId,
      correlationId: query.correlationId,
      outcome,
      facts: Object.freeze(facts),
      observedAt: now,
      freshness: Object.freeze({ fresh, observedAt: now, ...(fresh ? {} : { staleReason: 'older_than_freshness_window' }) }),
      coverage: Object.freeze({ dimension: query.scope.dimension ?? 'overworld', requested: Object.freeze({ radius: query.scope.radius ?? tuning().knowledgeQuery.defaultRadius }), covered: Object.freeze({}), loaded: false }),
      completeness,
      evidenceRefs: Object.freeze(facts.flatMap(fact => fact.evidenceRefs)),
      ...(reason !== undefined ? { reason } : {}),
      replyKey: replyKeyFor(query),
      registryGeneration: query.registryGeneration,
    });
  }
}

export class QueryRunner {
  private readonly resolver: ObservationResolver;
  private readonly validator: KnowledgeAnswerValidator;

  constructor(catalog: ObservationCatalogPort, resolver = new ObservationResolver(catalog), validator = new KnowledgeAnswerValidator()) {
    this.resolver = resolver;
    this.validator = validator;
  }

  async run(query: KnowledgeQueryV1, abort: AbortSignal): Promise<KnowledgeAnswerV1> {
    const plan = this.resolver.resolve(query);
    const results: { factKind: FactKind; outcome: PluginObservationResult }[] = [];
    const timeoutMs = tuning().knowledgeQuery.timeoutMs;
    const deadline = Date.now() + timeoutMs;
    for (const step of plan.steps) {
      if (abort.aborted || Date.now() >= deadline) {
        return this.validator.validate(query, plan, results, abort.aborted);
      }
      const signal = AbortSignal.any([abort, AbortSignal.timeout(Math.max(1, deadline - Date.now()))]);
      const provider = step.provider.create({
        scoped: { host: { version: '2.0.0', buildId: 'runtime' }, plugin: { pluginId: step.provider.id.split('.')[0] ?? 'unknown', pluginVersion: '1.0.0' }, resources: { track: () => undefined, untrack: () => undefined }, activationGate: { open: true, whenOpen: async () => undefined } },
        identity: step.provider.id.startsWith('mineclaw.') ? { pluginId: step.provider.id.split('.')[0]!, pluginVersion: '1.0.0', contributionId: step.provider.id, contributionVersion: '1.0.0' } : { pluginId: 'unknown', pluginVersion: '1.0.0', contributionId: step.provider.id, contributionVersion: '1.0.0' },
        signal,
      });
      const outcome = await provider.observe({
        params: {},
        signal,
        scope: { radius: query.scope.radius ?? tuning().knowledgeQuery.defaultRadius },
        budget: { timeoutMs: Math.max(1, deadline - Date.now()), maxResults: tuning().knowledgeQuery.maxResultsPerFact },
      });
      provider.close();
      results.push({ factKind: step.factKind, outcome });
    }
    return this.validator.validate(query, plan, results, abort.aborted);
  }
}
