/**
 * mineclaw.storage-system · first-party system plugin (kernel design §5.4).
 * Container primitives; adapter access injected via systemPorts at startup
 * assembly. Executors check ports per call and report missing dependency —
 * never a fake `delegated` success. deposit/withdraw execute the real
 * GameActions chest operations; open_container/transfer_chest are NOT dispatch
 * primitives (no device operation exists under those names) and are
 * intentionally absent — container flows submit deposit/withdraw.
 */
import type { PluginFactory } from '../../../plugin-kernel/discovery.js';
import type { PluginContribution, PluginAtomicExecutor } from '../../../plugin-sdk/index.js';
import type { AtomicExecutionContext } from '../../../plugin-sdk/contracts/execution.js';
import type { GameView } from '../../../../adapter/GameAdapter.js';
import type { GameActions } from '../../../../adapter/GameActions.js';
import type { EventBusV2 } from '../../../infra/eventBus.js';
import type { WorldStateView } from '../../../types.js';

export const STORAGE_PLUGIN_ID = 'mineclaw.storage-system';

const ATOMIC_IDS = ['deposit', 'withdraw'] as const;

export interface StorageSystemPorts {
  readonly game?: GameView;
  readonly actions?: GameActions;
  readonly bus?: EventBusV2;
  readonly getWorld?: () => WorldStateView;
}

function createExecutor(atomicId: string, ports: StorageSystemPorts): PluginAtomicExecutor {
  return {
    id: `${STORAGE_PLUGIN_ID}.atomic.${atomicId}`,
    version: '1.0.0',
    execute: async (command, context: AtomicExecutionContext) => {
      if (!ports.game || !ports.actions || !ports.bus || !ports.getWorld) {
        throw new Error('storage_device_unavailable');
      }
      const target = (command.request.target ?? {}) as { position?: { x: number; y: number; z: number }; itemName?: string; count?: number };
      const pos = target.position;
      const itemName = target.itemName;
      if (!pos || !itemName) throw new Error(`${atomicId} requires target.position and target.itemName`);
      const count = target.count ?? 64;
      const result = atomicId === 'deposit'
        ? await ports.actions.depositToChest(pos, itemName, count)
        : await ports.actions.withdrawFromChest(pos, itemName, count);
      if (!result.ok) return { ok: false, error: `${atomicId}_failed:${result.reason}` };
      ports.bus.publish(`atomic.${atomicId}.success`, 'info', {
        source: command.source, item: itemName, moved: result.moved, pos, ...(result.contents ? { contents: result.contents } : {}),
      });
      return { ok: true, moved: result.moved };
    },
  };
}

export function createMineclawStorageSystemPlugin(): PluginFactory {
  return {
    entryKey: `plugins/builtin/${STORAGE_PLUGIN_ID}`,
    create: (context): readonly PluginContribution[] => {
      const ports = (context.systemPorts ?? {}) as StorageSystemPorts;
      const atomicCatalog = ATOMIC_IDS.map(atomicId => ({
        atomicId,
        version: '1.0.0',
        executor: createExecutor(atomicId, ports),
      }));
      return [
        {
          kind: 'execution',
          id: `${STORAGE_PLUGIN_ID}.execution.container`,
          version: '1.0.0',
          atomicCatalog,
        },
        {
          kind: 'integration',
          id: `${STORAGE_PLUGIN_ID}.integration.chest`,
          version: '1.0.0',
          integration: {
            id: `${STORAGE_PLUGIN_ID}.integration.chest`,
            version: '1.0.0',
            start: async (): Promise<void> => undefined,
            stop: async (): Promise<void> => undefined,
            status: (): 'running' | 'stopped' => 'running',
          },
        },
      ];
    },
  };
}
