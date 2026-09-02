import type { GameAdapter } from '../../../adapter/GameAdapter.js';
import type { BoundGameActions } from '../../../adapter/GameActions.js';
import type { NavigationAdapter } from '../../../adapter/NavigationAdapter.js';
import type { BoundNavigation } from '../../../adapter/NavigationExecution.js';
import type { IBehaviorRegistry } from '../../behavior/types.js';
import { BehaviorRunner } from '../../behavior/behaviorRunner.js';
import { createDefaultAtomicContractRegistry } from '../../atomic/contracts/defaultContracts.js';
import { executeAtomic } from '../../atomic/atomics.js';
import type { EventBusV2 } from '../../infra/eventBus.js';
import type { WorldStateView } from '../../types.js';
import { DoorMonitor } from '../../strategy/doorMonitor.js';
import { StuckMonitor } from '../../strategy/stuckMonitor.js';
import type { OperationCommand, OperationIdentity } from '../contracts/bodyOperation.js';
import type { BodyOperationDriver, BoundOperationExecutor } from './ports/controlledExecution.js';
import { atomicRequest } from './actionCommand.js';
import { failureFromLegacy } from './failureEnvelope.js';

/** Registered programs consume one body lease. They cannot acquire another physical owner. */
export class GameBodyDriver implements BodyOperationDriver {
  private readonly contracts = createDefaultAtomicContractRegistry();
  private readonly behaviors: BehaviorRunner;
  constructor(private readonly deps: {
    game: GameAdapter; nav: NavigationAdapter; registry: IBehaviorRegistry;
    bus: EventBusV2; getWorld(): WorldStateView;
  }) { this.behaviors = new BehaviorRunner(deps); }

  accepts(command: OperationCommand): boolean {
    if (command.ref.version !== '1') return false;
    if (command.ref.id.startsWith('behavior:')) return !!this.deps.registry.get(command.ref.id.slice(9));
    if (!command.ref.id.startsWith('atomic:')) return false;
    const id = command.ref.id.slice(7);
    return !['invoke_behavior','stop','stop_follow'].includes(id) && !!this.contracts.get(id);
  }

  resources(command: OperationCommand): readonly string[] {
    if (!this.accepts(command)) throw new Error(`body_command_not_registered:${command.ref.id}`);
    // Walking, hands, view direction and inventory are coupled by the Minecraft protocol.
    // Independent resources can be added only by a driver with an actual independent device.
    return ['minecraft:body'];
  }

  bind(_identity: OperationIdentity, command: OperationCommand): BoundOperationExecutor {
    this.resources(command);
    let game: BoundGameActions | undefined;
    let nav: BoundNavigation | undefined;
    let stopped = false;
    return {
      run: async context => {
        context.assertCurrent('driver-bind');
        if (stopped) throw new Error('driver_binding_stopped');
        if (command.ref.id.startsWith('behavior:')) {
          const definition = this.deps.registry.get(command.ref.id.slice(9));
          if (!definition) throw new Error('behavior_definition_removed');
          return this.behaviors.run(definition,context);
        }
        const request = atomicRequest(command,context);
        game = this.deps.game.bind(context);
        const doors = new DoorMonitor(game.view,game.actions,context,this.deps.bus);
        const stuck = new StuckMonitor(game.view,game.actions,context,this.deps.bus);
        nav = this.deps.nav.bind({scope:context,game,maintain:async actions => {
          await doors.tick(actions); context.assertCurrent('navigation-after-door');
          await stuck.tick(actions);
        }});
        const result = await executeAtomic(request,{
          game:game.view,actions:game.actions,nav:nav.actions,bus:this.deps.bus,
          execution:context,getWorld:this.deps.getWorld,
        });
        return {ok:result.ok,...(!result.ok ? {failure:failureFromLegacy(result.error)} : {})};
      },
      stop: async reason => {
        stopped = true;
        const results = await Promise.allSettled([game?.stop(reason),nav?.stop(reason)]);
        const errors = results.flatMap(value => value.status==='rejected' ? [value.reason] : []);
        if (errors.length) throw new AggregateError(errors,'body_driver_cleanup_failed');
      },
    };
  }
}
