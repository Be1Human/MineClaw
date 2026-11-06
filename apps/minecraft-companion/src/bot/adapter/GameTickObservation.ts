/** Optional, read-only tick/event observation on one concrete game connection. */
export interface GameTickWait {
  actor: string;
  dimension: string;
  maxTicks: number;
  event?: 'health';
  /** Host-only predicate checked at a tick boundary, never model input. */
  arrived?: () => boolean;
  deadlineAt: number;
  signal: AbortSignal;
  isCurrent(): boolean;
}
export interface GameTickResult {
  kind: 'elapsed' | 'event' | 'expired' | 'revoked' | 'unavailable';
  ticks: number;
  at: number;
  /** Fixed spawn incarnation; a later spawn cannot revive an old read. */
  stillCurrent(): boolean;
  self?: { position: { x: number; y: number; z: number }; yaw: number; pitch: number; food: number; health: number; isOnGround: boolean };
  inventory?: { name: string; count: number; slot: number }[];
}
export interface GameTickObservation {
  waitForGameTicks(request: GameTickWait): Promise<GameTickResult>;
}
