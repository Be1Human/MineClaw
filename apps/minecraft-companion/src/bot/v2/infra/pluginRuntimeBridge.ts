/**
 * FEAT-CROSS-26-001-004-004 · runtime plugin-kernel bridge (P3-4 step 1).
 * The composition root boots the PluginHost from the committed generated index,
 * injecting production device/port capabilities as systemPorts. The published
 * Generation is the only discovery and resolution source used by the runtime.
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PluginHost } from '../plugin-kernel/index.js';
import { loadProductionBuiltinIndex } from '../plugin-kernel/productionIndex.js';
import { GenerationResolvers } from '../plugin-kernel/lifecycle.js';
import { GenerationCatalog } from '../plugin-kernel/catalog.js';
import type { PublishedGenerationSlot } from '../plugin-kernel/registration.js';
import type { GameView } from '../../adapter/GameAdapter.js';
import type {
  BoundedBlockObservationPort,
  BoundedInventoryObservationPort,
  OwnerContextObservationPort,
} from '../plugin-sdk/contracts/integration.js';
import type { FactKind, PluginObservationProviderFactory } from '../plugin-sdk/contracts/observation.js';
import type { WorldStateView } from '../types.js';
import type { ObservationCatalogPort } from '../decision/knowledgeQueryRunner.js';

export interface RuntimePluginKernelResult {
  readonly ok: boolean;
  readonly failures: readonly string[];
  readonly slot: PublishedGenerationSlot | null;
  readonly resolvers: GenerationResolvers | null;
  readonly catalog: GenerationCatalog | null;
  readonly installed: readonly string[];
}

export interface RuntimePluginKernelInput {
  readonly hostApiVersion?: string;
  readonly buildId?: string;
  readonly systemPorts?: Readonly<Record<string, unknown>>;
}

/** Live, read-only query projection over the currently published generation. */
export function createRuntimeObservationCatalog(
  getKernel: () => RuntimePluginKernelResult | null,
): ObservationCatalogPort {
  return Object.freeze({
    resolveProvider: (factKind: FactKind): readonly PluginObservationProviderFactory[] => {
      const kernel = getKernel();
      if (!kernel?.ok || !kernel.slot) return Object.freeze([]);
      const registry = kernel.slot.read().active.registry;
      const disabled = new Set(registry.disabledIds);
      const providers: PluginObservationProviderFactory[] = [];
      for (const id of registry.byKind.get('observation') ?? []) {
        if (disabled.has(id)) continue;
        const record = registry.byId.get(id);
        if (!record || record.contribution.kind !== 'observation') continue;
        if (record.contribution.factory.descriptor.factKinds.includes(factKind)) {
          providers.push(record.contribution.factory);
        }
      }
      return Object.freeze(providers);
    },
    listAvailableFactKinds: (): readonly FactKind[] => {
      const kernel = getKernel();
      if (!kernel?.ok || !kernel.slot) return Object.freeze([]);
      const registry = kernel.slot.read().active.registry;
      const disabled = new Set(registry.disabledIds);
      const kinds = new Set<FactKind>();
      for (const id of registry.byKind.get('observation') ?? []) {
        if (disabled.has(id)) continue;
        const record = registry.byId.get(id);
        if (!record || record.contribution.kind !== 'observation') continue;
        for (const kind of record.contribution.factory.descriptor.factKinds) kinds.add(kind);
      }
      return Object.freeze([...kinds].sort());
    },
  });
}

const KERNEL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'plugin-kernel');

/**
 * Boot the plugin kernel for the runtime. Never throws: callers receive one
 * explicit unavailable result and must fail closed instead of selecting an
 * alternate registry or legacy startup path.
 */
export async function buildRuntimePluginKernel(input: RuntimePluginKernelInput): Promise<RuntimePluginKernelResult> {
  try {
    const manifestPath = join(KERNEL_DIR, 'builtin-manifest.generated.json');
    const index = loadProductionBuiltinIndex({ manifestPath });
    const buildId = input.buildId ?? releasedPluginBuildId(manifestPath);
    const host = new PluginHost({
      hostApiVersion: input.hostApiVersion ?? '2.0.0',
      buildId,
      builtinIndex: index,
      trustedSystemPlugins: ['mineclaw.minecraft-system', 'mineclaw.storage-system', 'mineclaw.llm-system'],
      systemPorts: input.systemPorts,
    });
    const result = await host.boot();
    if (result.failures.length > 0) {
      return {
        ok: false,
        failures: result.failures.map(failure => `${failure.pluginId}: ${failure.code} ${failure.message}`),
        slot: null,
        resolvers: null,
        catalog: null,
        installed: result.installed,
      };
    }
    return {
      ok: true,
      failures: [],
      slot: result.slot,
      resolvers: new GenerationResolvers(result.slot),
      catalog: new GenerationCatalog(result.slot),
      installed: result.installed,
    };
  } catch (error) {
    return {
      ok: false,
      failures: [error instanceof Error ? error.message : String(error)],
      slot: null,
      resolvers: null,
      catalog: null,
      installed: [],
    };
  }
}

/** Stable for the same released plugin graph, different when its generated release manifest changes. */
function releasedPluginBuildId(manifestPath: string): string {
  const digest = createHash('sha256').update(readFileSync(manifestPath)).digest('hex').slice(0, 24);
  return `mineclaw-plugin-build-${digest}`;
}

/**
 * Read-only world observation ports synthesized from the Perception world
 * snapshot (P3-4 step 1). The port reports missing data explicitly: no world →
 * throw (caller surfaces unavailable); no pitch/raycast → structured
 * `unavailable` pointing. It never fabricates block/item state.
 */
export function createRuntimeObservationPorts(getWorld: () => WorldStateView | null, game?: GameView): {
  readonly block: BoundedBlockObservationPort;
  readonly inventory: BoundedInventoryObservationPort;
  readonly owner: OwnerContextObservationPort;
} {
  const block: BoundedBlockObservationPort = {
    observe: async input => {
      const world = getWorld();
      if (!world) throw new Error('world_unavailable');
      if (!game) throw new Error('block_observation_unavailable');
      if (input.signal.aborted) throw new Error('observation_cancelled');
      if (Date.now() >= input.deadlineAt) throw new Error('observation_deadline_exceeded');
      const requestedDimension = normalizeDimension(input.dimension);
      const actualDimension = normalizeDimension(game.getDimension());
      if (requestedDimension !== actualDimension) throw new Error('dimension_not_loaded');
      const radius = finitePositive(input.bounds.radius) ?? 1;
      const anchor = input.bounds.anchor as { kind?: string } | undefined;
      const origin = anchor?.kind === 'owner'
        ? world.owner?.position
        : world.self.position;
      if (!origin) throw new Error('anchor_unavailable');
      const names = input.blockFilter?.filter(Boolean) ?? [];
      if (names.length === 0) throw new Error('block_filter_required');
      const requestedCount = Math.max(1, Math.floor(input.maxBlocks));
      // Ask for one extra result so truncation is observable rather than guessed.
      const positions = game.findBlocks({
        names,
        maxDistance: radius,
        count: requestedCount + 1,
        origin,
      });
      const truncated = positions.length > requestedCount;
      const selected = positions.slice(0, requestedCount);
      const blocks = selected.flatMap(position => {
        const observed = game.getBlockAt(position);
        if (!observed) return [];
        return [{
          name: observed.name,
          position: { x: observed.position.x, y: observed.position.y, z: observed.position.z },
          properties: game.getBlockProperties(position) ?? {},
        }];
      });
      const bounds = Object.freeze({
        anchor: anchor?.kind ?? 'bot_self',
        origin: { x: origin.x, y: origin.y, z: origin.z },
        radius,
      });
      return {
        snapshotVersion: `world-tick-${world.tick}`,
        observedAt: new Date().toISOString(),
        dimension: world.environment.dimension,
        requestedBounds: input.bounds,
        observedBounds: bounds,
        blocks,
        unloadedRegions: [],
        complete: !truncated,
        truncated,
        evidenceRefs: [`world:tick:${world.tick}`, ...blocks.map((_, index) => `block:${index}`)],
      };
    },
  };

  const inventory: BoundedInventoryObservationPort = {
    observe: async input => {
      const world = getWorld();
      if (!world) throw new Error('world_unavailable');
      const items = world.inventory.items;
      const slots = items
        .slice(0, input.maxSlots)
        .map(item => ({
          slot: item.slot,
          itemId: item.name,
          count: item.count,
          ...(item.durability !== undefined ? { metadataHash: `${item.durability}/${item.maxDurability ?? '?'}` } : {}),
        }));
      return {
        snapshotVersion: 'v1',
        observedAt: new Date().toISOString(),
        subjectRef: input.subjectRef,
        slots,
        complete: items.length <= input.maxSlots,
        truncated: items.length > input.maxSlots,
        evidenceRefs: [`world:tick:${world.tick}`],
      };
    },
  };

  const owner: OwnerContextObservationPort = {
    observe: async input => {
      const world = getWorld();
      if (!world) throw new Error('world_unavailable');
      const ownerView = world.owner;
      if (!ownerView?.isVisible || ownerView.position === null || ownerView.entityId === null) {
        return {
          snapshotVersion: 'v1',
          observedAt: new Date().toISOString(),
          dimension: world.environment.dimension,
          botPosition: { x: world.self.position.x, y: world.self.position.y, z: world.self.position.z },
          ownerPosition: null,
          pointing: { kind: 'not_visible' },
          complete: true,
          evidenceRefs: [`world:tick:${world.tick}`],
        };
      }
      return {
        snapshotVersion: 'v1',
        observedAt: new Date().toISOString(),
        dimension: world.environment.dimension,
        botPosition: { x: world.self.position.x, y: world.self.position.y, z: world.self.position.z },
        ownerPosition: { x: ownerView.position.x, y: ownerView.position.y, z: ownerView.position.z },
        // OwnerView carries yaw only; without pitch/raycast the contract forbids
        // fabricating a direction — report the structured unavailable branch.
        pointing: { kind: 'unavailable', reason: 'server_does_not_provide_owner_pitch_or_raycast' },
        complete: true,
        evidenceRefs: [`world:tick:${world.tick}`, `entity:${ownerView.entityId}`],
      };
    },
  };

  return Object.freeze({ block, inventory, owner });
}

function normalizeDimension(value: string): string {
  return value.startsWith('minecraft:') ? value.slice('minecraft:'.length) : value;
}

function finitePositive(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}
