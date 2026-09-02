/**
 * mineclaw.crafting · first-party domain plugin.
 * Craft-item closed loop: candidates consult the owner-inventory fact, the
 * executor submits the craft atomic through the body service (missing service
 * reported), and the predicate verifies the output item via inventory fact.
 */
import type { PluginFactory } from '../../../plugin-kernel/discovery.js';
import type { PluginContribution } from '../../../plugin-sdk/index.js';
import type { PluginCandidateProvider, PluginBindingProvider, PluginProgressProvider, PluginPlanningInput } from '../../../plugin-sdk/contracts/planning.js';
import type { PluginPredicateEvaluator } from '../../../plugin-sdk/contracts/verification.js';
import type { PluginBehaviorFactory, PluginBehaviorInstance } from '../../../plugin-sdk/contracts/execution.js';
import type { PluginResultProjection } from '../../../plugin-sdk/contracts/result.js';
import type { ContributionRef } from '../../../plugin-sdk/identity.js';

const PLUGIN_ID = 'mineclaw.crafting';
const SERVICE_BODY = 'body.submit';
const CRAFT_GOAL = 'mineclaw.crafting.goal.craft-item';
const CRAFT_CANDIDATE = 'mineclaw.crafting.planning.craft-candidates';
const CRAFT_PREDICATE = 'mineclaw.crafting.verification.crafted';
const CRAFT_PROGRESS = 'mineclaw.crafting.progress.craft';
const CRAFT_RESULT = 'mineclaw.crafting.result.craft';
const CRAFT_OPERATION = 'mineclaw.crafting.operation.craft-item';
const CRAFT_EXECUTOR = 'mineclaw.crafting.execution.craft-item';

function ref(id: string): ContributionRef {
  return { pluginId: PLUGIN_ID, pluginVersion: '1.0.0', contributionId: id, contributionVersion: '1.0.0' };
}

function inventoryHas(facts: readonly Readonly<Record<string, unknown>>[], item: string): boolean {
  return facts.some(fact => {
    const slots = (fact as { payload?: { slots?: Array<{ itemId?: string }> } }).payload?.slots ?? [];
    return slots.some(slot => slot.itemId?.includes(item));
  });
}

export function createMineclawCraftingPlugin(): PluginFactory {
  return {
    entryKey: `plugins/builtin/${PLUGIN_ID}`,
    create: (context): readonly PluginContribution[] => {
      const bodySubmit = (context.services ?? {})[SERVICE_BODY] as ((request: Record<string, unknown>) => Promise<Record<string, unknown>>) | undefined;

      const bindingProvider: PluginBindingProvider = {
        id: CRAFT_GOAL,
        list: async () => ({
          status: 'complete',
          bindings: [{ bindingId: 'craft:workspace', scope: { location: 'workbench' }, evidenceRefs: ['inventory:1'], contribution: ref(CRAFT_GOAL) }],
        }),
      };

      const candidateProvider: PluginCandidateProvider = {
        id: CRAFT_CANDIDATE,
        list: async (input) => {
          const item = String(input.params?.item ?? '');
          if (!item) return { status: 'unavailable', candidates: [], reason: 'item_required' };
          return {
            status: 'complete',
            candidates: [{ candidateId: `craft:${item}`, operationContribution: ref(CRAFT_OPERATION), params: { item }, evidenceRefs: [], contribution: ref(CRAFT_CANDIDATE) }],
          };
        },
      };

      const progressProvider: PluginProgressProvider = {
        id: CRAFT_PROGRESS,
        assess: async (input) => {
          const item = String(input.params?.item ?? '');
          const done = inventoryHas(input.facts.map(fact => fact as unknown as Record<string, unknown>), item);
          return {
            status: 'complete',
            progress: { completed: done ? 1 : 0, total: 1, blocked: 0, truncated: false, evidenceRefs: [], contribution: ref(CRAFT_PROGRESS) },
          };
        },
      };

      const predicate: PluginPredicateEvaluator = {
        id: CRAFT_PREDICATE,
        version: '1.0.0',
        evaluate: async (input) => {
          const item = String(input.args?.item ?? '');
          const done = inventoryHas(input.facts, item);
          return { verdict: done ? 'satisfied' : 'unknown', evidenceRefs: [], reason: done ? undefined : 'inventory_fact_missing', contribution: ref(CRAFT_PREDICATE) };
        },
      };

      const behaviorFactory: PluginBehaviorFactory = {
        id: CRAFT_EXECUTOR,
        version: '1.0.0',
        create: (lease): PluginBehaviorInstance => ({
          instanceId: `craft-${lease.goalId}`,
          contribution: ref(CRAFT_EXECUTOR),
          run: async (ctx) => {
            if (!bodySubmit) return { ok: false, cancelled: false, error: 'body_submit_service_missing' };
            const item = String((ctx.facts[0]?.payload as { item?: string } | undefined)?.item ?? '');
            if (!item) return { ok: false, cancelled: false, error: 'item_required' };
            if (ctx.signal.aborted) return { ok: false, cancelled: true };
            const receipt = await bodySubmit({ action: 'minecraft-system:use_item', item });
            return (receipt as { ok?: boolean }).ok === false
              ? { ok: false, cancelled: false, error: 'craft_failed' }
              : { ok: true, cancelled: false };
          },
          halt: async () => undefined,
          close: async () => undefined,
          settled: false,
        }),
      };

      const projection: PluginResultProjection = {
        id: CRAFT_RESULT,
        version: '1.0.0',
        project: async (input) => ({
          status: 'projected',
          output: {
            presentation: { verdict: input.evidence.verdict },
            audience: 'owner',
            summary: input.evidence.verdict === 'completed' ? '合成完成。' : '合成中或缺少材料。',
            evidenceRefs: input.evidence.ledger.map(() => 'craft:1'),
            contribution: ref(CRAFT_RESULT),
          },
        }),
      };

      const target = {
        registryId: CRAFT_GOAL,
        goalKind: 'item' as const,
        aliases: ['合成', '制作', '造', 'craft', 'make'],
        successCriteria: [{ type: 'predicate' as const, predicate: CRAFT_PREDICATE }],
      };

      return [
        { kind: 'goal', id: CRAFT_GOAL, version: '1.0.0', target, bindingProvider },
        { kind: 'planning', id: CRAFT_CANDIDATE, version: '1.0.0', candidateProvider },
        { kind: 'verification', id: CRAFT_PREDICATE, version: '1.0.0', predicates: [predicate] },
        {
          kind: 'execution',
          id: CRAFT_EXECUTOR,
          version: '1.0.0',
          operation: {
            operationId: CRAFT_OPERATION,
            goalContributionId: CRAFT_GOAL,
            bindingContributionId: CRAFT_GOAL,
            factKinds: ['inventory'],
            candidateContributionId: CRAFT_CANDIDATE,
            predicateContributionId: CRAFT_PREDICATE,
            progressContributionId: CRAFT_PROGRESS,
            resultContributionId: CRAFT_RESULT,
            cancellable: true,
          },
          behaviorFactory,
        },
        { kind: 'planning', id: CRAFT_PROGRESS, version: '1.0.0', candidateProvider, progressProvider },
        { kind: 'result', id: CRAFT_RESULT, version: '1.0.0', projection },
      ];
    },
  };
}
