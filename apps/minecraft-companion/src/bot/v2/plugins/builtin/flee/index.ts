/**
 * mineclaw.flee · escape loop (move to safe distance from the threat anchor).
 */
import type { PluginFactory } from '../../../plugin-kernel/discovery.js';
import type { PluginContribution } from '../../../plugin-sdk/index.js';
import type { PluginCandidateProvider, PluginBindingProvider, PluginProgressProvider } from '../../../plugin-sdk/contracts/planning.js';
import type { PluginPredicateEvaluator } from '../../../plugin-sdk/contracts/verification.js';
import type { PluginBehaviorFactory, PluginBehaviorInstance } from '../../../plugin-sdk/contracts/execution.js';
import type { PluginResultProjection } from '../../../plugin-sdk/contracts/result.js';
import type { ContributionRef } from '../../../plugin-sdk/identity.js';

const PLUGIN_ID = 'mineclaw.flee';
const SERVICE_BODY = 'body.submit';
const GOAL = 'mineclaw.flee.goal.flee-threat';
const CANDIDATE = 'mineclaw.flee.planning.flee-candidates';
const PREDICATE = 'mineclaw.flee.verification.fled';
const PROGRESS = 'mineclaw.flee.progress.flee';
const RESULT = 'mineclaw.flee.result.flee';
const OPERATION = 'mineclaw.flee.operation.flee-threat';
const EXECUTOR = 'mineclaw.flee.execution.flee-threat';
const SAFE_DISTANCE = 12;

function ref(id: string): ContributionRef {
  return { pluginId: PLUGIN_ID, pluginVersion: '1.0.0', contributionId: id, contributionVersion: '1.0.0' };
}

export function createMineclawFleePlugin(): PluginFactory {
  return {
    entryKey: `plugins/builtin/${PLUGIN_ID}`,
    create: (context): readonly PluginContribution[] => {
      const bodySubmit = (context.services ?? {})[SERVICE_BODY] as ((request: Record<string, unknown>) => Promise<Record<string, unknown>>) | undefined;

      const bindingProvider: PluginBindingProvider = {
        id: GOAL,
        list: async (input) => {
          const threat = input.params?.threat;
          if (!threat) return { status: 'unavailable', bindings: [], reason: 'threat_required' };
          return { status: 'complete', bindings: [{ bindingId: 'flee:away', scope: { threat }, evidenceRefs: [], contribution: ref(GOAL) }] };
        },
      };

      const candidateProvider: PluginCandidateProvider = {
        id: CANDIDATE,
        list: async (input) => {
          const threat = input.params?.threat;
          if (!threat) return { status: 'unavailable', candidates: [], reason: 'threat_required' };
          const position = input.facts.length > 0
            ? (input.facts[0]!.payload as { position?: Record<string, unknown> }).position ?? { x: 0, y: 64, z: 0 }
            : { x: 0, y: 64, z: 0 };
          return {
            status: 'complete',
            candidates: [{ candidateId: 'flee:retreat', operationContribution: ref(OPERATION), params: { threat, from: position }, evidenceRefs: [], contribution: ref(CANDIDATE) }],
          };
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
          const safe = (input.evidence?.safe as boolean | undefined) === true;
          return { verdict: safe ? 'satisfied' : 'unknown', evidenceRefs: [], reason: safe ? undefined : 'distance_unverified', contribution: ref(PREDICATE) };
        },
      };

      const behaviorFactory: PluginBehaviorFactory = {
        id: EXECUTOR,
        version: '1.0.0',
        create: (lease): PluginBehaviorInstance => ({
          instanceId: `flee-${lease.goalId}`,
          contribution: ref(EXECUTOR),
          run: async (ctx) => {
            if (!bodySubmit) return { ok: false, cancelled: false, error: 'body_submit_service_missing' };
            const threat = (ctx.facts[0]?.payload as { threat?: Record<string, unknown> } | undefined)?.threat;
            if (!threat) return { ok: false, cancelled: false, error: 'threat_required' };
            if (ctx.signal.aborted) return { ok: false, cancelled: true };
            const receipt = await bodySubmit({ action: 'minecraft-system:move-to', target: { away: threat, safeDistance: SAFE_DISTANCE } });
            return (receipt as { ok?: boolean }).ok === false
              ? { ok: false, cancelled: false, error: 'retreat_failed' }
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
            summary: input.evidence.verdict === 'completed' ? '已撤离到安全距离。' : '撤离中。',
            evidenceRefs: input.evidence.ledger.map(() => 'flee:1'),
            contribution: ref(RESULT),
          },
        }),
      };

      const target = {
        registryId: GOAL,
        goalKind: 'location' as const,
        aliases: ['逃跑', '撤退', '躲开', 'flee'],
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
