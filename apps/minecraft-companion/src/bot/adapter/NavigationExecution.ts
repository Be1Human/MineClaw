import type { DoorPassageRequest, GotoOptions, NavGoal } from './NavigationAdapter.js';
import type { MovementOptions, NavResult, Vec3 } from './types.js';
import type { BoundGameActions, DeviceExecutionScope } from './GameActions.js';

export interface NavigationBindingInput {
  scope: DeviceExecutionScope;
  game: BoundGameActions;
  maintain(navigation: NavigationActions): Promise<void>;
}

export interface NavigationView {
  isFollowing(entityId?: number): boolean;
  isMoving(): boolean;
  isMining(): boolean;
  isBuilding(): boolean;
  getCurrentGoal(): NavGoal | null;
  getCurrentPath(): Vec3[];
}

/** A navigation session is subordinate to one body operation, including door/recovery work. */
export interface NavigationActions extends NavigationView {
  goto(goal: NavGoal, options?: GotoOptions): Promise<NavResult>;
  /** Remains pending while following, including when the entity is currently within range. */
  follow(entityId: number, range: number): Promise<NavResult>;
  guideThroughDoor(request: DoorPassageRequest): Promise<NavResult>;
  /** Discard the current plan without ending the owned operation. Maintenance may request this. */
  replan(): void;
  /** Drain the current movement before another movement in the same operation can begin. */
  stop(): Promise<void>;
  setMovementOptions(options: MovementOptions): void;
}

export interface BoundNavigation {
  readonly actions: NavigationActions;
  /** Close the session permanently and drain all movement and maintenance work. */
  stop(reason: string): Promise<void>;
}
