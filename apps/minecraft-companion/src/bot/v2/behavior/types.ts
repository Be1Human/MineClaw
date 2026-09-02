import type { WorldStateView, ActionRequest, ExecutionResult, EventLevel } from '../types.js';

export interface BehaviorContext {
  world: WorldStateView;
  taskParams?: Record<string, unknown>;
}

export interface AdaptiveBehaviorResult {
  ok: boolean;
  error?: string;
  details?: Record<string, unknown>;
}

/** Stateful behaviors observe and request children; they never acquire or manipulate a device. */
export interface AdaptiveBehaviorContext {
  taskParams?: Record<string, unknown>;
  readonly signal: AbortSignal;
  getWorld(): WorldStateView;
  execute(request: ActionRequest): Promise<ExecutionResult>;
  wait(ms: number): Promise<void>;
  publish(type: string, level: EventLevel, payload: Record<string, unknown>): void;
}

export interface SequenceBehavior {
  readonly id: string;
  readonly kind: 'sequence';
  compile(ctx: BehaviorContext): ActionRequest[];
}

export interface AdaptiveBehavior {
  readonly id: string;
  readonly kind: 'adaptive';
  run(ctx: AdaptiveBehaviorContext): Promise<AdaptiveBehaviorResult>;
}

export type IBehavior = SequenceBehavior | AdaptiveBehavior;

export interface IBehaviorRegistry {
  register(behavior: IBehavior): void;
  get(id: string): IBehavior | undefined;
  list(): IBehavior[];
  clear(): void;
}
