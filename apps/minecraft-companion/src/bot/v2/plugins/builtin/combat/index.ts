/**
 * mineclaw.combat · first-party domain plugin.
 * Combat-target closed loop; candidates require entity facts (structured
 * unavailable while the entity observation port is absent), executor submits
 * move-to+attack via body service.
 */
import type { PluginFactory } from '../../../plugin-kernel/discovery.js';
import type { PluginContribution } from '../../../plugin-sdk/index.js';
import type { PluginCandidateProvider, PluginBindingProvider, PluginProgressProvider } from '../../../plugin-sdk/contracts/planning.js';
import type { PluginPredicateEvaluator } from '../../../plugin-sdk/contracts/verification.js';
import type { PluginBehaviorFactory, PluginBehaviorInstance } from '../../../plugin-sdk/contracts/execution.js';
import type { PluginResultProjection } from '../../../plugin-sdk/contracts/result.js';
import type { ContributionRef } from '../../../plugin-sdk/identity.js';

const PLUGIN_ID = 'mineclaw.combat';
const GOAL = 'mineclaw.combat.goal.combat-target';
const CANDIDATE = 'mineclaw.combat.planning.combat-candidates';
const PREDICATE = 'mineclaw.combat.verification.target-dead';
const PROGRESS = 'mineclaw.combat.progress.combat';
const RESULT = 'mineclaw.combat.result.combat';
const OPERATION = 'mineclaw.combat.operation.combat-target';
const EXECUTOR = 'mineclaw.combat.execution.combat-target';

function ref(id: string): ContributionRef {
  return { pluginId: PLUGIN_ID, pluginVersion: '1.0.0', contributionId: id, contributionVersion: '1.0.0' };
}

export function createMineclawCombatPlugin(): PluginFactory {
  return {
    entryKey: `plugins/builtin/${PLUGIN_ID}`,
    create: (context): readonly PluginContribution[] => {
      const bindingProvider: PluginBindingProvider = {
        id: GOAL,
        list: async (input) => {
          const target = input.params?.target;
          if (!target) return { status: 'unavailable', bindings: [], reason: 'entity_observation_unavailable' };
          return { status: 'complete', bindings: [{ bindingId: 'combat:target', scope: { target }, evidenceRefs: [], contribution: ref(GOAL) }] };
        },
      };

      const candidateProvider: PluginCandidateProvider = {
        id: CANDIDATE,
        list: async (input) => {
          // 实体观察端口尚未装配：显式 unavailable，绝不猜测实体。
          const supplied = input.params?.target;
          if (!supplied) return { status: 'unavailable', candidates: [], reason: 'entity_observation_unavailable' };
          return { status: 'complete', candidates: [{ candidateId: `combat:${String((supplied as { id?: string }).id ?? 'target')}`, operationContribution: ref(EXECUTOR), params: { target: supplied }, evidenceRefs: [], contribution: ref(CANDIDATE) }] };
        },
      };

      const progressProvider: PluginProgressProvider = {
        id: PROGRESS,
        assess: async () => ({ status: 'complete', progress: { completed: 0, total: 1, blocked: 0, truncated: false, evidenceRefs: [], contribution: ref(PROGRESS) } }),
      };

      const predicate: PluginPredicateEvaluator = {
        id: PREDICATE,
        version: '1.0.0',
        evaluate: (input) => {
          const dead = (input.evidence?.entityDead as boolean | undefined) === true;
          return { verdict: dead ? 'satisfied' : 'unknown', evidenceRefs: [], reason: dead ? undefined : 'entity_death_unverified', contribution: ref(PREDICATE) };
        },
      };

      const behaviorFactory: PluginBehaviorFactory = {
        id: EXECUTOR,
        version: '1.0.0',
        create: (lease): PluginBehaviorInstance => ({
          instanceId: `combat-${lease.goalId}`,
          contribution: ref(EXECUTOR),
          kind: 'sequence',
          compile: (ctx) => {
            const target = ctx.params.target as Record<string, unknown> | undefined;
            return target
              ? { ok: true, steps: [
                  { atomicId: 'move_to', args: { position: target } },
                  { atomicId: 'attack', args: { target } },
                ] }
              : { ok: false, error: 'entity_observation_unavailable' };
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
            summary: input.evidence.verdict === 'completed' ? '目标已消灭。' : '战斗中或目标不可达。',
            evidenceRefs: input.evidence.ledger.map(() => 'combat:1'),
            contribution: ref(RESULT),
          },
        }),
      };

      const target = {
        registryId: GOAL,
        goalKind: 'entity' as const,
        aliases: ['攻击', '打', '杀', '消灭', 'attack', 'fight'],
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
            factKinds: ['nearby_entities'],
            candidateContributionId: CANDIDATE,
            predicateContributionId: PREDICATE,
            progressContributionId: PROGRESS,
            resultContributionId: RESULT,
            cancellable: true,
            applicability: { outcomes: ['defeat'], targetKinds: ['entity'], taskFamilies: ['combat'], criterionTypes: ['entity_dead', 'predicate'] },
          },
          behaviorFactory,
        },
        { kind: 'planning', id: PROGRESS, version: '1.0.0', candidateProvider, progressProvider },
        { kind: 'result', id: RESULT, version: '1.0.0', projection },
      ];
    },
  };
}
