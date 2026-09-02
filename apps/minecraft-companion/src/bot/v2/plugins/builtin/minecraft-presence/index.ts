/**
 * mineclaw.minecraft-presence · first-party domain plugin (kernel design §5.3).
 * Owner-context fact: bot/owner position, dimension, observedAt and a closed
 * pointing union (`observed | unavailable | not_visible`). When the server
 * cannot provide pitch/raycast the fact returns the structured unavailable
 * branch explicitly — it is a REQUIRED base fact for agriculture binding, not an
 * optional dependency.
 */
import type { PluginFactory } from '../../../plugin-kernel/discovery.js';
import type { PluginContribution } from '../../../plugin-sdk/index.js';
import type { OwnerContextObservationPort } from '../../../plugin-sdk/contracts/integration.js';
import type { PluginObservationProvider } from '../../../plugin-sdk/contracts/observation.js';
import type { ContributionRef } from '../../../plugin-sdk/identity.js';

export const PRESENCE_PLUGIN_ID = 'mineclaw.minecraft-presence';
export const OWNER_CONTEXT_FACT = `${PRESENCE_PLUGIN_ID}.observation.owner-context`;
const SERVICE_KEY = 'context.owner';

function createProvider(port: OwnerContextObservationPort | undefined, identity: ContributionRef): PluginObservationProvider {
  return {
    id: OWNER_CONTEXT_FACT,
    observe: async (input) => {
      if (!port) return { status: 'unavailable', reason: 'service_missing:context.owner' };
      if (input.signal.aborted) return { status: 'cancelled' };
      try {
        const observed = await port.observe({ subjectRef: 'owner', signal: input.signal });
        return {
          status: 'fulfilled',
          fact: {
            factKind: 'owner_location',
            snapshotVersion: observed.snapshotVersion,
            observedAt: observed.observedAt,
            requestedBounds: { subjectRef: 'owner' },
            observedBounds: { subjectRef: 'owner', dimension: observed.dimension },
            complete: observed.complete,
            truncated: false,
            unloadedRegions: [],
            payload: {
              botPosition: observed.botPosition,
              ownerPosition: observed.ownerPosition,
              dimension: observed.dimension,
              pointing: observed.pointing,
              selfLocation: {
                factKind: 'self_location' as const,
                position: observed.botPosition,
                dimension: observed.dimension,
              },
            },
            evidenceRefs: observed.evidenceRefs.map(ref => ({ ref, source: PRESENCE_PLUGIN_ID, at: observed.observedAt })),
            contribution: identity,
          },
        };
      } catch {
        return { status: 'unavailable', reason: 'owner_context_failed' };
      }
    },
    close: () => undefined,
  };
}

export function createMineclawMinecraftPresencePlugin(): PluginFactory {
  return {
    entryKey: `plugins/builtin/${PRESENCE_PLUGIN_ID}`,
    create: (context): readonly PluginContribution[] => {
      const services = context.services ?? {};
      const port = services[SERVICE_KEY] as OwnerContextObservationPort | undefined;
      const identity: ContributionRef = {
        pluginId: PRESENCE_PLUGIN_ID,
        pluginVersion: '1.0.0',
        contributionId: OWNER_CONTEXT_FACT,
        contributionVersion: '1.0.0',
      };
      return [
        {
          kind: 'observation',
          id: OWNER_CONTEXT_FACT,
          version: '1.0.0',
          factory: {
            id: OWNER_CONTEXT_FACT,
            version: '1.0.0',
            descriptor: {
              id: OWNER_CONTEXT_FACT,
              version: '1.0.0',
              inputSchema: { type: 'object', additionalProperties: false },
              resultSchema: { type: 'object', additionalProperties: false },
              factKinds: ['owner_location', 'self_location'],
              coverage: { dimension: ['minecraft:overworld'], role: 'owner' },
              limits: { timeoutMs: 3000 },
            },
            create: () => createProvider(port, identity),
          },
        },
      ];
    },
  };
}
