import type { GameAdapter } from './GameAdapter.js';
import type { BoundGameActions, DeviceExecutionScope } from './GameActions.js';
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
 *  ① 方法委托：查询转发到当前 target；动作在绑定时固定 target。
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

  bind(scope: DeviceExecutionScope): BoundGameActions {
    const target = this.target;
    const check = (stage?: string) => {
      scope.assertCurrent(stage);
      if (this.target !== target) throw new Error('device_generation_changed');
    };
    return target.bind({
      signal: scope.signal, assertCurrent: check,
      effect: run => scope.effect(() => { check('device_dispatch'); return run(); }),
      wait: ms => scope.wait(ms),
    });
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
  chat(message: string): void { this.target.chat(message); }
  getBlockProperties(pos: Vec3): Record<string, string> | null { return this.target.getBlockProperties(pos); }
  findBestFood(): string | null { return this.target.findBestFood(); }
  findNearbyBed(maxDistance: number): Vec3 | null { return this.target.findNearbyBed(maxDistance); }
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
