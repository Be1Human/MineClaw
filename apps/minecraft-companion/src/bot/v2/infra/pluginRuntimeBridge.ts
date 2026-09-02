/**
 * FEAT-CROSS-26-001-004-004 · runtime plugin-kernel bridge (P3-4 step 1).
 * The composition root boots the PluginHost from the committed generated index,
 * injecting production device/port capabilities as systemPorts. Until the
 * one-shot switch, failures are surfaced (bus event) without blocking the
 * legacy startup path; the published slot/catalog/resolvers are exposed for
 * the switch commit.
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PluginHost } from '../plugin-kernel/index.js';
import { loadProductionBuiltinIndex } from '../plugin-kernel/productionIndex.js';
import { GenerationResolvers } from '../plugin-kernel/lifecycle.js';
import { GenerationCatalog } from '../plugin-kernel/catalog.js';
import type { PublishedGenerationSlot } from '../plugin-kernel/registration.js';
import type { BoundedInventoryObservationPort, OwnerContextObservationPort } from '../plugin-sdk/contracts/integration.js';
import type { WorldStateView } from '../types.js';

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

const KERNEL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'plugin-kernel');

/**
 * Boot the plugin kernel for the runtime (P3-4 step 1). Never throws: returns a
 * structured result so callers can surface failures and keep legacy startup.
 */
export async function buildRuntimePluginKernel(input: RuntimePluginKernelInput): Promise<RuntimePluginKernelResult> {
  try {
    const index = loadProductionBuiltinIndex({ manifestPath: join(KERNEL_DIR, 'builtin-manifest.generated.json') });
    const host = new PluginHost({
      hostApiVersion: input.hostApiVersion ?? '2.0.0',
      buildId: input.buildId ?? `runtime-${process.pid}`,
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

/**
 * Read-only world observation ports synthesized from the Perception world
 * snapshot (P3-4 step 1). The port reports missing data explicitly: no world →
 * throw (caller surfaces unavailable); no pitch/raycast → structured
 * `unavailable` pointing. It never fabricates block/item state.
 */
export function createRuntimeObservationPorts(getWorld: () => WorldStateView | null): {
  readonly inventory: BoundedInventoryObservationPort;
  readonly owner: OwnerContextObservationPort;
} {
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

  return Object.freeze({ inventory, owner });
}
