import type { GameAdapter } from './GameAdapter.js';
import type { BoundGameActions, DeviceExecutionScope } from './GameActions.js';
import type {
  ChestOpResult,
  ControlKey,
  CraftResult,
  EquipDestination,
  FindBlocksOptions,
  ItemSource,
  RawArmor,
  RawBlock,
  RawEffect,
  RawEntity,
  RawItem,
  RawPlayer,
  RecipeInfo,
  SmeltResult,
  Unsubscribe,
  Vec3,
} from './types.js';

/**
 * FEAT-CROSS-08 · 无游戏身体时的大脑安全适配器。
 * 查询返回空世界，动作显式失败/空操作，保证 MainBrain 能独立陪聊。
 */
export class NullGameAdapter implements GameAdapter {
  readonly username: string;

  constructor(username = 'Companion') {
    this.username = username;
  }

  bind(_scope: DeviceExecutionScope): BoundGameActions { throw new Error('game_body_unavailable'); }

  getPosition(): Vec3 { return { x: 0, y: 64, z: 0 }; }
  getOrientation(): { yaw: number; pitch: number } { return { yaw: 0, pitch: 0 }; }
  getVelocity(): Vec3 { return { x: 0, y: 0, z: 0 }; }
  isOnGround(): boolean { return true; }
  getHealth(): number { return 20; }
  getFood(): number { return 20; }
  getSaturation(): number { return 5; }
  getExperienceLevel(): number { return 0; }
  getSelectedSlot(): number { return 0; }
  getGameMode(): string { return 'offline'; }
  getDimension(): string { return 'offline'; }
  getTimeOfDay(): number { return 6000; }
  isRaining(): boolean { return false; }
  isThundering(): boolean { return false; }

  getBlockAt(_pos: Vec3, _forceLoad?: boolean): RawBlock | null { return null; }
  findBlocks(_opts: FindBlocksOptions): Vec3[] { return []; }
  getEntities(): RawEntity[] { return []; }
  getEntityById(_id: number): RawEntity | null { return null; }
  getPlayers(): Record<string, RawPlayer> { return {}; }
  getPlayer(_name: string): RawPlayer | null { return null; }

  getInventoryItems(): RawItem[] { return []; }
  getHeldItem(): RawItem | null { return null; }
  getFreeSlotCount(): number { return 36; }
  getArmorItems(): RawArmor { return { head: null, torso: null, legs: null, feet: null }; }
  getOffhandItem(): RawItem | null { return null; }
  getEffects(): RawEffect[] { return []; }
  getOxygen(): number { return 20; }
  chat(_message: string): void {}
  getBlockProperties(_pos: Vec3): Record<string, string> | null { return null; }
  findBestFood(): string | null { return null; }
  findNearbyBed(_maxDistance: number): Vec3 | null { return null; }
  getCraftRecipes(_itemName: string, _withTable: boolean): RecipeInfo[] { return []; }
  getItemSource(_itemName: string): ItemSource | null { return null; }

  onChat(_handler: (sender: string, message: string) => void): Unsubscribe { return () => {}; }
  onWhisper(_handler: (sender: string, message: string) => void): Unsubscribe { return () => {}; }
  onHealthChange(_handler: (h: { health: number; food: number }) => void): Unsubscribe { return () => {}; }
  onDeath(_handler: () => void): Unsubscribe { return () => {}; }
  onSpawn(_handler: () => void): Unsubscribe { return () => {}; }
}
