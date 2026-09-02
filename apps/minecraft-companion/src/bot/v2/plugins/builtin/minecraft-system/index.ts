/**
 * mineclaw.minecraft-system · first-party system plugin (kernel design §5.3).
 * Owns the primitive atomic catalog and the read-only world ports; adapter
 * access is injected at startup through PluginConstructionContext.systemPorts.
 */
import { executeAtomic } from '../../../atomic/atomics.js';
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

const ATOMIC_IDS = [
  'say', 'move_to', 'follow_entity', 'equip', 'place_block', 'dig', 'attack',
  'touch', 'open_container', 'transfer_chest', 'toss', 'pickup', 'use_item', 'sleep',
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
      const atomicCatalog = ATOMIC_IDS.map(atomicId => ({ atomicId, version: '1.0.0', executor: createAtomicExecutor(atomicId, ports) }));
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
  const block: BoundedBlockObservationPort = {
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
