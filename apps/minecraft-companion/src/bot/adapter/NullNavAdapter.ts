import type { BoundNavigation, NavigationBindingInput } from './NavigationExecution.js';
import type { DoorPassageRequest, GotoOptions, NavGoal, NavigationAdapter } from './NavigationAdapter.js';
import type { MovementOptions, NavResult, Unsubscribe, Vec3 } from './types.js';

/**
 * FEAT-CROSS-08 · 无游戏身体时的导航安全适配器。
 */
export class NullNavAdapter implements NavigationAdapter {
  private currentGoal: NavGoal | null = null;
  private movementOptions: MovementOptions = {};
  bind(_input: NavigationBindingInput): BoundNavigation { throw new Error('navigation_body_unavailable'); }

  isFollowing(_entityId?: number): boolean { return false; }
  isMoving(): boolean { return false; }
  isMining(): boolean { return false; }
  isBuilding(): boolean { return false; }
  setMovementOptions(opts: MovementOptions): void { this.movementOptions = { ...opts }; }
  getCurrentGoal(): NavGoal | null { return this.currentGoal; }
  getCurrentPath(): Vec3[] { return []; }

  onGoalReached(_handler: () => void): Unsubscribe { return () => {}; }
  onPathUpdate(_handler: (path: Vec3[]) => void): Unsubscribe { return () => {}; }
  onPathStop(_handler: (reason: string) => void): Unsubscribe { return () => {}; }
  onGoalUpdated(_handler: (goal: NavGoal | null) => void): Unsubscribe { return () => {}; }

  getMovementOptionsForDebug(): MovementOptions {
    return { ...this.movementOptions };
  }
}
