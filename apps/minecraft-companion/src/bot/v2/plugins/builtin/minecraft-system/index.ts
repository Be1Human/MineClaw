/**
 * mineclaw.minecraft-system · first-party system plugin (kernel design §5.3).
 * Owns the primitive atomic catalog and the read-only world ports; adapter
 * access is injected at startup through PluginConstructionContext.systemPorts.
 */
import { executeAtomic } from '../../../atomic/atomics.js';
import { buildSystemAtomicContracts, type AtomicContractEntry } from './atomicContracts.js';
import type { PluginFactory } from '../../../plugin-kernel/discovery.js';
import type { PluginContribution } from '../../../plugin-sdk/index.js';
import type { AtomicExecutionContext } from '../../../plugin-sdk/contracts/execution.js';
import type {
  BoundedBlockObservationPort,
  BoundedInventoryObservationPort,
  OwnerContextObservationPort,
} from '../../../plugin-sdk/contracts/integration.js';
import type { ActionRequest, WorldStateView } from '../../../types.js';
import type { GameView } from '../../../../adapter/GameAdapter.js';
import type { GameActions } from '../../../../adapter/GameActions.js';
import type { NavigationActions } from '../../../../adapter/NavigationExecution.js';
import type { EventBusV2 } from '../../../infra/eventBus.js';

export const MINECRAFT_SYSTEM_PLUGIN_ID = 'mineclaw.minecraft-system';

/**
 * Primitive catalog = the exact set dispatch() executes in atomic/atomics.ts
 * (P3-4 switch precondition). open_container/transfer_chest/touch/toss/pickup
 * are not dispatch types (deposit/withdraw live here; toss_item is the real
 * toss primitive) — a catalog entry that never dispatches would be a fake
 * success, so these stay out.
 */
const ATOMIC_IDS = [
  'say', 'move_to', 'goto_position', 'follow_entity', 'attack', 'use_tool',
  'equip', 'place_block', 'dig', 'craft', 'smelt', 'walk', 'escape_pit',
  'mine_to', 'look_at', 'toss_item', 'eat', 'sleep', 'wake', 'deposit',
  'withdraw', 'equip_best_armor', 'fish', 'climb_up', 'pillar_up', 'dig_down',
  'place_scaffold', 'mount', 'dismount', 'vehicle_goto', 'kite',
  'block_with_shield', 'bow_shoot', 'crit_jump_attack',
] as const;

export interface MineclawSystemPorts {
  readonly game?: GameView & GameActions;
  readonly nav?: NavigationActions;
  readonly bus?: EventBusV2;
  readonly getWorld?: () => WorldStateView;
  readonly blockObservation?: BoundedBlockObservationPort;
  readonly inventoryObservation?: BoundedInventoryObservationPort;
  readonly ownerContextObservation?: OwnerContextObservationPort;
}
function createAtomicExecutor(atomicId: string, ports: MineclawSystemPorts) {
  return {
    id: `${MINECRAFT_SYSTEM_PLUGIN_ID}.atomic.${atomicId}`,
    version: '1.0.0',
    execute: async (command: { request: Readonly<Record<string, unknown>>; source: string }, context: AtomicExecutionContext) => {
      if (!ports.game || !ports.nav || !ports.bus || !ports.getWorld) {
        throw new Error('atomic_device_unavailable');
      }
      const request = { ...command.request, type: atomicId, source: command.source } as ActionRequest;
      const result = await executeAtomic(request, {
        game: ports.game,
        actions: ports.game,
        nav: ports.nav,
        bus: ports.bus,
        getWorld: ports.getWorld,
        execution: {
          assertCurrent: (reason: string) => context.assertCurrent(reason),
          wait: (ms: number) => context.wait(ms),
        } as never,
      });
      return { ok: result.ok ?? true, ...(result.error ? { error: result.error } : {}) };
    },
  };
}

export function createMineclawMinecraftSystemPlugin(): PluginFactory {
  return {
    entryKey: `plugins/builtin/${MINECRAFT_SYSTEM_PLUGIN_ID}`,
    create: (context): readonly PluginContribution[] => {
      const ports = (context.systemPorts ?? {}) as MineclawSystemPorts;
      const contracts = buildSystemAtomicContracts(ATOMIC_IDS);
      const atomicCatalog: AtomicContractEntry[] = ATOMIC_IDS.map((atomicId, index) => ({
        atomicId,
        version: '1.0.0',
        executor: createAtomicExecutor(atomicId, ports),
        contract: contracts[index],
      }));
      const bounded = createBoundedObservationPorts(ports);
      const integration = {
        id: `${MINECRAFT_SYSTEM_PLUGIN_ID}.integration.game`,
        version: '1.0.0',
        integration: {
          id: `${MINECRAFT_SYSTEM_PLUGIN_ID}.integration.game`,
          version: '1.0.0',
          start: async (): Promise<void> => undefined,
          stop: async (): Promise<void> => undefined,
          status: (): 'running' | 'stopped' => 'running',
          services: Object.freeze({
            'bounded.block.observation': bounded.block,
            'bounded.inventory.observation': bounded.inventory,
            ...(ports.ownerContextObservation ? { 'context.owner': ports.ownerContextObservation } : {}),
          }),
        },
      };
      return [
        {
          kind: 'execution',
          id: `${MINECRAFT_SYSTEM_PLUGIN_ID}.execution.atomics`,
          version: '1.0.0',
          atomicCatalog,
        },
        { kind: 'integration', ...integration },
      ];
    },
  };
}

/** Read-only world ports exposed through the system ports (kernel design §5.3). */
export function createBoundedObservationPorts(ports: MineclawSystemPorts): {
  block: BoundedBlockObservationPort;
  inventory: BoundedInventoryObservationPort;
} {
  const block: BoundedBlockObservationPort = ports.blockObservation ?? {
    observe: async (input) => {
      if (!ports.getWorld) throw new Error('world_unavailable');
      void input;
      const world = ports.getWorld();
      return {
        snapshotVersion: 'v1',
        observedAt: new Date().toISOString(),
        dimension: world.environment.dimension,
        requestedBounds: input.bounds,
        observedBounds: input.bounds,
        blocks: [],
        unloadedRegions: [],
        complete: true,
        truncated: false,
        evidenceRefs: [],
      };
    },
  };
  const inventory: BoundedInventoryObservationPort = ports.inventoryObservation ?? {
    observe: async (input) => {
      void input;
      return {
        snapshotVersion: 'v1',
        observedAt: new Date().toISOString(),
        subjectRef: input.subjectRef,
        slots: [],
        complete: true,
        truncated: false,
        evidenceRefs: [],
      };
    },
  };
  return { block, inventory };
}
