import type { BoundGameActions, DeviceExecutionScope } from './GameActions.js';
import type {
  Vec3, RawBlock, RawEntity, RawItem, GameRegistrySnapshot, RawArmor, RawEffect,
  RawPlayer, FindBlocksOptions, Unsubscribe, RecipeInfo, ItemSource,
} from './types.js';

/** Read-only game observations. A snapshot can never confer permission to move the body. */
export interface GameView {
  readonly username: string;
  getPosition(): Vec3;
  getOrientation(): { yaw: number; pitch: number };
  getVelocity(): Vec3;
  isOnGround(): boolean;
  getHealth(): number;
  getFood(): number;
  getSaturation(): number;
  getExperienceLevel(): number;
  getSelectedSlot(): number;
  getGameMode(): string;
  getDimension(): string;
  getTimeOfDay(): number;
  isRaining(): boolean;
  isThundering(): boolean;
  getBlockAt(pos: Vec3, forceLoad?: boolean): RawBlock | null;
  findBlocks(opts: FindBlocksOptions): Vec3[];
  getEntities(): RawEntity[];
  getEntityById(id: number): RawEntity | null;
  getPlayers(): Record<string, RawPlayer>;
  getPlayer(name: string): RawPlayer | null;
  getInventoryItems(): RawItem[];
  getRegistrySnapshot?(): GameRegistrySnapshot | null;
  getHeldItem(): RawItem | null;
  getFreeSlotCount(): number;
  getArmorItems(): RawArmor;
  getOffhandItem(): RawItem | null;
  getEffects(): RawEffect[];
  getOxygen(): number;
  getBlockProperties(pos: Vec3): Record<string, string> | null;
  findBestFood(): string | null;
  findNearbyBed(maxDistance: number): Vec3 | null;
  getCraftRecipes(itemName: string, withTable: boolean): RecipeInfo[];
  getItemSource(itemName: string): ItemSource | null;
}

/** Composition-root device port. All mutations require a fixed-device operation binding. */
export interface GameAdapter extends GameView {
  bind(scope: DeviceExecutionScope): BoundGameActions;
  chat(message: string): void;
  onChat(handler: (sender: string, message: string) => void): Unsubscribe;
  onWhisper(handler: (sender: string, message: string) => void): Unsubscribe;
  onHealthChange(handler: (h: { health: number; food: number }) => void): Unsubscribe;
  onDeath(handler: () => void): Unsubscribe;
  onSpawn(handler: () => void): Unsubscribe;
}
