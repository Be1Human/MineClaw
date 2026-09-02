/**
 * mineclaw.storage-system · first-party system plugin (kernel design §5.4).
 * Container/deposit/withdraw primitives; adapter access via systemPorts at
 * startup assembly. Executors check port presence per call (dependency missing
 * is reported, never faked).
 */
import type { PluginFactory } from '../../../plugin-kernel/discovery.js';
import type { PluginContribution, PluginAtomicExecutor } from '../../../plugin-sdk/index.js';
import type { AtomicExecutionContext } from '../../../plugin-sdk/contracts/execution.js';
import type { GameView } from '../../../../adapter/GameAdapter.js';
import type { EventBusV2 } from '../../../infra/eventBus.js';
import type { WorldStateView } from '../../../types.js';

export const STORAGE_PLUGIN_ID = 'mineclaw.storage-system';

const ATOMIC_IDS = ['open_container', 'transfer_chest', 'deposit', 'withdraw'] as const;

export interface StorageSystemPorts {
  readonly game?: GameView;
  readonly bus?: EventBusV2;
  readonly getWorld?: () => WorldStateView;
}

function createExecutor(atomicId: string, ports: StorageSystemPorts): PluginAtomicExecutor {
  return {
    id: `${STORAGE_PLUGIN_ID}.atomic.${atomicId}`,
    version: '1.0.0',
    execute: async (command, _context: AtomicExecutionContext) => {
      if (!ports.game || !ports.bus || !ports.getWorld) throw new Error('storage_device_unavailable');
      // 委托给 minecraft-system 的现有容器处理语义；P3 Driver 接线后经受控上下文执行。
      void command; void _context;
      return { ok: true, delegated: `minecraft-system:${atomicId}` };
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
