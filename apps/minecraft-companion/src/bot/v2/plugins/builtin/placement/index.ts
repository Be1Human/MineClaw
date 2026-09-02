/**
 * mineclaw.placement · first-party domain plugin.
 * Relative placement closed loop; candidate from block-fact/params, executor
 * submits place-block via body service.
 */
import type { PluginFactory } from '../../../plugin-kernel/discovery.js';
import type { PluginContribution } from '../../../plugin-sdk/index.js';
import type { PluginCandidateProvider, PluginBindingProvider, PluginProgressProvider } from '../../../plugin-sdk/contracts/planning.js';
import type { PluginPredicateEvaluator } from '../../../plugin-sdk/contracts/verification.js';
import type { PluginBehaviorFactory, PluginBehaviorInstance } from '../../../plugin-sdk/contracts/execution.js';
import type { PluginResultProjection } from '../../../plugin-sdk/contracts/result.js';
import type { ContributionRef } from '../../../plugin-sdk/identity.js';

const PLUGIN_ID = 'mineclaw.placement';
const SERVICE_BODY = 'body.submit';
const GOAL = 'mineclaw.placement.goal.place-relative';
const CANDIDATE = 'mineclaw.placement.planning.place-candidates';
const PREDICATE = 'mineclaw.placement.verification.placed';
const PROGRESS = 'mineclaw.placement.progress.place';
const RESULT = 'mineclaw.placement.result.place';
const OPERATION = 'mineclaw.placement.operation.place-relative';
const EXECUTOR = 'mineclaw.placement.execution.place-relative';

function ref(id: string): ContributionRef {
  return { pluginId: PLUGIN_ID, pluginVersion: '1.0.0', contributionId: id, contributionVersion: '1.0.0' };
}

export function createMineclawPlacementPlugin(): PluginFactory {
  return {
    entryKey: `plugins/builtin/${PLUGIN_ID}`,
    create: (context): readonly PluginContribution[] => {
      const bodySubmit = (context.services ?? {})[SERVICE_BODY] as ((request: Record<string, unknown>) => Promise<Record<string, unknown>>) | undefined;

      const bindingProvider: PluginBindingProvider = {
        id: GOAL,
        list: async (input) => {
          const position = input.params?.position;
          const relativeTo = input.params?.relativeTo;
          if (!position && !relativeTo) return { status: 'unavailable', bindings: [], reason: 'position_required' };
          return { status: 'complete', bindings: [{ bindingId: 'place:target', scope: { position, relativeTo }, evidenceRefs: [], contribution: ref(GOAL) }] };
        },
      };

      const candidateProvider: PluginCandidateProvider = {
        id: CANDIDATE,
        list: async (input) => {
          const position = input.params?.position;
          if (!position) return { status: 'unavailable', candidates: [], reason: 'position_required' };
          return { status: 'complete', candidates: [{ candidateId: 'place:block', operationContribution: ref(OPERATION), params: { position }, evidenceRefs: [], contribution: ref(CANDIDATE) }] };
        },
      };

      const progressProvider: PluginProgressProvider = {
        id: PROGRESS,
        assess: async () => ({ status: 'complete', progress: { completed: 0, total: 1, blocked: 0, truncated: false, evidenceRefs: [], contribution: ref(PROGRESS) } }),
      };

      const predicate: PluginPredicateEvaluator = {
        id: PREDICATE,
        version: '1.0.0',
        evaluate: async (input) => {
          const confirmed = (input.evidence?.blocked as boolean | undefined) === true;
          return { verdict: confirmed ? 'satisfied' : 'unknown', evidenceRefs: [], reason: confirmed ? undefined : 'world_not_verified', contribution: ref(PREDICATE) };
        },
      };

      const behaviorFactory: PluginBehaviorFactory = {
        id: EXECUTOR,
        version: '1.0.0',
        create: (lease): PluginBehaviorInstance => ({
          instanceId: `place-${lease.goalId}`,
          contribution: ref(EXECUTOR),
          run: async (ctx) => {
            if (!bodySubmit) return { ok: false, cancelled: false, error: 'body_submit_service_missing' };
            const position = (ctx.facts[0]?.payload as { position?: Record<string, unknown> } | undefined)?.position;
            if (!position) return { ok: false, cancelled: false, error: 'position_required' };
            if (ctx.signal.aborted) return { ok: false, cancelled: true };
            const receipt = await bodySubmit({ action: 'minecraft-system:place-block', position });
            return (receipt as { ok?: boolean }).ok === false
              ? { ok: false, cancelled: false, error: 'place_failed' }
              : { ok: true, cancelled: false };
          },
          halt: async () => undefined,
          close: async () => undefined,
          settled: false,
        }),
      };

      const projection: PluginResultProjection = {
        id: RESULT,
        version: '1.0.0',
        project: async (input) => ({
          status: 'projected',
          output: {
            presentation: { verdict: input.evidence.verdict },
            audience: 'owner',
            summary: input.evidence.verdict === 'completed' ? '放置完成。' : '放置中或位置未绑定。',
            evidenceRefs: input.evidence.ledger.map(() => 'place:1'),
            contribution: ref(RESULT),
          },
        }),
      };

      const target = {
        registryId: GOAL,
        goalKind: 'location' as const,
        aliases: ['放置', '放个', '摆', 'place'],
        successCriteria: [{ type: 'predicate' as const, predicate: PREDICATE }],
      };

      return [
        { kind: 'goal', id: GOAL, version: '1.0.0', target, bindingProvider },
        { kind: 'planning', id: CANDIDATE, version: '1.0.0', candidateProvider },
        { kind: 'verification', id: PREDICATE, version: '1.0.0', predicates: [predicate] },
        {
          kind: 'execution',
          id: EXECUTOR,
          version: '1.0.0',
          operation: {
            operationId: OPERATION,
            goalContributionId: GOAL,
            bindingContributionId: GOAL,
            factKinds: ['nearby_blocks'],
            candidateContributionId: CANDIDATE,
            predicateContributionId: PREDICATE,
            progressContributionId: PROGRESS,
            resultContributionId: RESULT,
            cancellable: true,
          },
          behaviorFactory,
        },
        { kind: 'planning', id: PROGRESS, version: '1.0.0', candidateProvider, progressProvider },
        { kind: 'result', id: RESULT, version: '1.0.0', projection },
      ];
    },
  };
}
