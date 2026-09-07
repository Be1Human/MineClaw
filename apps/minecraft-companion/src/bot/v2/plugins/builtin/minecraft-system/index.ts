/**
 * mineclaw.minecraft-system · first-party system plugin (kernel design §5.3).
 * Owns the primitive atomic catalog and the read-only world ports; adapter
 * access is injected at startup through PluginConstructionContext.systemPorts.
 */
import { executeAtomic } from '../../../atomic/atomics.js';
import { buildSystemAtomicContracts, type AtomicContractEntry } from './atomicContracts.js';
import { minecraftGoalContributions } from './goalTargets.js';
import type { PluginFactory } from '../../../plugin-kernel/discovery.js';
import type { PluginContribution } from '../../../plugin-sdk/index.js';
import type { AtomicExecutionContext, PluginBehaviorFactory, PluginBehaviorInstance, PluginBehaviorResult } from '../../../plugin-sdk/contracts/execution.js';
import type { ContributionRef, PluginGoalLease } from '../../../plugin-sdk/identity.js';
import type {
  BoundedBlockObservationPort,
  BoundedInventoryObservationPort,
  OwnerContextObservationPort,
} from '../../../plugin-sdk/contracts/integration.js';
import type { ActionRequest, WorldStateView } from '../../../types.js';
import type { GameAdapter } from '../../../../adapter/GameAdapter.js';
import type { NavigationAdapter } from '../../../../adapter/NavigationAdapter.js';
import type { EventBusV2 } from '../../../infra/eventBus.js';
import { DoorMonitor } from '../../../strategy/doorMonitor.js';
import { StuckMonitor } from '../../../strategy/stuckMonitor.js';

export const MINECRAFT_SYSTEM_PLUGIN_ID = 'mineclaw.minecraft-system';
export const ADVANCED_MOVE_TO_BEHAVIOR_ID = 'advanced_move_to';

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
  'place_scaffold', 'mount', 'dismount', 'vehicle_goto', 'combat_round',
  'block_with_shield', 'bow_shoot', 'crit_jump_attack',
] as const;

export interface MineclawSystemPorts {
  readonly game?: GameAdapter;
  readonly nav?: NavigationAdapter;
  readonly bus?: EventBusV2;
  readonly getWorld?: () => WorldStateView;
  readonly blockObservation?: BoundedBlockObservationPort;
  readonly inventoryObservation?: BoundedInventoryObservationPort;
  readonly ownerContextObservation?: OwnerContextObservationPort;
}

function systemRef(): ContributionRef {
  return {
    pluginId: MINECRAFT_SYSTEM_PLUGIN_ID,
    pluginVersion: '1.0.0',
    contributionId: `${MINECRAFT_SYSTEM_PLUGIN_ID}.execution.atomics`,
    contributionVersion: '1.0.0',
  };
}

/**
 * A Behavior-level route recovery program.  `move_to` remains a single
 * physical navigation primitive; this program owns the decision of when a
 * failed direct route may safely retry as free-motion + XZ transfer and when
 * to return to a precise endpoint.  It therefore works for every domain
 * plugin without teaching those plugins about water, shoreline or elevation.
 */
export function createAdvancedMoveToBehavior(): PluginBehaviorFactory {
  return {
    id: ADVANCED_MOVE_TO_BEHAVIOR_ID,
    version: '1.0.0',
    create: (lease: PluginGoalLease): PluginBehaviorInstance => {
      let halted = false;
      const instanceId = `advanced-move-to-${lease.goalId}-${lease.operationEpoch}`;
      const cancelled = (): PluginBehaviorResult => ({ ok: false, cancelled: true, error: 'advanced_move_to_cancelled' });
      return {
        instanceId,
        contribution: systemRef(),
        kind: 'adaptive',
        run: async ctx => {
          if (halted || ctx.signal.aborted) return cancelled();
          const position = asPosition(ctx.params.position);
          if (!position) return { ok: false, cancelled: false, error: 'advanced_move_to_requires_position' };
          const range = validRange(ctx.params.range);
          const normalArgs = { position, ...(range === undefined ? {} : { range }) };
          const direct = await ctx.submitBody({ atomicId: 'move_to', args: normalArgs });
          if (direct.ok !== false) return { ok: true, cancelled: false, details: { route: 'direct' } };
          if (halted || ctx.signal.aborted) return cancelled();
          if (!isNoPath(direct)) {
            return { ok: false, cancelled: false, error: bodyError(direct), details: { route: 'direct' } };
          }

          ctx.publish('advanced_move_to.recovery_started', 'warn', { target: position, reason: bodyError(direct) });
          const horizontal = await ctx.submitBody({
            atomicId: 'move_to',
            args: { position, navigationGoal: 'xz', navigationProfile: 'recovery' },
          });
          if (horizontal.ok === false) {
            // Some shorelines have no graph edge even with free motion.  The
            // generic `walk` primitive owns a bounded, water-safe physical
            // push (forward + swim/jump pulses); it is still a child action in
            // this same body lease, never a detached activity-side workaround.
            if (!isNoPath(horizontal)) {
              return { ok: false, cancelled: false, error: bodyError(horizontal), details: { route: 'recovery_xz' } };
            }
            const push = await ctx.submitBody({ atomicId: 'walk', args: { position, durationMs: 6000 } });
            if (push.ok === false) {
              return { ok: false, cancelled: false, error: bodyError(push), details: { route: 'physical_push' } };
            }
            if (halted || ctx.signal.aborted) return cancelled();
            const afterPush = await ctx.submitBody({
              atomicId: 'move_to',
              args: { position, navigationGoal: 'xz', navigationProfile: 'recovery' },
            });
            if (afterPush.ok === false) {
              return { ok: false, cancelled: false, error: bodyError(afterPush), details: { route: 'physical_push_then_recovery_xz' } };
            }
          }
          if (halted || ctx.signal.aborted) return cancelled();

          const precise = await ctx.submitBody({
            atomicId: 'move_to',
            args: { ...normalArgs, navigationProfile: 'recovery' },
          });
          return precise.ok !== false
            ? { ok: true, cancelled: false, details: { route: 'recovery_xz_then_precise' } }
            : { ok: false, cancelled: false, error: bodyError(precise), details: { route: 'recovery_precise' } };
        },
        halt: async () => { halted = true; },
        close: async () => { halted = true; },
        get settled(): boolean { return halted; },
      };
    },
  };
}

function asPosition(value: unknown): Readonly<{ x: number; y: number; z: number }> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const position = value as Record<string, unknown>;
  return typeof position.x === 'number' && Number.isFinite(position.x)
    && typeof position.y === 'number' && Number.isFinite(position.y)
    && typeof position.z === 'number' && Number.isFinite(position.z)
    ? Object.freeze({ x: position.x, y: position.y, z: position.z })
    : null;
}

function validRange(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 8 ? value : undefined;
}

function bodyError(receipt: Readonly<Record<string, unknown>>): string {
  return typeof receipt.error === 'string' && receipt.error ? receipt.error : 'advanced_move_to_child_failed';
}

function isNoPath(receipt: Readonly<Record<string, unknown>>): boolean {
  return /(?:no[_ ]?path|nopath|target_not_reached)/i.test(bodyError(receipt));
}

export function createSystemAtomicExecutor(atomicId: string, ports: MineclawSystemPorts) {
  return {
    id: `${MINECRAFT_SYSTEM_PLUGIN_ID}.atomic.${atomicId}`,
    version: '1.0.0',
    execute: async (command: { request: Readonly<Record<string, unknown>>; source: string }, context: AtomicExecutionContext) => {
      if (!ports.game || !ports.nav || !ports.bus || !ports.getWorld) {
        throw new Error('atomic_device_unavailable');
      }
      const game = ports.game.bind(context);
      context.registerCleanup(reason => game.stop(reason));
      const doors = new DoorMonitor(game.view, game.actions, context, ports.bus);
      const stuck = new StuckMonitor(game.view, game.actions, context, ports.bus);
      const nav = ports.nav.bind({
        scope: context,
        game,
        maintain: async actions => {
          await doors.tick(actions);
          context.assertCurrent('navigation-after-door');
          await stuck.tick(actions);
        },
      });
      context.registerCleanup(reason => nav.stop(reason));
      const request = { ...command.request, type: atomicId, source: command.source } as ActionRequest;
      const result = await executeAtomic(request, {
        game: game.view,
        actions: game.actions,
        nav: nav.actions,
        bus: ports.bus,
        getWorld: ports.getWorld,
        execution: {
          assertCurrent: (reason: string) => context.assertCurrent(reason),
          wait: (ms: number) => context.wait(ms),
          signal: context.signal,
          effect: <T>(run: () => T | PromiseLike<T>) => context.effect(run),
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
        executor: createSystemAtomicExecutor(atomicId, ports),
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
        ...minecraftGoalContributions(),
        {
          kind: 'execution',
          id: `${MINECRAFT_SYSTEM_PLUGIN_ID}.execution.atomics`,
          version: '1.0.0',
          atomicCatalog,
          behaviorFactory: createAdvancedMoveToBehavior(),
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
