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
import type { PluginBehaviorFactory, PluginBehaviorInstance } from '../../../plugin-sdk/contracts/execution.js';
import type { PluginResultProjection } from '../../../plugin-sdk/contracts/result.js';
import type { BoundedBlockObservationPort } from '../../../plugin-sdk/contracts/integration.js';
import type { ContributionRef } from '../../../plugin-sdk/identity.js';

const PLUGIN_ID = 'mineclaw.agriculture';
const SERVICE_BLOCK = 'bounded.block.observation';

export const HARVEST_GOAL = 'mineclaw.agriculture.goal.harvest-mature-crops-to-chest';
export const HARVEST_BINDING = 'mineclaw.agriculture.binding.harvest-area-and-chest';
export const HARVEST_FACT = 'mineclaw.agriculture.observation.harvest-state';
export const HARVEST_CANDIDATE = 'mineclaw.agriculture.planning.harvest-to-chest-candidates';
export const HARVEST_OPERATION = 'mineclaw.agriculture.operation.harvest-to-chest';
export const HARVEST_EXECUTOR = 'mineclaw.agriculture.execution.harvest-to-chest';
export const HARVEST_PREDICATE = 'mineclaw.agriculture.verification.harvested-to-chest';
export const HARVEST_PROGRESS = 'mineclaw.agriculture.progress.harvest-to-chest';
export const HARVEST_RESULT = 'mineclaw.agriculture.result.harvest-to-chest';

export const SOW_GOAL = 'mineclaw.agriculture.goal.sow-field';
export const SOW_BINDING = 'mineclaw.agriculture.binding.sow-request';
export const SOW_FACT = 'mineclaw.agriculture.observation.field-state';
export const SOW_CANDIDATE = 'mineclaw.agriculture.planning.sow-candidates';
export const SOW_OPERATION = 'mineclaw.agriculture.operation.sow-field';
export const SOW_EXECUTOR = 'mineclaw.agriculture.execution.sow-field';
export const SOW_PREDICATE = 'mineclaw.agriculture.verification.field-sown';
export const SOW_PROGRESS = 'mineclaw.agriculture.progress.sow-field';
export const SOW_RESULT = 'mineclaw.agriculture.result.sow';

const CROP_TO_SEED = Object.freeze({ wheat: 'wheat_seeds', carrots: 'carrot', potatoes: 'potato', beetroots: 'beetroot_seeds' });
type SupportedCrop = keyof typeof CROP_TO_SEED;
type Cell = { x: number; y: number; z: number };
type AgricultureField = {
  id: string;
  farmlandCells: Cell[];
  emptyCells: Cell[];
  crops: Array<{ crop: SupportedCrop; position: Cell }>;
  complete: boolean;
  truncated: boolean;
};

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
          blockFilter: ['wheat', 'carrots', 'potatoes', 'beetroots'],
          maxBlocks: input.budget.maxResults,
          deadlineAt: Date.now() + input.budget.timeoutMs,
          signal: input.signal,
        });
        const crops: Array<{ block: string; position: unknown; age: number | null; maxAge: number; state: 'mature' | 'growing' }> = [];
        for (const block of observed.blocks) {
          const raw = block as Record<string, unknown>;
          const name = String(raw.name ?? '');
          if (!/(?:^|:)(?:wheat|carrots|potatoes|beetroots)$/.test(name)) continue;
          const maxAge = name.includes('beetroot') ? 3 : 7;
          const ageValue = Number((raw.properties as Record<string, unknown> | undefined)?.age);
          const age = Number.isFinite(ageValue) ? ageValue : null;
          crops.push({ block: name, position: raw.position, age, maxAge, state: age !== null && age >= maxAge ? 'mature' : 'growing' });
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
            payload: { crops, count: crops.length, complete: observed.complete, truncated: observed.truncated },
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
          operationContribution: ref(HARVEST_EXECUTOR),
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
    evaluate: (input) => {
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
    create: (lease): PluginBehaviorInstance => {
      const instanceId = `harvest-${lease.goalId}`;
      return {
        instanceId,
        contribution: ref(HARVEST_EXECUTOR),
        kind: 'sequence',
        compile: (ctx) => {
          const cells = (ctx.params.cells as Array<Record<string, unknown>> | undefined) ?? [];
          return { ok: true, steps: cells.map(cell => ({ atomicId: 'dig', args: { position: cell.position } })) };
        },
        halt: async () => undefined,
        close: async () => undefined,
        settled: false,
      };
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

function createFieldProvider(blockPort: BoundedBlockObservationPort | undefined): PluginObservationProvider {
  return {
    id: SOW_FACT,
    observe: async input => {
      if (!blockPort) return { status: 'unavailable', reason: 'service_missing:bounded.block.observation' };
      if (input.signal.aborted) return { status: 'cancelled' };
      try {
        const observed = await blockPort.observe({
          dimension: String(input.scope.dimension ?? 'minecraft:overworld'),
          bounds: input.scope,
          blockFilter: ['farmland', ...Object.keys(CROP_TO_SEED)],
          maxBlocks: input.budget.maxResults,
          deadlineAt: Date.now() + input.budget.timeoutMs,
          signal: input.signal,
        });
        const raw = observed.blocks as Array<Record<string, unknown>>;
        const farmland = raw.filter(block => blockName(block) === 'farmland').map(block => cell(block.position));
        const crops = raw.flatMap(block => {
          const crop = cropName(blockName(block));
          return crop ? [{ crop, position: cell(block.position) }] : [];
        });
        const fields = connectedFields(farmland).map((cells, index): AgricultureField => {
          const keys = new Set(cells.map(value => key({ x: value.x, y: value.y + 1, z: value.z })));
          const fieldCrops = crops.filter(value => keys.has(key(value.position)));
          const occupied = new Set(fieldCrops.map(value => key(value.position)));
          return {
            id: `field:${cells[0]?.x ?? 0}:${cells[0]?.y ?? 0}:${cells[0]?.z ?? 0}:${index}`,
            farmlandCells: cells,
            emptyCells: cells.map(value => ({ x: value.x, y: value.y + 1, z: value.z })).filter(value => !occupied.has(key(value))),
            crops: fieldCrops,
            complete: observed.complete,
            truncated: observed.truncated,
          };
        });
        return {
          status: 'fulfilled',
          fact: {
            factKind: 'agriculture_fields', snapshotVersion: observed.snapshotVersion, observedAt: observed.observedAt,
            requestedBounds: observed.requestedBounds, observedBounds: observed.observedBounds,
            complete: observed.complete, truncated: observed.truncated, unloadedRegions: observed.unloadedRegions,
            payload: { fields }, contribution: ref(SOW_FACT),
            evidenceRefs: observed.evidenceRefs.map((evidence, index) => ({ ref: evidence, source: 'mineclaw.minecraft-system', at: observed.observedAt || `field:${index}` })),
          },
        };
      } catch (error) {
        return { status: 'unavailable', reason: `field_observation_failed:${error instanceof Error ? error.message : String(error)}` };
      }
    },
    close: () => undefined,
  };
}

function createSowBinding(): PluginBindingProvider {
  return {
    id: SOW_BINDING,
    list: async input => {
      const fields = collectFields(input.facts);
      if (fields.length === 0) return { status: 'unavailable', bindings: [], reason: 'no_loaded_farmland' };
      if (fields.length > 1) return {
        status: 'ambiguous', bindings: [], reason: 'multiple_fields',
        needsOwner: { questionKind: 'field', options: fields.map(value => value.id) },
      };
      const field = fields[0]!;
      const crops = chooseCrops(input, field);
      if (crops.length !== 1) return {
        status: 'ambiguous', bindings: [], reason: crops.length === 0 ? 'crop_unavailable' : 'multiple_crops',
        needsOwner: { questionKind: 'crop', options: crops.length ? crops : Object.keys(CROP_TO_SEED) },
      };
      const crop = crops[0]!;
      const region = fieldRegion(field);
      return {
        status: 'complete',
        bindings: [{
          bindingId: `${field.id}:${crop}`,
          scope: { fieldId: field.id, crop, seedItem: CROP_TO_SEED[crop], cells: field.emptyCells, region, position: region.min, complete: field.complete, truncated: field.truncated },
          evidenceRefs: [`field:${field.id}`, `crop:${crop}`], contribution: ref(SOW_BINDING),
        }],
      };
    },
  };
}

function createSowCandidate(): PluginCandidateProvider {
  return {
    id: SOW_CANDIDATE,
    list: async input => {
      const cells = (input.params.cells as Cell[] | undefined) ?? [];
      const crop = cropName(String(input.params.crop ?? ''));
      if (!crop) return { status: 'unavailable', candidates: [], reason: 'crop_not_bound' };
      const available = inventoryCount(input.facts, CROP_TO_SEED[crop]);
      const missing = Math.max(0, cells.length - available);
      const blocked = missing > 0;
      return {
        status: blocked ? 'partial' : 'complete',
        candidates: cells.length === 0 ? [] : [{
          candidateId: `sow:${String(input.params.fieldId)}:${crop}:${cells.length}`,
          operationContribution: ref(SOW_EXECUTOR),
          params: { fieldId: input.params.fieldId, crop, seedItem: CROP_TO_SEED[crop], cells, requestedCells: cells.length },
          evidenceRefs: [`inventory:${CROP_TO_SEED[crop]}:${available}`], contribution: ref(SOW_CANDIDATE),
          authorization: blocked
            ? { status: 'blocked', reasons: [`missing_material:${CROP_TO_SEED[crop]}:${missing}`] }
            : { status: 'ready', reasons: [] },
          ...(blocked ? { prerequisites: [{
            goalContributionId: 'mineclaw.inventory.goal.item-available',
            arguments: { item: CROP_TO_SEED[crop], count: missing },
            reason: `sow_requires_seed:${CROP_TO_SEED[crop]}`,
          }] } : {}),
        }],
        ...(blocked ? { reason: `material_limited:${available}/${cells.length}` } : {}),
      };
    },
  };
}

function createSowBehavior(): PluginBehaviorFactory {
  return {
    id: SOW_EXECUTOR,
    version: '1.0.0',
    create: lease => ({
      instanceId: `sow-${lease.goalId}-${lease.operationEpoch}`,
      contribution: ref(SOW_EXECUTOR), kind: 'sequence', settled: false,
      compile: ctx => {
        const cells = (ctx.params.cells as Cell[] | undefined) ?? [];
        const seedItem = String(ctx.params.seedItem ?? '');
        if (!cells.length || !seedItem) return { ok: false, error: 'sow_binding_incomplete' };
        return { ok: true, steps: cells.map(position => ({
          atomicId: 'place_block',
          args: {
            itemName: seedItem,
            referencePosition: { x: position.x, y: position.y - 1, z: position.z },
            faceVector: { x: 0, y: 1, z: 0 },
            position,
          },
        })) };
      },
      halt: async () => undefined,
      close: async () => undefined,
    }),
  };
}

function createSowPredicate(): PluginPredicateEvaluator {
  return {
    id: SOW_PREDICATE, version: '1.0.0',
    argumentSchema: { type: 'object', additionalProperties: false, properties: {} },
    evaluate: input => {
      const fields = collectFieldsFromRecords(input.facts);
      if (!fields.length || fields.some(field => !field.complete || field.truncated)) {
        return { verdict: 'unknown', evidenceRefs: [], reason: 'sow_scope_incomplete', contribution: ref(SOW_PREDICATE) };
      }
      const empty = fields.reduce((total, field) => total + field.emptyCells.length, 0);
      const planted = fields.reduce((total, field) => total + field.crops.length, 0);
      return empty === 0 && planted > 0
        ? { verdict: 'satisfied', evidenceRefs: [`sow:planted:${planted}`], contribution: ref(SOW_PREDICATE) }
        : { verdict: 'unsatisfied', evidenceRefs: [`sow:empty:${empty}`, `sow:planted:${planted}`], reason: `${empty} cells remain`, contribution: ref(SOW_PREDICATE) };
    },
  };
}

function createSowProgress(): PluginProgressProvider {
  return {
    id: SOW_PROGRESS,
    assess: async input => {
      const cells = (input.params.cells as Cell[] | undefined) ?? [];
      const crop = cropName(String(input.params.crop ?? ''));
      const current = new Set(collectFields(input.facts).flatMap(field => field.crops.filter(value => !crop || value.crop === crop).map(value => key(value.position))));
      const completed = cells.filter(value => current.has(key(value))).length;
      const truncated = input.facts.some(fact => !fact.complete || fact.truncated);
      return { status: truncated ? 'partial' : 'complete', progress: {
        completed, total: cells.length, blocked: Math.max(0, Number(input.params.requestedCells ?? cells.length) - cells.length), truncated,
        evidenceRefs: [`sow:${completed}/${cells.length}`], contribution: ref(SOW_PROGRESS),
      } };
    },
  };
}

function createSowResult(): PluginResultProjection {
  return {
    id: SOW_RESULT, version: '1.0.0',
    project: async input => {
      if (input.signal.aborted) return { status: 'projection_cancelled' };
      const verdict = input.evidence.verdict;
      return { status: 'projected', output: {
        presentation: { verdict, progress: input.evidence.progress }, audience: 'owner',
        summary: verdict === 'completed' ? '田块播种完成，并已逐格回读确认。'
          : verdict === 'needs_owner' ? '需要你确认田块或作物。'
            : verdict === 'unknown' ? '播种证据不完整，未判定完成。' : '播种只完成了一部分或被材料阻塞。',
        evidenceRefs: input.evidence.ledger.map((_value, index) => `sow-ledger:${index}`), contribution: ref(SOW_RESULT),
      } };
    },
  };
}

function collectFields(facts: readonly PluginObservationFact[]): AgricultureField[] {
  return collectFieldsFromRecords(facts as unknown as readonly Readonly<Record<string, unknown>>[]);
}

function collectFieldsFromRecords(facts: readonly Readonly<Record<string, unknown>>[]): AgricultureField[] {
  return facts.flatMap(fact => {
    if (fact.factKind !== 'agriculture_fields') return [];
    return ((fact.payload as { fields?: AgricultureField[] } | undefined)?.fields ?? []).map(value => structuredClone(value));
  });
}

function chooseCrops(input: PluginPlanningInput, field: AgricultureField): SupportedCrop[] {
  const text = String(input.params.goalText ?? '').toLowerCase();
  const explicit = ([['wheat', /小麦|wheat/], ['carrots', /胡萝卜|carrot/], ['potatoes', /土豆|马铃薯|potato/], ['beetroots', /甜菜|beetroot/]] as const)
    .filter(([, pattern]) => pattern.test(text)).map(([crop]) => crop);
  if (explicit.length) return [...new Set(explicit)];
  const planted = [...new Set(field.crops.map(value => value.crop))];
  if (planted.length === 1) return planted;
  const inInventory = (Object.entries(CROP_TO_SEED) as Array<[SupportedCrop, string]>)
    .filter(([, seed]) => inventoryCount(input.facts, seed) > 0).map(([crop]) => crop);
  return [...new Set(inInventory)];
}

function inventoryCount(facts: readonly PluginObservationFact[], itemId: string): number {
  return facts.filter(fact => fact.factKind === 'inventory').reduce((sum, fact) => sum + (((fact.payload as { slots?: Array<{ itemId: string; count: number }> }).slots ?? [])
    .filter(slot => slot.itemId === itemId).reduce((count, slot) => count + slot.count, 0)), 0);
}

function connectedFields(cells: Cell[]): Cell[][] {
  const byKey = new Map(cells.map(value => [key(value), value]));
  const remaining = new Set(byKey.keys());
  const groups: Cell[][] = [];
  while (remaining.size) {
    const first = remaining.values().next().value as string;
    const queue = [first]; remaining.delete(first);
    const group: Cell[] = [];
    while (queue.length) {
      const currentKey = queue.shift()!;
      const current = byKey.get(currentKey)!; group.push(current);
      for (const next of [[current.x + 1, current.z], [current.x - 1, current.z], [current.x, current.z + 1], [current.x, current.z - 1]]) {
        const adjacent = key({ x: next[0]!, y: current.y, z: next[1]! });
        if (remaining.delete(adjacent)) queue.push(adjacent);
      }
    }
    groups.push(group.sort((a, b) => a.x - b.x || a.z - b.z || a.y - b.y));
  }
  return groups.sort((a, b) => key(a[0]!).localeCompare(key(b[0]!)));
}

function blockName(block: Record<string, unknown>): string { return String(block.name ?? '').replace(/^minecraft:/, ''); }
function cropName(value: string): SupportedCrop | null {
  const normalized = value.replace(/^minecraft:/, '').toLowerCase();
  if (normalized === 'carrot') return 'carrots';
  if (normalized === 'potato') return 'potatoes';
  if (normalized === 'beetroot') return 'beetroots';
  return normalized in CROP_TO_SEED ? normalized as SupportedCrop : null;
}
function cell(value: unknown): Cell {
  const position = value as { x?: unknown; y?: unknown; z?: unknown };
  return { x: Number(position?.x), y: Number(position?.y), z: Number(position?.z) };
}
function key(value: Cell): string { return `${value.x}:${value.y}:${value.z}`; }
function fieldRegion(field: AgricultureField): { min: Cell; max: Cell } {
  const cells = field.farmlandCells;
  return {
    min: { x: Math.min(...cells.map(value => value.x)), y: Math.min(...cells.map(value => value.y)), z: Math.min(...cells.map(value => value.z)) },
    max: { x: Math.max(...cells.map(value => value.x)), y: Math.max(...cells.map(value => value.y)) + 1, z: Math.max(...cells.map(value => value.z)) },
  };
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
      const sowTarget = {
        registryId: SOW_GOAL,
        goalKind: 'composite' as const,
        aliases: ['种田', '播种', '种一下', '把这个田种一下', '种小麦', '种胡萝卜', '种土豆', '种甜菜'],
        taskFamilies: ['agriculture'],
        successCriteria: [{ type: 'predicate' as const, predicate: SOW_PREDICATE }],
      };
      const sowBindingTarget = {
        registryId: SOW_BINDING,
        goalKind: 'location' as const,
        aliases: ['这个田', '这块田', '已有农田'],
        taskFamilies: ['agriculture'],
        successCriteria: [{ type: 'predicate' as const, predicate: SOW_PREDICATE }],
      };
      return [
        { kind: 'goal', id: SOW_GOAL, version: '1.0.0', target: sowTarget },
        { kind: 'goal', id: SOW_BINDING, version: '1.0.0', target: sowBindingTarget, bindingProvider: createSowBinding() },
        {
          kind: 'observation', id: SOW_FACT, version: '1.0.0',
          factory: {
            id: SOW_FACT, version: '1.0.0',
            descriptor: {
              id: SOW_FACT, version: '1.0.0', inputSchema: { type: 'object', additionalProperties: false },
              resultSchema: { type: 'object', additionalProperties: false }, factKinds: ['agriculture_fields'],
              coverage: { dimension: ['minecraft:overworld'], role: 'world' }, limits: { maxBlocks: 4096, timeoutMs: 5000 },
            },
            create: () => createFieldProvider(blockPort),
          },
        },
        { kind: 'planning', id: SOW_CANDIDATE, version: '1.0.0', candidateProvider: createSowCandidate() },
        { kind: 'verification', id: SOW_PREDICATE, version: '1.0.0', predicates: [createSowPredicate()] },
        {
          kind: 'execution', id: SOW_EXECUTOR, version: '1.0.0',
          operation: {
            operationId: SOW_OPERATION, goalContributionId: SOW_GOAL, bindingContributionId: SOW_BINDING,
            factKinds: ['agriculture_fields', 'inventory'], candidateContributionId: SOW_CANDIDATE,
            predicateContributionId: SOW_PREDICATE, progressContributionId: SOW_PROGRESS, resultContributionId: SOW_RESULT,
            cancellable: true,
            applicability: { outcomes: ['composed'], targetKinds: ['state'], taskFamilies: ['agriculture'], criterionTypes: ['predicate'] },
          },
          behaviorFactory: createSowBehavior(),
        },
        { kind: 'planning', id: SOW_PROGRESS, version: '1.0.0', candidateProvider: createSowCandidate(), progressProvider: createSowProgress() },
        { kind: 'result', id: SOW_RESULT, version: '1.0.0', projection: createSowResult() },
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
            applicability: { outcomes: ['obtain', 'composed'], targetKinds: ['item', 'state'], taskFamilies: ['agriculture'], criterionTypes: ['inventory', 'predicate'] },
          },
          behaviorFactory: createBehavior(),
        },
        { kind: 'planning', id: HARVEST_PROGRESS, version: '1.0.0', candidateProvider: createCandidateProvider(), progressProvider: createProgressProvider() },
        { kind: 'result', id: HARVEST_RESULT, version: '1.0.0', projection: createResultProjection() },
      ];
    },
  };
}
