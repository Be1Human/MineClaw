/**
 * mineclaw.delivery · first-party domain plugin.
 * Deliver-to-owner loop: candidates from the owner-context position, executor
 * approaches and tosses via body service; missing service reported explicitly.
 */
import type { PluginFactory } from '../../../plugin-kernel/discovery.js';
import type { PluginContribution } from '../../../plugin-sdk/index.js';
import type { PluginCandidateProvider, PluginBindingProvider, PluginProgressProvider } from '../../../plugin-sdk/contracts/planning.js';
import type { PluginPredicateEvaluator } from '../../../plugin-sdk/contracts/verification.js';
import type { PluginBehaviorFactory, PluginBehaviorInstance } from '../../../plugin-sdk/contracts/execution.js';
import type { PluginResultProjection } from '../../../plugin-sdk/contracts/result.js';
import type { ContributionRef } from '../../../plugin-sdk/identity.js';

const PLUGIN_ID = 'mineclaw.delivery';
const SERVICE_BODY = 'body.submit';
const GOAL = 'mineclaw.delivery.goal.deliver-to-owner';
const CANDIDATE = 'mineclaw.delivery.planning.deliver-candidates';
const PREDICATE = 'mineclaw.delivery.verification.delivered';
const PROGRESS = 'mineclaw.delivery.progress.deliver';
const RESULT = 'mineclaw.delivery.result.deliver';
const OPERATION = 'mineclaw.delivery.operation.deliver-to-owner';
const EXECUTOR = 'mineclaw.delivery.execution.deliver-to-owner';

function ref(id: string): ContributionRef {
  return { pluginId: PLUGIN_ID, pluginVersion: '1.0.0', contributionId: id, contributionVersion: '1.0.0' };
}

function ownerPositions(facts: readonly Readonly<Record<string, unknown>>[]): Array<Record<string, unknown>> {
  return facts.flatMap(fact => {
    const payload = (fact as { payload?: { ownerPosition?: Record<string, unknown> } }).payload;
    return payload?.ownerPosition ? [payload.ownerPosition] : [];
  });
}

function asRecords(facts: readonly unknown[]): readonly Readonly<Record<string, unknown>>[] {
  return facts as unknown as Readonly<Record<string, unknown>>[];
}

export function createMineclawDeliveryPlugin(): PluginFactory {
  return {
    entryKey: `plugins/builtin/${PLUGIN_ID}`,
    create: (context): readonly PluginContribution[] => {
      const bodySubmit = (context.services ?? {})[SERVICE_BODY] as ((request: Record<string, unknown>) => Promise<Record<string, unknown>>) | undefined;

      const bindingProvider: PluginBindingProvider = {
        id: GOAL,
        list: async (input) => {
          const positions = ownerPositions(asRecords(input.facts));
          if (positions.length === 0) return { status: 'unavailable', bindings: [], reason: 'owner_location_unavailable' };
          return { status: 'complete', bindings: [{ bindingId: 'deliver:owner', scope: { ownerPosition: positions[0]! }, evidenceRefs: ['owner-context:1'], contribution: ref(GOAL) }] };
        },
      };

      const candidateProvider: PluginCandidateProvider = {
        id: CANDIDATE,
        list: async (input) => {
          const positions = ownerPositions(asRecords(input.facts));
          if (positions.length === 0) return { status: 'unavailable', candidates: [], reason: 'owner_location_unavailable' };
          return { status: 'complete', candidates: [{ candidateId: 'deliver:toss', operationContribution: ref(OPERATION), params: { target: positions[0]! }, evidenceRefs: [], contribution: ref(CANDIDATE) }] };
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
          const tossed = (input.evidence?.tossed as boolean | undefined) === true;
          return { verdict: tossed ? 'satisfied' : 'unknown', evidenceRefs: [], reason: tossed ? undefined : 'toss_not_verified', contribution: ref(PREDICATE) };
        },
      };

      const behaviorFactory: PluginBehaviorFactory = {
        id: EXECUTOR,
        version: '1.0.0',
        create: (lease): PluginBehaviorInstance => ({
          instanceId: `deliver-${lease.goalId}`,
          contribution: ref(EXECUTOR),
          run: async (ctx) => {
            if (!bodySubmit) return { ok: false, cancelled: false, error: 'body_submit_service_missing' };
            const target = (ctx.facts[0]?.payload as { ownerPosition?: Record<string, unknown> } | undefined)?.ownerPosition;
            if (!target) return { ok: false, cancelled: false, error: 'owner_location_unavailable' };
            if (ctx.signal.aborted) return { ok: false, cancelled: true };
            const move = await bodySubmit({ action: 'minecraft-system:move-to', target });
            if ((move as { ok?: boolean }).ok === false) return { ok: false, cancelled: false, error: 'move_failed' };
            const toss = await bodySubmit({ action: 'minecraft-system:toss', target });
            return (toss as { ok?: boolean }).ok === false
              ? { ok: false, cancelled: false, error: 'toss_failed' }
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
            summary: input.evidence.verdict === 'completed' ? '已交付给主人。' : '交付中或主人不可达。',
            evidenceRefs: input.evidence.ledger.map(() => 'deliver:1'),
            contribution: ref(RESULT),
          },
        }),
      };

      const target = {
        registryId: GOAL,
        goalKind: 'item' as const,
        aliases: ['交给', '送给你', '给你', '交给你', 'deliver'],
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
            factKinds: ['owner_location'],
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
