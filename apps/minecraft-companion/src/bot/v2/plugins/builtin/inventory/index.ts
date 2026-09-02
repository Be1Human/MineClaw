/**
 * mineclaw.inventory · first-party domain plugin (kernel design §5.3).
 * Emits the versioned owner-inventory Fact by consuming the bounded inventory
 * observation port published by mineclaw.minecraft-system; lacks the ability to
 * grant any execution right.
 */
import type { PluginFactory } from '../../../plugin-kernel/discovery.js';
import type { PluginContribution } from '../../../plugin-sdk/index.js';
import type { BoundedInventoryObservationPort } from '../../../plugin-sdk/contracts/integration.js';
import type { PluginObservationProvider } from '../../../plugin-sdk/contracts/observation.js';
import type { ContributionRef } from '../../../plugin-sdk/identity.js';

export const INVENTORY_PLUGIN_ID = 'mineclaw.inventory';
export const INVENTORY_FACT = 'mineclaw.inventory.observation.owner-inventory';
const SERVICE_KEY = 'bounded.inventory.observation';

function createInventoryProvider(port: BoundedInventoryObservationPort | undefined, identity: ContributionRef): PluginObservationProvider {
  return {
    id: INVENTORY_FACT,
    observe: async (input) => {
      if (!port) return { status: 'unavailable', reason: 'service_missing:bounded.inventory.observation' };
      if (input.signal.aborted) return { status: 'cancelled' };
      try {
        const observed = await port.observe({
          subjectRef: 'owner',
          maxSlots: 64,
          deadlineAt: Date.now() + input.budget.timeoutMs,
          signal: input.signal,
        });
        return {
          status: 'fulfilled',
          fact: {
            factKind: 'inventory',
            snapshotVersion: observed.snapshotVersion,
            observedAt: observed.observedAt,
            requestedBounds: { subjectRef: 'owner' },
            observedBounds: { subjectRef: observed.subjectRef },
            complete: observed.complete,
            truncated: observed.truncated,
            unloadedRegions: [],
            payload: {
              slots: observed.slots.map(slot => ({ slot: slot.slot, itemId: slot.itemId, count: slot.count })),
              complete: observed.complete,
              truncated: observed.truncated,
            },
            evidenceRefs: observed.evidenceRefs.map(ref => ({ ref, source: 'mineclaw.minecraft-system', at: observed.observedAt })),
            contribution: identity,
          },
        };
      } catch {
        return { status: 'unavailable', reason: 'inventory_observation_failed' };
      }
    },
    close: () => undefined,
  };
}

export function createMineclawInventoryPlugin(): PluginFactory {
  return {
    entryKey: `plugins/builtin/${INVENTORY_PLUGIN_ID}`,
    create: (context): readonly PluginContribution[] => {
      const services = context.services ?? {};
      const port = services[SERVICE_KEY] as BoundedInventoryObservationPort | undefined;
      const identity: ContributionRef = {
        pluginId: INVENTORY_PLUGIN_ID,
        pluginVersion: '1.0.0',
        contributionId: INVENTORY_FACT,
        contributionVersion: '1.0.0',
      };
      const target = {
        registryId: 'mineclaw.inventory.goal.item-available',
        goalKind: 'item' as const,
        aliases: ['材料', '资源', '物资', '工具'],
        successCriteria: [{ type: 'inventory' as const, item: '$item', count: '$count' }],
      };
      return [
        {
          kind: 'observation',
          id: INVENTORY_FACT,
          version: '1.0.0',
          factory: {
            id: INVENTORY_FACT,
            version: '1.0.0',
            descriptor: {
              id: INVENTORY_FACT,
              version: '1.0.0',
              inputSchema: { type: 'object', additionalProperties: false },
              resultSchema: { type: 'object', additionalProperties: false },
              factKinds: ['inventory'],
              coverage: { dimension: ['minecraft:overworld'], role: 'owner' },
              limits: { maxSlots: 64, timeoutMs: 5000 },
            },
            create: () => createInventoryProvider(port, identity),
          },
        },
        { kind: 'goal', id: 'mineclaw.inventory.goal.item-available', version: '1.0.0', target },
      ];
    },
  };
}
