import type { GameAdapter } from './GameAdapter.js';
import type {
  ChestOpResult,
  ControlKey,
  CraftResult,
  EquipDestination,
  FindBlocksOptions,
  GameRegistrySnapshot,
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
 * FEAT-CROSS-08 v2 · 可切换游戏适配器代理（热插拔身体的核心）。
 *
 * 上层 V2Runtime 的 13+ 子模块构造时持有本代理引用，永不改变；
 * 进/退游戏时只 setTarget(真身体 ↔ Null)，子模块无感知。
 *
 * 两个职责：
 *  ① 方法委托：所有查询/动作转发到当前 target。
 *  ② 订阅簿记 + 重放：on* 注册的监听记账，setTarget 时把在册监听重挂到新 target、
 *     旧 target 解绑——子模块的订阅跨身体切换存活。
 */
export class SwitchableGameAdapter implements GameAdapter {
  private target: GameAdapter;
  /** 订阅记录：rebind 保存"如何在任意 target 上重新订阅"，setTarget 时重放。 */
  private readonly subs: { rebind: (t: GameAdapter) => Unsubscribe; unsub: Unsubscribe }[] = [];

  constructor(initial: GameAdapter) {
    this.target = initial;
  }

  /** 切换底层身体（Null ↔ 真 mineflayer 适配器）。在册订阅从旧 target 解绑、重挂到新 target。 */
  setTarget(next: GameAdapter): void {
    if (next === this.target) return;
    this.target = next;
    for (const rec of this.subs) {
      try { rec.unsub(); } catch { /* 旧 target 解绑失败不阻断切换 */ }
      rec.unsub = rec.rebind(next);
    }
  }

  /** 当前底层身体（调试/测试用）。 */
  getTarget(): GameAdapter { return this.target; }

  /** 登记一个订阅并挂到当前 target；返回的 Unsubscribe 会解绑并注销记录。 */
  private track(rebind: (t: GameAdapter) => Unsubscribe): Unsubscribe {
    const rec = { rebind, unsub: rebind(this.target) };
    this.subs.push(rec);
    return () => {
      try { rec.unsub(); } catch { /* ignore */ }
      const i = this.subs.indexOf(rec);
      if (i >= 0) this.subs.splice(i, 1);
    };
  }

  // ── 身份 ──────────────────────────────────────────────
  get username(): string { return this.target.username; }

  // ── 自身状态 ──────────────────────────────────────────
  getPosition(): Vec3 { return this.target.getPosition(); }
  getOrientation(): { yaw: number; pitch: number } { return this.target.getOrientation(); }
  getVelocity(): Vec3 { return this.target.getVelocity(); }
  isOnGround(): boolean { return this.target.isOnGround(); }
  getHealth(): number { return this.target.getHealth(); }
  getFood(): number { return this.target.getFood(); }
  getSaturation(): number { return this.target.getSaturation(); }
  getExperienceLevel(): number { return this.target.getExperienceLevel(); }
  getSelectedSlot(): number { return this.target.getSelectedSlot(); }
  getGameMode(): string { return this.target.getGameMode(); }
  getDimension(): string { return this.target.getDimension(); }
  getTimeOfDay(): number { return this.target.getTimeOfDay(); }
  isRaining(): boolean { return this.target.isRaining(); }
  isThundering(): boolean { return this.target.isThundering(); }

  // ── 世界查询 ──────────────────────────────────────────
  getBlockAt(pos: Vec3, forceLoad?: boolean): RawBlock | null { return this.target.getBlockAt(pos, forceLoad); }
  findBlocks(opts: FindBlocksOptions): Vec3[] { return this.target.findBlocks(opts); }
  getEntities(): RawEntity[] { return this.target.getEntities(); }
  getEntityById(id: number): RawEntity | null { return this.target.getEntityById(id); }
  getPlayers(): Record<string, RawPlayer> { return this.target.getPlayers(); }
  getPlayer(name: string): RawPlayer | null { return this.target.getPlayer(name); }

  // ── 物品栏 ────────────────────────────────────────────
  getInventoryItems(): RawItem[] { return this.target.getInventoryItems(); }
  getRegistrySnapshot(): GameRegistrySnapshot | null { return this.target.getRegistrySnapshot?.() ?? null; }
  getHeldItem(): RawItem | null { return this.target.getHeldItem(); }
  getFreeSlotCount(): number { return this.target.getFreeSlotCount(); }
  getArmorItems(): RawArmor { return this.target.getArmorItems(); }
  getOffhandItem(): RawItem | null { return this.target.getOffhandItem(); }
  getEffects(): RawEffect[] { return this.target.getEffects(); }
  getOxygen(): number { return this.target.getOxygen(); }

  // ── 低级控制 ──────────────────────────────────────────
  setControlState(key: ControlKey, value: boolean): void { this.target.setControlState(key, value); }
  clearControlStates(): void { this.target.clearControlStates(); }
  lookAt(target: Vec3, force?: boolean): Promise<void> { return this.target.lookAt(target, force); }
  look(yaw: number, pitch: number, force?: boolean): Promise<void> { return this.target.look(yaw, pitch, force); }
  chat(message: string): void { this.target.chat(message); }

  // ── 原子动作 ──────────────────────────────────────────
  attack(entityId: number): void { this.target.attack(entityId); }
  dig(pos: Vec3): Promise<void> { return this.target.dig(pos); }
  equip(itemName: string, destination?: EquipDestination): Promise<void> { return this.target.equip(itemName, destination); }
  toss(itemName: string, count?: number): Promise<number> { return this.target.toss(itemName, count); }
  activateItem(offHand?: boolean): void { this.target.activateItem(offHand); }
  deactivateItem(): void { this.target.deactivateItem(); }
  getBlockProperties(pos: Vec3): Record<string, string> | null { return this.target.getBlockProperties(pos); }
  interactBlock(pos: Vec3): Promise<void> { return this.target.interactBlock(pos); }
  placeBlock(block: RawBlock, faceVector: Vec3): Promise<void> { return this.target.placeBlock(block, faceVector); }

  // ── 生存 / 容器 ───────────────────────────────────────
  consume(): Promise<boolean> { return this.target.consume(); }
  findBestFood(): string | null { return this.target.findBestFood(); }
  sleep(pos: Vec3): Promise<void> { return this.target.sleep(pos); }
  wake(): Promise<void> { return this.target.wake(); }
  findNearbyBed(maxDistance: number): Vec3 | null { return this.target.findNearbyBed(maxDistance); }
  depositToChest(chestPos: Vec3, itemName: string, count: number): Promise<ChestOpResult> {
    return this.target.depositToChest(chestPos, itemName, count);
  }
  withdrawFromChest(chestPos: Vec3, itemName: string, count: number): Promise<ChestOpResult> {
    return this.target.withdrawFromChest(chestPos, itemName, count);
  }

  // ── 合成 / 配方 ───────────────────────────────────────
  craft(itemName: string, count: number, tablePos: Vec3 | null): Promise<CraftResult> {
    return this.target.craft(itemName, count, tablePos);
  }
  smelt(furnacePos: Vec3, input: string, fuel: string, count: number): Promise<SmeltResult> {
    return this.target.smelt(furnacePos, input, fuel, count);
  }
  getCraftRecipes(itemName: string, withTable: boolean): RecipeInfo[] { return this.target.getCraftRecipes(itemName, withTable); }
  getItemSource(itemName: string): ItemSource | null { return this.target.getItemSource(itemName); }

  // ── 事件订阅（簿记 + 重放）─────────────────────────────
  onChat(handler: (sender: string, message: string) => void): Unsubscribe {
    return this.track(t => t.onChat(handler));
  }
  onWhisper(handler: (sender: string, message: string) => void): Unsubscribe {
    return this.track(t => t.onWhisper(handler));
  }
  onHealthChange(handler: (h: { health: number; food: number }) => void): Unsubscribe {
    return this.track(t => t.onHealthChange(handler));
  }
  onDeath(handler: () => void): Unsubscribe {
    return this.track(t => t.onDeath(handler));
  }
  onSpawn(handler: () => void): Unsubscribe {
    return this.track(t => t.onSpawn(handler));
  }
}
