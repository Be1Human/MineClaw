/**
 * mineclaw.gathering · first-party domain plugin.
 * Gather-material closed loop: executor submits move-to + dig via body service;
 * predicate verifies the inventory fact; missing body service reported.
 */
import type { PluginFactory } from '../../../plugin-kernel/discovery.js';
import type { PluginContribution } from '../../../plugin-sdk/index.js';
import type { PluginCandidateProvider, PluginBindingProvider, PluginProgressProvider, PluginPlanningInput } from '../../../plugin-sdk/contracts/planning.js';
import type { PluginPredicateEvaluator } from '../../../plugin-sdk/contracts/verification.js';
import type { PluginBehaviorFactory, PluginBehaviorInstance } from '../../../plugin-sdk/contracts/execution.js';
import type { PluginResultProjection } from '../../../plugin-sdk/contracts/result.js';
import type { ContributionRef } from '../../../plugin-sdk/identity.js';

const PLUGIN_ID = 'mineclaw.gathering';
const SERVICE_BODY = 'body.submit';
const GOAL = 'mineclaw.gathering.goal.gather-material';
const CANDIDATE = 'mineclaw.gathering.planning.gather-candidates';
const PREDICATE = 'mineclaw.gathering.verification.gathered';
const PROGRESS = 'mineclaw.gathering.progress.gather';
const RESULT = 'mineclaw.gathering.result.gather';
const OPERATION = 'mineclaw.gathering.operation.gather-material';
const EXECUTOR = 'mineclaw.gathering.execution.gather-material';

function ref(id: string): ContributionRef {
  return { pluginId: PLUGIN_ID, pluginVersion: '1.0.0', contributionId: id, contributionVersion: '1.0.0' };
}

function inventorySlotCount(facts: readonly Readonly<Record<string, unknown>>[], item: string): number {
  for (const fact of facts) {
    const slots = (fact as { payload?: { slots?: Array<{ itemId?: string; count?: number }> } }).payload?.slots ?? [];
    const match = slots.find(slot => slot.itemId?.includes(item));
    if (match) return Number(match.count ?? 1);
  }
  return 0;
}

export function createMineclawGatheringPlugin(): PluginFactory {
  return {
    entryKey: `plugins/builtin/${PLUGIN_ID}`,
    create: (context): readonly PluginContribution[] => {
      const bodySubmit = (context.services ?? {})[SERVICE_BODY] as ((request: Record<string, unknown>) => Promise<Record<string, unknown>>) | undefined;

      const bindingProvider: PluginBindingProvider = {
        id: GOAL,
        list: async (input) => {
          const target = input.params?.target;
          if (!target) return { status: 'unavailable', bindings: [], reason: 'target_required' };
          return { status: 'complete', bindings: [{ bindingId: 'gather:site', scope: { target }, evidenceRefs: [], contribution: ref(GOAL) }] };
        },
      };

      const candidateProvider: PluginCandidateProvider = {
        id: CANDIDATE,
        list: async (input) => {
          const item = String(input.params?.item ?? '');
          const count = Number(input.params?.count ?? 1);
          if (!item) return { status: 'unavailable', candidates: [], reason: 'item_required' };
          return {
            status: 'complete',
            candidates: [{ candidateId: `gather:${item}`, operationContribution: ref(OPERATION), params: { item, count }, evidenceRefs: [], contribution: ref(CANDIDATE) }],
          };
        },
      };

      const progressProvider: PluginProgressProvider = {
        id: PROGRESS,
        assess: async (input) => {
          const item = String(input.params?.item ?? '');
          const count = Number(input.params?.count ?? 1);
          const have = inventorySlotCount(input.facts.map(fact => fact as unknown as Record<string, unknown>), item);
          return {
            status: 'complete',
            progress: { completed: Math.min(have, count), total: count, blocked: 0, truncated: false, evidenceRefs: [], contribution: ref(PROGRESS) },
          };
        },
      };

      const predicate: PluginPredicateEvaluator = {
        id: PREDICATE,
        version: '1.0.0',
        evaluate: async (input) => {
          const item = String(input.args?.item ?? '');
          const count = Number(input.args?.count ?? 1);
          const have = inventorySlotCount(input.facts, item);
          return { verdict: have >= count ? 'satisfied' : 'unknown', evidenceRefs: [], reason: have >= count ? undefined : 'inventory_insufficient', contribution: ref(PREDICATE) };
        },
      };

      const behaviorFactory: PluginBehaviorFactory = {
        id: EXECUTOR,
        version: '1.0.0',
        create: (lease): PluginBehaviorInstance => ({
          instanceId: `gather-${lease.goalId}`,
          contribution: ref(EXECUTOR),
          run: async (ctx) => {
            if (!bodySubmit) return { ok: false, cancelled: false, error: 'body_submit_service_missing' };
            const payload = ctx.facts[0]?.payload as { target?: Record<string, unknown>; item?: string } | undefined;
            const target = payload?.target;
            if (!target) return { ok: false, cancelled: false, error: 'target_required' };
            if (ctx.signal.aborted) return { ok: false, cancelled: true };
            const move = await bodySubmit({ action: 'minecraft-system:move-to', target });
            if ((move as { ok?: boolean }).ok === false) return { ok: false, cancelled: false, error: 'move_failed' };
            const dig = await bodySubmit({ action: 'minecraft-system:dig', target });
            return (dig as { ok?: boolean }).ok === false
              ? { ok: false, cancelled: false, error: 'dig_failed' }
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
            summary: input.evidence.verdict === 'completed' ? '采集完成。' : '采集中或目标不可达。',
            evidenceRefs: input.evidence.ledger.map(() => 'gather:1'),
            contribution: ref(RESULT),
          },
        }),
      };

      const target = {
        registryId: GOAL,
        goalKind: 'item' as const,
        aliases: ['采集', '收集', '挖', '砍', 'gather', 'collect', 'mine'],
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
