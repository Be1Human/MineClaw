/**
 * mineclaw.survival · basic survival loop (eat/sleep via body service).
 */
import type { PluginFactory } from '../../../plugin-kernel/discovery.js';
import type { PluginContribution } from '../../../plugin-sdk/index.js';
import type { PluginCandidateProvider, PluginBindingProvider, PluginProgressProvider } from '../../../plugin-sdk/contracts/planning.js';
import type { PluginPredicateEvaluator } from '../../../plugin-sdk/contracts/verification.js';
import type { PluginBehaviorFactory, PluginBehaviorInstance } from '../../../plugin-sdk/contracts/execution.js';
import type { PluginResultProjection } from '../../../plugin-sdk/contracts/result.js';
import type { ContributionRef } from '../../../plugin-sdk/identity.js';

const PLUGIN_ID = 'mineclaw.survival';
const SERVICE_BODY = 'body.submit';
const GOAL = 'mineclaw.survival.goal.survive';
const CANDIDATE = 'mineclaw.survival.planning.survive-candidates';
const PREDICATE = 'mineclaw.survival.verification.survived';
const PROGRESS = 'mineclaw.survival.progress.survive';
const RESULT = 'mineclaw.survival.result.survive';
const OPERATION = 'mineclaw.survival.operation.survive';
const EXECUTOR = 'mineclaw.survival.execution.survive';

function ref(id: string): ContributionRef {
  return { pluginId: PLUGIN_ID, pluginVersion: '1.0.0', contributionId: id, contributionVersion: '1.0.0' };
}

export function createMineclawSurvivalPlugin(): PluginFactory {
  return {
    entryKey: `plugins/builtin/${PLUGIN_ID}`,
    create: (context): readonly PluginContribution[] => {
      const bodySubmit = (context.services ?? {})[SERVICE_BODY] as ((request: Record<string, unknown>) => Promise<Record<string, unknown>>) | undefined;

      const bindingProvider: PluginBindingProvider = {
        id: GOAL,
        list: async (input) => {
          const action = String(input.params?.action ?? '');
          if (!action) return { status: 'unavailable', bindings: [], reason: 'action_required' };
          return { status: 'complete', bindings: [{ bindingId: `survive:${action}`, scope: { action }, evidenceRefs: [], contribution: ref(GOAL) }] };
        },
      };

      const candidateProvider: PluginCandidateProvider = {
        id: CANDIDATE,
        list: async (input) => {
          const action = String(input.params?.action ?? '');
          if (!action) return { status: 'unavailable', candidates: [], reason: 'action_required' };
          return { status: 'complete', candidates: [{ candidateId: `survive:${action}`, operationContribution: ref(OPERATION), params: { action }, evidenceRefs: [], contribution: ref(CANDIDATE) }] };
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
          const done = (input.evidence?.restored as boolean | undefined) === true;
          return { verdict: done ? 'satisfied' : 'unknown', evidenceRefs: [], reason: done ? undefined : 'restore_unverified', contribution: ref(PREDICATE) };
        },
      };

      const behaviorFactory: PluginBehaviorFactory = {
        id: EXECUTOR,
        version: '1.0.0',
        create: (lease): PluginBehaviorInstance => ({
          instanceId: `survive-${lease.goalId}`,
          contribution: ref(EXECUTOR),
          run: async (ctx) => {
            if (!bodySubmit) return { ok: false, cancelled: false, error: 'body_submit_service_missing' };
            const action = String((ctx.facts[0]?.payload as { action?: string } | undefined)?.action ?? '');
            if (!action) return { ok: false, cancelled: false, error: 'action_required' };
            if (ctx.signal.aborted) return { ok: false, cancelled: true };
            const receipt = await bodySubmit({ action: `minecraft-system:${action === 'sleep' ? 'sleep' : 'use_item'}` });            return (receipt as { ok?: boolean }).ok === false
              ? { ok: false, cancelled: false, error: 'survive_failed' }
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
            summary: input.evidence.verdict === 'completed' ? '状态已恢复。' : '恢复中。',
            evidenceRefs: input.evidence.ledger.map(() => 'survive:1'),
            contribution: ref(RESULT),
          },
        }),
      };

      const target = {
        registryId: GOAL,
        goalKind: 'item' as const,
        aliases: ['睡觉', '吃东西', '恢复', 'eat', 'sleep'],
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
            factKinds: ['self_location'],
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
