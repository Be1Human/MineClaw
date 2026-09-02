import { EventEmitter } from 'node:events';
import type { Bot } from 'mineflayer';
import type { NavGoal, NavigationAdapter } from '../adapter/NavigationAdapter.js';
import type { BoundNavigation, NavigationBindingInput } from '../adapter/NavigationExecution.js';
import type { MovementOptions, Unsubscribe, Vec3 } from '../adapter/types.js';
import { MineflayerNavigationSession } from './MineflayerNavigationSession.js';

/** Live navigation observations plus a fixed-device binding factory. Never owns a second movement lock. */
export class MineflayerNavigationAdapter implements NavigationAdapter {
  private readonly events = new EventEmitter();
  private options: MovementOptions = { canDig: false };
  private current: { bot: Bot; session: MineflayerNavigationSession } | null = null;

  constructor(private readonly getBot: () => Bot | null, private readonly log: (message: string) => void = () => {}) {}

  rebindSubscriptions(bot: Bot | null): void {
    if (this.current?.bot !== bot) this.current = null;
  }

  bind(input: NavigationBindingInput): BoundNavigation {
    const bot = this.getBot();
    if (!bot || !bot.pathfinder) throw new Error('navigation_body_unavailable');
    const session = new MineflayerNavigationSession(bot, input, () => this.options, () => this.getBot() === bot,
      (event, value) => {
        if (this.current?.session !== session || this.getBot() !== bot) return;
        if (event === 'path_stop') this.log(`[nav] movement settled: ${String(value)}`);
        this.events.emit(event, value);
      });
    this.current = { bot, session };
    return session;
  }

  setMovementOptions(options: MovementOptions): void { this.options = { ...this.options, ...options }; }
  isFollowing(entityId?: number): boolean { return this.current?.session.actions.isFollowing(entityId) ?? false; }
  isMoving(): boolean { return this.current?.session.actions.isMoving() ?? false; }
  isMining(): boolean { return this.current?.session.actions.isMining() ?? false; }
  isBuilding(): boolean { return this.current?.session.actions.isBuilding() ?? false; }
  getCurrentGoal(): NavGoal | null { return this.current?.session.actions.getCurrentGoal() ?? null; }
  getCurrentPath(): Vec3[] { return this.current?.session.actions.getCurrentPath() ?? []; }

  onGoalReached(handler: () => void): Unsubscribe { return this.listen('goal_reached', handler); }
  onPathUpdate(handler: (path: Vec3[]) => void): Unsubscribe { return this.listen('path_update', handler); }
  onPathStop(handler: (reason: string) => void): Unsubscribe { return this.listen('path_stop', handler); }
  onGoalUpdated(handler: (goal: NavGoal | null) => void): Unsubscribe { return this.listen('goal_updated', handler); }
  private listen(event: string, handler: (...args: any[]) => void): Unsubscribe {
    this.events.on(event, handler);
    return () => { this.events.off(event, handler); };
  }
}
