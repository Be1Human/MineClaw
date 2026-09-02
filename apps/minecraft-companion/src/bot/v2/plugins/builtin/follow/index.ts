/**
 * mineclaw.follow · first-party domain plugin.
 * Follow-owner closed loop: binding/candidate from the owner-context fact,
 * executor submits move-to atomic through the body submission service (missing
 * service reported explicitly).
 */
import type { PluginFactory } from '../../../plugin-kernel/discovery.js';
import type { PluginContribution } from '../../../plugin-sdk/index.js';
import type {
  PluginCandidateProvider,
  PluginProgressProvider,
  PluginBindingProvider,
  PluginPlanningInput,
} from '../../../plugin-sdk/contracts/planning.js';
import type { PluginPredicateEvaluator } from '../../../plugin-sdk/contracts/verification.js';
import type { PluginBehaviorFactory, PluginBehaviorInstance } from '../../../plugin-sdk/contracts/execution.js';
import type { PluginResultProjection } from '../../../plugin-sdk/contracts/result.js';
import type { ContributionRef } from '../../../plugin-sdk/identity.js';

const PLUGIN_ID = 'mineclaw.follow';
const SERVICE_BODY = 'body.submit';
const FOLLOW_GOAL = 'mineclaw.follow.goal.follow-owner';
const FOLLOW_CANDIDATE = 'mineclaw.follow.planning.follow-candidates';
const FOLLOW_PREDICATE = 'mineclaw.follow.verification.follow-satisfied';
const FOLLOW_PROGRESS = 'mineclaw.follow.progress.follow';
const FOLLOW_RESULT = 'mineclaw.follow.result.follow';
const FOLLOW_OPERATION = 'mineclaw.follow.operation.follow-owner';
const FOLLOW_EXECUTOR = 'mineclaw.follow.execution.follow-owner';

const FOLLOW_RADIUS = 3;

function ref(id: string): ContributionRef {
  return { pluginId: PLUGIN_ID, pluginVersion: '1.0.0', contributionId: id, contributionVersion: '1.0.0' };
}

function ownerPositions(input: PluginPlanningInput): Array<Record<string, unknown>> {
  const positions: Array<Record<string, unknown>> = [];
  for (const fact of input.facts) {
    if (fact.factKind === 'owner_location') {
      const payload = fact.payload as { ownerPosition?: { x: number; y: number; z: number } };
      if (payload.ownerPosition) positions.push(payload.ownerPosition as unknown as Record<string, unknown>);
    }
  }
  return positions;
}

export function createMineclawFollowPlugin(): PluginFactory {
  return {
    entryKey: `plugins/builtin/${PLUGIN_ID}`,
    create: (context): readonly PluginContribution[] => {
      const bodySubmit = (context.services ?? {})[SERVICE_BODY] as ((request: Record<string, unknown>) => Promise<Record<string, unknown>>) | undefined;

      const bindingProvider: PluginBindingProvider = {
        id: FOLLOW_GOAL,
        list: async (input) => {
          const positions = ownerPositions(input);
          if (positions.length === 0) return { status: 'unavailable', bindings: [], reason: 'owner_location_unavailable' };
          return {
            status: 'complete',
            bindings: [{ bindingId: 'follow:owner', scope: { ownerPosition: positions[0]! }, evidenceRefs: ['owner-context:1'], contribution: ref(FOLLOW_GOAL) }],
          };
        },
      };

      const candidateProvider: PluginCandidateProvider = {
        id: FOLLOW_CANDIDATE,
        list: async (input) => {
          const positions = ownerPositions(input);
          if (positions.length === 0) return { status: 'unavailable', candidates: [], reason: 'owner_location_unavailable' };
          return {
            status: 'complete',
            candidates: [{
              candidateId: 'follow:move',
              operationContribution: ref(FOLLOW_OPERATION),
              params: { target: positions[0]! },
              evidenceRefs: ['owner-context:1'],
              contribution: ref(FOLLOW_CANDIDATE),
            }],
          };
        },
      };

      const progressProvider: PluginProgressProvider = {
        id: FOLLOW_PROGRESS,
        assess: async (input) => {
          const positions = ownerPositions(input);
          const within = positions.some(pos => distance(pos, followingDistance(input)) <= FOLLOW_RADIUS);
          return {
            status: 'complete',
            progress: { completed: within ? 1 : 0, total: 1, blocked: 0, truncated: false, evidenceRefs: [], contribution: ref(FOLLOW_PROGRESS) },
          };
        },
      };

      const predicate: PluginPredicateEvaluator = {
        id: FOLLOW_PREDICATE,
        version: '1.0.0',
        evaluate: async (input) => {
          const positions = ownerPositions(input as unknown as PluginPlanningInput);
          if (positions.length === 0) return { verdict: 'unknown', evidenceRefs: [], reason: 'owner_location_unavailable', contribution: ref(FOLLOW_PREDICATE) };
          const within = positions.some(() => (input.evidence?.within ?? false));
          return { verdict: within ? 'satisfied' : 'unsatisfied', evidenceRefs: [], contribution: ref(FOLLOW_PREDICATE) };
        },
      };

      const behaviorFactory: PluginBehaviorFactory = {
        id: FOLLOW_EXECUTOR,
        version: '1.0.0',
        create: (lease): PluginBehaviorInstance => {
          const instanceId = `follow-${lease.goalId}`;
          return {
            instanceId,
            contribution: ref(FOLLOW_EXECUTOR),
            run: async (ctx) => {
              if (!bodySubmit) return { ok: false, cancelled: false, error: 'body_submit_service_missing' };
              const target = (ctx.facts[0]?.payload as { ownerPosition?: Record<string, unknown> } | undefined)?.ownerPosition;
              if (!target) return { ok: false, cancelled: false, error: 'owner_location_unavailable' };
              if (ctx.signal.aborted) return { ok: false, cancelled: true };
              const receipt = await bodySubmit({ action: 'minecraft-system:move-to', target });
              return (receipt as { ok?: boolean }).ok === false
                ? { ok: false, cancelled: false, error: 'move_failed' }
                : { ok: true, cancelled: false };
            },
            halt: async () => undefined,
            close: async () => undefined,
            settled: false,
          };
        },
      };

      const projection: PluginResultProjection = {
        id: FOLLOW_RESULT,
        version: '1.0.0',
        project: async (input) => {
          const verdict = input.evidence.verdict;
          return {
            status: 'projected',
            output: {
              presentation: { verdict },
              audience: 'owner',
              summary: verdict === 'completed' ? '已到主人身边。' : '跟随中或受阻。',
              evidenceRefs: input.evidence.ledger.map(() => 'follow:1'),
              contribution: ref(FOLLOW_RESULT),
            },
          };
        },
      };

      const target = {
        registryId: FOLLOW_GOAL,
        goalKind: 'location' as const,
        aliases: ['跟随主人', '跟着我', '跟过来', '过来', 'follow me'],
        successCriteria: [{ type: 'predicate' as const, predicate: FOLLOW_PREDICATE }],
      };

      return [
        { kind: 'goal', id: FOLLOW_GOAL, version: '1.0.0', target, bindingProvider },
        { kind: 'planning', id: FOLLOW_CANDIDATE, version: '1.0.0', candidateProvider },
        { kind: 'verification', id: FOLLOW_PREDICATE, version: '1.0.0', predicates: [predicate] },
        {
          kind: 'execution',
          id: FOLLOW_EXECUTOR,
          version: '1.0.0',
          operation: {
            operationId: FOLLOW_OPERATION,
            goalContributionId: FOLLOW_GOAL,
            bindingContributionId: FOLLOW_GOAL,
            factKinds: ['owner_location'],
            candidateContributionId: FOLLOW_CANDIDATE,
            predicateContributionId: FOLLOW_PREDICATE,
            progressContributionId: FOLLOW_PROGRESS,
            resultContributionId: FOLLOW_RESULT,
            cancellable: true,
          },
          behaviorFactory,
        },
        { kind: 'planning', id: FOLLOW_PROGRESS, version: '1.0.0', candidateProvider, progressProvider },
        { kind: 'result', id: FOLLOW_RESULT, version: '1.0.0', projection },
      ];
    },
  };
}

function distance(position: Record<string, unknown>, other: Record<string, unknown>): number {
  const x = Number(position.x) - Number(other.x);
  const y = Number(position.y) - Number(other.y);
  const z = Number(position.z) - Number(other.z);
  return Math.sqrt(x * x + y * y + z * z);
}

function followingDistance(_input: PluginPlanningInput): Record<string, unknown> {
  return { x: 0, y: 0, z: 0 };
}
