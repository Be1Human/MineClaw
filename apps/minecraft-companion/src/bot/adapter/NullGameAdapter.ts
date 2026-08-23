import type { GameAdapter } from './GameAdapter.js';
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

  setControlState(_key: ControlKey, _value: boolean): void {}
  clearControlStates(): void {}
  async lookAt(_target: Vec3, _force?: boolean): Promise<void> {}
  async look(_yaw: number, _pitch: number, _force?: boolean): Promise<void> {}
  chat(_message: string): void {}

  attack(_entityId: number): void {}
  async dig(_pos: Vec3): Promise<void> { throw new Error('game_body_unavailable'); }
  async equip(_itemName: string, _destination?: EquipDestination): Promise<void> { throw new Error('game_body_unavailable'); }
  async toss(_itemName: string, _count?: number): Promise<number> { throw new Error('game_body_unavailable'); }
  activateItem(_offHand?: boolean): void {}
  deactivateItem(): void {}
  getBlockProperties(_pos: Vec3): Record<string, string> | null { return null; }
  async interactBlock(_pos: Vec3): Promise<void> { throw new Error('game_body_unavailable'); }
  async placeBlock(_block: RawBlock, _faceVector: Vec3): Promise<void> { throw new Error('game_body_unavailable'); }

  async consume(): Promise<boolean> { return false; }
  findBestFood(): string | null { return null; }
  async sleep(_pos: Vec3): Promise<void> { throw new Error('game_body_unavailable'); }
  async wake(): Promise<void> {}
  findNearbyBed(_maxDistance: number): Vec3 | null { return null; }
  async depositToChest(_chestPos: Vec3, _itemName: string, _count: number): Promise<ChestOpResult> {
    return { ok: false, moved: 0, reason: 'game_body_unavailable' };
  }
  async withdrawFromChest(_chestPos: Vec3, _itemName: string, _count: number): Promise<ChestOpResult> {
    return { ok: false, moved: 0, reason: 'game_body_unavailable' };
  }

  async craft(_itemName: string, _count: number, _tablePos: Vec3 | null): Promise<CraftResult> {
    return { ok: false, reason: 'game_body_unavailable' };
  }
  async smelt(_furnacePos: Vec3, _input: string, _fuel: string, _count: number): Promise<SmeltResult> {
    return { ok: false, produced: 0, reason: 'game_body_unavailable' };
  }
  getCraftRecipes(_itemName: string, _withTable: boolean): RecipeInfo[] { return []; }
  getItemSource(_itemName: string): ItemSource | null { return null; }

  onChat(_handler: (sender: string, message: string) => void): Unsubscribe { return () => {}; }
  onWhisper(_handler: (sender: string, message: string) => void): Unsubscribe { return () => {}; }
  onHealthChange(_handler: (h: { health: number; food: number }) => void): Unsubscribe { return () => {}; }
  onDeath(_handler: () => void): Unsubscribe { return () => {}; }
  onSpawn(_handler: () => void): Unsubscribe { return () => {}; }
}
