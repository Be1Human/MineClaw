import type { GameView } from './GameAdapter.js';
import type { ChestOpResult, ControlKey, CraftResult, EquipDestination, RawBlock, SmeltResult, Vec3 } from './types.js';

/** A device consumes the operation's mandatory lifetime, never an independent owner/lock. */
export interface DeviceExecutionScope {
  readonly signal: AbortSignal;
  assertCurrent(stage?: string): void;
  effect<T>(run: () => T | PromiseLike<T>): Promise<T>;
  wait(ms: number): Promise<void>;
}

/** Mutating capabilities exist only on a bound session. Queries and chat stay independent. */
export interface GameActions {
  setControlState(key: ControlKey, value: boolean): Promise<void>;
  clearControlStates(): Promise<void>;
  lookAt(target: Vec3, force?: boolean): Promise<void>;
  look(yaw: number, pitch: number, force?: boolean): Promise<void>;
  attack(entityId: number): Promise<void>;
  dig(pos: Vec3): Promise<void>;
  equip(itemName: string, destination?: EquipDestination): Promise<void>;
  toss(itemName: string, count?: number): Promise<number>;
  activateItem(offHand?: boolean): Promise<void>;
  deactivateItem(): Promise<void>;
  interactBlock(pos: Vec3): Promise<void>;
  placeBlock(block: RawBlock, faceVector: Vec3): Promise<void>;
  consume(): Promise<boolean>;
  sleep(pos: Vec3): Promise<void>;
  wake(): Promise<void>;
  mount(entityId: number): Promise<void>;
  dismount(): Promise<void>;
  depositToChest(chestPos: Vec3, itemName: string, count: number): Promise<ChestOpResult>;
  withdrawFromChest(chestPos: Vec3, itemName: string, count: number): Promise<ChestOpResult>;
  craft(itemName: string, count: number, tablePos: Vec3 | null): Promise<CraftResult>;
  smelt(furnacePos: Vec3, input: string, fuel: string, count: number): Promise<SmeltResult>;
}

export interface BoundGameActions {
  /** Fixed device view: a reconnection cannot redirect this operation's reads or writes. */
  readonly view: GameView;
  readonly actions: GameActions;
  /** Requests interruption and resolves only after native work and owned cleanup drain. */
  stop(reason: string): Promise<void>;
}
