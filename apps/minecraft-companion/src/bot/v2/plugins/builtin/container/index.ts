/**
 * mineclaw.container · first-party domain plugin.
 * Chest access loop (deposit/withdraw) via storage-system atomics; candidates
 * target a declared chest; missing body service reported explicitly.
 */
import type { PluginFactory } from '../../../plugin-kernel/discovery.js';
import type { PluginContribution } from '../../../plugin-sdk/index.js';
import type { PluginCandidateProvider, PluginBindingProvider, PluginProgressProvider } from '../../../plugin-sdk/contracts/planning.js';
import type { PluginPredicateEvaluator } from '../../../plugin-sdk/contracts/verification.js';
import type { PluginBehaviorFactory, PluginBehaviorInstance } from '../../../plugin-sdk/contracts/execution.js';
import type { PluginResultProjection } from '../../../plugin-sdk/contracts/result.js';
import type { ContributionRef } from '../../../plugin-sdk/identity.js';

const PLUGIN_ID = 'mineclaw.container';
const SERVICE_BODY = 'body.submit';
const GOAL = 'mineclaw.container.goal.chest-access';
const CANDIDATE = 'mineclaw.container.planning.chest-candidates';
const PREDICATE = 'mineclaw.container.verification.chest-access-done';
const PROGRESS = 'mineclaw.container.progress.chest';
const RESULT = 'mineclaw.container.result.chest';
const OPERATION = 'mineclaw.container.operation.chest-access';
const EXECUTOR = 'mineclaw.container.execution.chest-access';

function ref(id: string): ContributionRef {
  return { pluginId: PLUGIN_ID, pluginVersion: '1.0.0', contributionId: id, contributionVersion: '1.0.0' };
}

export function createMineclawContainerPlugin(): PluginFactory {
  return {
    entryKey: `plugins/builtin/${PLUGIN_ID}`,
    create: (context): readonly PluginContribution[] => {
      const bodySubmit = (context.services ?? {})[SERVICE_BODY] as ((request: Record<string, unknown>) => Promise<Record<string, unknown>>) | undefined;

      const bindingProvider: PluginBindingProvider = {
        id: GOAL,
        list: async (input) => {
          const chest = input.params?.chest;
          if (!chest) return { status: 'unavailable', bindings: [], reason: 'chest_required' };
          return { status: 'complete', bindings: [{ bindingId: 'chest:1', scope: { chest }, evidenceRefs: [], contribution: ref(GOAL) }] };
        },
      };

      const candidateProvider: PluginCandidateProvider = {
        id: CANDIDATE,
        list: async (input) => {
          const chest = input.params?.chest;
          if (!chest) return { status: 'unavailable', candidates: [], reason: 'chest_required' };
          return { status: 'complete', candidates: [{ candidateId: 'chest:transfer', operationContribution: ref(OPERATION), params: { chest }, evidenceRefs: [], contribution: ref(CANDIDATE) }] };
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
          const done = (input.evidence?.tossed as boolean | undefined) === true || (input.evidence?.transferred as boolean | undefined) === true;
          return { verdict: done ? 'satisfied' : 'unknown', evidenceRefs: [], reason: done ? undefined : 'transfer_not_verified', contribution: ref(PREDICATE) };
        },
      };

      const behaviorFactory: PluginBehaviorFactory = {
        id: EXECUTOR,
        version: '1.0.0',
        create: (lease): PluginBehaviorInstance => ({
          instanceId: `chest-${lease.goalId}`,
          contribution: ref(EXECUTOR),
          run: async (ctx) => {
            if (!bodySubmit) return { ok: false, cancelled: false, error: 'body_submit_service_missing' };
            const chest = (ctx.facts[0]?.payload as { chest?: Record<string, unknown> } | undefined)?.chest;
            if (!chest) return { ok: false, cancelled: false, error: 'chest_required' };
            if (ctx.signal.aborted) return { ok: false, cancelled: true };
            const receipt = await bodySubmit({ action: 'storage-system:transfer_chest', chest });
            return (receipt as { ok?: boolean }).ok === false
              ? { ok: false, cancelled: false, error: 'transfer_failed' }
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
            summary: input.evidence.verdict === 'completed' ? '存取完成。' : '存取中或箱子未绑定。',
            evidenceRefs: input.evidence.ledger.map(() => 'chest:1'),
            contribution: ref(RESULT),
          },
        }),
      };

      const target = {
        registryId: GOAL,
        goalKind: 'item' as const,
        aliases: ['存取', '放箱子', '拿箱子', '存东西', '取东西'],
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
            factKinds: ['inventory'],
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
