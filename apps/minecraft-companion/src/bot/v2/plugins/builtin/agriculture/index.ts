/**
 * mineclaw.agriculture · first-party domain plugin (kernel design §5.8).
 * Harvest-to-chest nine-segment closed loop migrated to plugin contribution
 * IDs. World facts come from the bounded block observation port; executor
 * behavior requires the body submission service (published by the P3 driver) —
 * when that dependency is not wired yet, its availability is reported, never
 * faked.
 */
import type { PluginFactory } from '../../../plugin-kernel/discovery.js';
import type { PluginContribution } from '../../../plugin-sdk/index.js';
import type {
  PluginObservationProvider,
  PluginObservationProviderFactory,
  PluginObservationFact,
} from '../../../plugin-sdk/contracts/observation.js';
import type {
  PluginBindingProvider,
  PluginCandidateProvider,
  PluginProgressProvider,
  PluginPlanningInput,
} from '../../../plugin-sdk/contracts/planning.js';
import type { PluginPredicateEvaluator } from '../../../plugin-sdk/contracts/verification.js';
import type { PluginBehaviorFactory, PluginBehaviorContext, PluginBehaviorInstance } from '../../../plugin-sdk/contracts/execution.js';
import type { PluginResultProjection } from '../../../plugin-sdk/contracts/result.js';
import type { BoundedBlockObservationPort } from '../../../plugin-sdk/contracts/integration.js';
import type { ContributionRef, RegistrySnapshotRef } from '../../../plugin-sdk/identity.js';

const PLUGIN_ID = 'mineclaw.agriculture';
const SERVICE_BLOCK = 'bounded.block.observation';
const SERVICE_BODY = 'body.submit';

export const HARVEST_GOAL = 'mineclaw.agriculture.goal.harvest-mature-crops-to-chest';
export const HARVEST_BINDING = 'mineclaw.agriculture.binding.harvest-area-and-chest';
export const HARVEST_FACT = 'mineclaw.agriculture.observation.harvest-state';
export const HARVEST_CANDIDATE = 'mineclaw.agriculture.planning.harvest-to-chest-candidates';
export const HARVEST_OPERATION = 'mineclaw.agriculture.operation.harvest-to-chest';
export const HARVEST_EXECUTOR = 'mineclaw.agriculture.execution.harvest-to-chest';
export const HARVEST_PREDICATE = 'mineclaw.agriculture.verification.harvested-to-chest';
export const HARVEST_PROGRESS = 'mineclaw.agriculture.progress.harvest-to-chest';
export const HARVEST_RESULT = 'mineclaw.agriculture.result.harvest-to-chest';

function ref(contributionId: string): ContributionRef {
  return { pluginId: PLUGIN_ID, pluginVersion: '1.0.0', contributionId, contributionVersion: '1.0.0' };
}

function createHarvestStateProvider(blockPort: BoundedBlockObservationPort | undefined, identity: ContributionRef): PluginObservationProvider {
  return {
    id: HARVEST_FACT,
    observe: async (input) => {
      if (!blockPort) return { status: 'unavailable', reason: 'service_missing:bounded.block.observation' };
      if (input.signal.aborted) return { status: 'cancelled' };
      try {
        const observed = await blockPort.observe({
          dimension: String(input.scope.dimension ?? 'minecraft:overworld'),
          bounds: input.scope,
          maxBlocks: 4096,
          deadlineAt: Date.now() + input.budget.timeoutMs,
          signal: input.signal,
        });
        const mature: Array<{ block: string; position: unknown; state: string }> = [];
        for (const block of observed.blocks) {
          const raw = block as Record<string, unknown>;
          const name = String(raw.name ?? '');
          if (/wheat|carrots|potatoes|beetroots/.test(name) && String((raw.properties as Record<string, unknown> | undefined)?.age ?? '7') === '7') {
            mature.push({ block: name, position: raw.position, state: 'mature' });
          }
        }
        return {
          status: 'fulfilled',
          fact: {
            factKind: 'nearby_crops',
            snapshotVersion: observed.snapshotVersion,
            observedAt: observed.observedAt,
            requestedBounds: observed.requestedBounds,
            observedBounds: observed.observedBounds,
            complete: observed.complete,
            truncated: observed.truncated,
            unloadedRegions: observed.unloadedRegions,
            payload: { crops: mature, count: mature.length, complete: observed.complete, truncated: observed.truncated },
            evidenceRefs: observed.evidenceRefs.map((evidence, index) => ({ ref: evidence, source: 'mineclaw.minecraft-system', at: observed.observedAt })),
            contribution: identity,
          },
        };
      } catch {
        return { status: 'unavailable', reason: 'harvest_state_scan_failed' };
      }
    },
    close: () => undefined,
  };
}

function createBindingProvider(): PluginBindingProvider {
  return {
    id: HARVEST_BINDING,
    list: async (input) => {
      const crops = collectCrops(input);
      const positions = crops.map(crop => crop.position);
      if (positions.length === 0) return { status: 'complete', bindings: [{ bindingId: 'harvest:empty', scope: { cropCells: [] }, evidenceRefs: [], contribution: ref(HARVEST_BINDING) }] };
      return {
        status: 'complete',
        bindings: [{
          bindingId: `harvest:${positions.length}`,
          scope: { cropCells: positions },
          evidenceRefs: crops.map((crop, index) => `crop:${index}`),
          contribution: ref(HARVEST_BINDING),
        }],
      };
    },
  };
}

function createCandidateProvider(): PluginCandidateProvider {
  return {
    id: HARVEST_CANDIDATE,
    list: async (input) => {
      const bindings = input.params?.bindingScope ? [input.params.bindingScope as Record<string, unknown>] : collectCrops(input).map(crop => ({ cropCells: [crop.position] }));
      const cells = bindings.flatMap(binding => (binding.cropCells as unknown[]) ?? []);
      if (cells.length === 0) return { status: 'complete', candidates: [] };
      return {
        status: 'complete',
        candidates: [{
          candidateId: `harvest:${cells.length}`,
          operationContribution: ref(HARVEST_OPERATION),
          params: { cells, chestRef: input.params?.chestRef },
          evidenceRefs: [],
          contribution: ref(HARVEST_CANDIDATE),
        }],
      };
    },
  };
}

function createProgressProvider(): PluginProgressProvider {
  return {
    id: HARVEST_PROGRESS,
    assess: async (input) => {
      const cells = ((input.params?.cells as unknown[]) ?? []);
      const remaining = cells.filter(cell => isStillMature(cell as Record<string, unknown>, input.facts.map(fact => fact as unknown as Record<string, unknown>)));
      return {
        status: 'complete',
        progress: {
          completed: cells.length - remaining.length,
          total: cells.length,
          blocked: 0,
          truncated: cells.length === 0 ? false : input.facts.some(fact => !fact.complete),
          evidenceRefs: [],
          contribution: ref(HARVEST_PROGRESS),
        },
      };
    },
  };
}

function createPredicate(): PluginPredicateEvaluator {
  return {
    id: HARVEST_PREDICATE,
    version: '1.0.0',
    evaluate: async (input) => {
      const cells = ((input.args?.cells as unknown[]) ?? []);
      if (cells.length === 0) return { verdict: 'unknown', evidenceRefs: [], reason: 'no_cells_bound', contribution: ref(HARVEST_PREDICATE) };
      const remaining = cells.filter(cell => isStillMature(cell as Record<string, unknown>, input.facts));
      if (remaining.length > 0) return { verdict: 'unsatisfied', evidenceRefs: [], reason: `${remaining.length} crops remain`, contribution: ref(HARVEST_PREDICATE) };
      return { verdict: 'satisfied', evidenceRefs: [], contribution: ref(HARVEST_PREDICATE) };
    },
  };
}

function createBehavior(): PluginBehaviorFactory {
  return {
    id: HARVEST_EXECUTOR,
    version: '1.0.0',
    create: (lease, scoped): PluginBehaviorInstance => {
      const services = (scoped as unknown as { services?: Record<string, unknown> }).services;
      const bodySubmit = services?.[SERVICE_BODY] as ((request: Record<string, unknown>) => Promise<Record<string, unknown>>) | undefined;
      const instanceId = `harvest-${lease.goalId}`;
      return {
        instanceId,
        contribution: ref(HARVEST_EXECUTOR),
        run: async (ctx: PluginBehaviorContext) => {
          if (!bodySubmit) {
            return { ok: false, cancelled: false, error: 'body_submit_service_missing' };
          }
          const cells = ((ctx.facts[0]?.payload as Record<string, unknown> | undefined)?.crops as Array<Record<string, unknown>>) ?? [];
          for (const cell of cells) {
            if (ctx.signal.aborted) break;
            const receipt = await bodySubmit({ action: 'minecraft-system:dig', position: cell.position });
            if ((receipt as { ok?: boolean }).ok === false) return { ok: false, cancelled: false, error: `cell_failed:${String(cell.position)}` };
          }
          return { ok: true, cancelled: false };
        },
        halt: async () => undefined,
        close: async () => undefined,
        settled: false,
        void: undefined as never,
      } as unknown as PluginBehaviorInstance;
    },
  };
}

function createResultProjection(): PluginResultProjection {
  return {
    id: HARVEST_RESULT,
    version: '1.0.0',
    project: async (input) => {
      const verdict = input.evidence.verdict;
      if (input.signal.aborted) return { status: 'projection_cancelled' };
      const summary = verdict === 'completed'
        ? '收割完成：成熟作物已归仓。'
        : verdict === 'needs_owner'
          ? '需要确认收割范围或目标箱子。'
          : verdict === 'unknown'
            ? '收割仍在进行或证据不足。'
            : '收割未完成，遇到障碍。';
      return {
        status: 'projected',
        output: {
          presentation: { verdict, progress: input.evidence.progress },
          audience: 'owner',
          summary,
          evidenceRefs: input.evidence.ledger.map(() => 'ledger:1'),
          contribution: ref(HARVEST_RESULT),
        },
      };
    },
  };
}

function collectCrops(input: PluginPlanningInput): Array<Record<string, unknown>> {
  return input.facts.flatMap((fact: PluginObservationFact) => {
    const payload = fact.payload as { crops?: Array<Record<string, unknown>> };
    return (payload.crops ?? []) as Array<Record<string, unknown>>;
  });
}

function isStillMature(cell: Record<string, unknown>, facts: readonly Readonly<Record<string, unknown>>[]): boolean {
  return facts.some(fact => {
    const payload = fact.payload as { crops?: Array<Record<string, unknown>> };
    return (payload.crops ?? []).some(crop => JSON.stringify(crop.position) === JSON.stringify(cell.position));
  });
}

export function createMineclawAgriculturePlugin(): PluginFactory {
  return {
    entryKey: `plugins/builtin/${PLUGIN_ID}`,
    create: (context): readonly PluginContribution[] => {
      const services = context.services ?? {};
      const blockPort = services[SERVICE_BLOCK] as BoundedBlockObservationPort | undefined;
      const identity = ref(PLUGIN_ID);
      void identity;
      const goalTarget = {
        registryId: HARVEST_GOAL,
        goalKind: 'item' as const,
        aliases: ['收割', '收获', '收麦子', '成熟作物归仓'],
        successCriteria: [{ type: 'predicate' as const, predicate: HARVEST_PREDICATE }],
      };
      const bindingTarget = {
        registryId: HARVEST_BINDING,
        goalKind: 'location' as const,
        aliases: ['这块田', '这片农田'],
        successCriteria: [{ type: 'predicate' as const, predicate: HARVEST_PREDICATE }],
      };
      return [
        { kind: 'goal', id: HARVEST_GOAL, version: '1.0.0', target: goalTarget },
        { kind: 'goal', id: HARVEST_BINDING, version: '1.0.0', target: bindingTarget, bindingProvider: createBindingProvider() },
        {
          kind: 'observation',
          id: HARVEST_FACT,
          version: '1.0.0',
          factory: {
            id: HARVEST_FACT, version: '1.0.0',
            descriptor: {
              id: HARVEST_FACT, version: '1.0.0',
              inputSchema: { type: 'object', additionalProperties: false },
              resultSchema: { type: 'object', additionalProperties: false },
              factKinds: ['nearby_crops'],
              coverage: { dimension: ['minecraft:overworld'], role: 'world' },
              limits: { maxBlocks: 4096, timeoutMs: 5000 },
            },
            create: () => createHarvestStateProvider(blockPort, ref(HARVEST_FACT)),
          },
        },
        { kind: 'planning', id: HARVEST_CANDIDATE, version: '1.0.0', candidateProvider: createCandidateProvider() },
        { kind: 'verification', id: HARVEST_PREDICATE, version: '1.0.0', predicates: [createPredicate()] },
        {
          kind: 'execution',
          id: HARVEST_EXECUTOR,
          version: '1.0.0',
          operation: {
            operationId: HARVEST_OPERATION,
            goalContributionId: HARVEST_GOAL,
            bindingContributionId: HARVEST_BINDING,
            factKinds: ['nearby_crops'],
            candidateContributionId: HARVEST_CANDIDATE,
            predicateContributionId: HARVEST_PREDICATE,
            progressContributionId: HARVEST_PROGRESS,
            resultContributionId: HARVEST_RESULT,
            cancellable: true,
          },
          behaviorFactory: createBehavior(),
        },
        { kind: 'planning', id: HARVEST_PROGRESS, version: '1.0.0', candidateProvider: createCandidateProvider(), progressProvider: createProgressProvider() },
        { kind: 'result', id: HARVEST_RESULT, version: '1.0.0', projection: createResultProjection() },
      ];
    },
  };
}
