import type { DoorPassageRequest, GotoOptions, NavGoal, NavigationAdapter } from './NavigationAdapter.js';
import type { MovementOptions, NavResult, Unsubscribe, Vec3 } from './types.js';

/**
 * FEAT-CROSS-08 · 无游戏身体时的导航安全适配器。
 */
export class NullNavAdapter implements NavigationAdapter {
  private currentGoal: NavGoal | null = null;
  private movementOptions: MovementOptions = {};

  async goto(goal: NavGoal, _opts?: GotoOptions): Promise<NavResult> {
    this.currentGoal = goal;
    this.currentGoal = null;
    return { ok: false, reason: 'game_body_unavailable' };
  }

  async guideThroughDoor(_request: DoorPassageRequest): Promise<NavResult> {
    return { ok: false, reason: 'game_body_unavailable' };
  }

  stop(): void {
    this.currentGoal = null;
  }

  startFollow(_entityId: number, _range: number, _force?: boolean): { ok: boolean; reason?: string } {
    return { ok: false, reason: 'game_body_unavailable' };
  }

  stopFollow(): void {}
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
