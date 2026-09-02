import type { GameAdapter } from '../../../../../../apps/minecraft-companion/src/bot/adapter/GameAdapter.js';
import type { BoundGameActions, DeviceExecutionScope, GameActions } from '../../../../../../apps/minecraft-companion/src/bot/adapter/GameActions.js';
import type {
  Vec3,
  RawBlock,
  RawEntity,
  RawItem,
  RawArmor,
  RawEffect,
  RawPlayer,
  ControlKey,
  FindBlocksOptions,
  Unsubscribe,
  RecipeInfo,
  ItemSource,
  CraftResult,
  ChestOpResult,
} from '../../../../../../apps/minecraft-companion/src/bot/adapter/types.js';
import type { MockWorld } from './mockWorld.js';

export class MockGameAdapter implements GameAdapter {
  readonly username = 'MockBot';

  // Track calls for assertions
  readonly calls: Record<string, unknown[][]> = {
    chat: [],
    attack: [],
    lookAt: [],
    equip: [],
    toss: [],
    dig: [],
    placeBlock: [],
    activateItem: [],
    deactivateItem: [],
    interactBlock: [],
  };

  // Event handlers
  private chatHandlers: Array<(sender: string, msg: string) => void> = [];
  private whisperHandlers: Array<(sender: string, msg: string) => void> = [];
  private healthHandlers: Array<(h: { health: number; food: number }) => void> = [];
  private deathHandlers: Array<() => void> = [];
  private spawnHandlers: Array<() => void> = [];

  constructor(private readonly world: MockWorld) {}

  bind(scope: DeviceExecutionScope): BoundGameActions {
    let closed = false;
    const pending = new Set<Promise<unknown>>();
    const actions = {} as GameActions;
    const methods = ['setControlState','clearControlStates','lookAt','look','attack','dig','equip','toss',
      'activateItem','deactivateItem','interactBlock','placeBlock','consume','sleep','wake',
      'depositToChest','withdrawFromChest','craft','smelt','mount','dismount'] as const;
    for (const key of methods) {
      Object.defineProperty(actions,key,{value:(...args: unknown[]) => {
        scope.assertCurrent(`mock:${key}`);
        if (closed) throw new Error('mock_device_session_closed');
        return scope.effect(() => {
          const work = Promise.resolve((this[key] as (...values:unknown[])=>unknown).apply(this,args));
          pending.add(work);
          work.then(()=>pending.delete(work),()=>pending.delete(work));
          return work;
        });
      }});
    }
    return {view:this,actions,stop:async()=>{
      closed=true;
      await Promise.allSettled([...pending]);
      this.clearControlStates();
    }};
  }

  // Trigger events (for test scripting)
  emitChat(sender: string, message: string): void {
    for (const h of this.chatHandlers) h(sender, message);
  }

  emitHealthChange(health: number, food: number): void {
    this.world.setHealth(health);
    for (const h of this.healthHandlers) h({ health, food });
  }

  emitDeath(): void {
    for (const h of this.deathHandlers) h();
  }

  emitSpawn(): void {
    for (const h of this.spawnHandlers) h();
  }

  // ── 身份 ──────────────────────────────────────────────

  // ── 自身状态（快照式读取） ─────────────────────────
  getPosition(): Vec3 {
    return { ...this.world.self.position };
  }

  getOrientation(): { yaw: number; pitch: number } {
    return { yaw: this.world.self.yaw, pitch: this.world.self.pitch };
  }

  getVelocity(): Vec3 {
    return { x: 0, y: 0, z: 0 };
  }

  isOnGround(): boolean {
    return this.world.self.isOnGround;
  }

  getHealth(): number {
    return this.world.self.health;
  }

  getFood(): number {
    return this.world.self.food;
  }

  getSaturation(): number {
    return 5;
  }

  getExperienceLevel(): number {
    return 0;
  }

  getSelectedSlot(): number {
    return 0;
  }

  getGameMode(): string {
    return 'survival';
  }

  getDimension(): string {
    return this.world.dimension;
  }

  getTimeOfDay(): number {
    return this.world.timeOfDay;
  }

  isRaining(): boolean {
    return this.world.isRaining;
  }

  isThundering(): boolean {
    return false;
  }

  // ── 世界查询 ──────────────────────────────────────────
  getBlockAt(_pos: Vec3, _forceLoad?: boolean): RawBlock | null {
    return null;
  }
  getBlockProperties(_pos: Vec3): Record<string, string> | null {
    return null;
  }

  findBlocks(_opts: FindBlocksOptions): Vec3[] {
    return [];
  }

  getEntities(): RawEntity[] {
    return this.world.entities.map(
      e =>
        ({
          id: e.entityId,
          username: e.username,
          type: e.type === 'player' ? 'player' : 'mob',
          name: e.name,
          position: { ...e.position },
          health: e.health ?? 20,
          velocity: { x: 0, y: 0, z: 0 },
          yaw: 0,
          pitch: 0,
        }) as RawEntity,
    );
  }

  getEntityById(id: number): RawEntity | null {
    return this.getEntities().find(x => x.id === id) ?? null;
  }

  getPlayers(): Record<string, RawPlayer> {
    const result: Record<string, RawPlayer> = {};
    for (const e of this.world.entities.filter(e => e.type === 'player' && e.username)) {
      const entity: RawEntity = {
        id: e.entityId,
        name: e.username!,
        type: 'player',
        position: { ...e.position },
        username: e.username,
      };
      result[e.username!] = { username: e.username!, entity };
    }
    return result;
  }

  getPlayer(name: string): RawPlayer | null {
    const players = this.getPlayers();
    return players[name] ?? null;
  }

  // ── 物品栏 ────────────────────────────────────────────
  getInventoryItems(): RawItem[] {
    return this.world.inventory.map(i => ({
      name: i.name,
      count: i.count,
      slot: i.slot,
      durability: i.durability,
      maxDurability: i.maxDurability,
    }));
  }

  getHeldItem(): RawItem | null {
    const item = this.world.heldItem;
    return item ? {
      name: item.name,
      count: item.count,
      slot: item.slot,
      durability: item.durability,
      maxDurability: item.maxDurability,
    } : null;
  }

  getFreeSlotCount(): number {
    return Math.max(0, 36 - this.world.inventory.length);
  }

  getArmorItems(): RawArmor {
    return { head: null, torso: null, legs: null, feet: null };
  }

  getOffhandItem(): RawItem | null {
    return null;
  }

  getEffects(): RawEffect[] {
    return [];
  }

  getOxygen(): number {
    return 20;
  }

  // ── 低级控制 ──────────────────────────────────────────
  setControlState(_key: ControlKey, _value: boolean): void {}

  clearControlStates(): void {}

  async lookAt(target: Vec3, _force?: boolean): Promise<void> {
    this.calls.lookAt.push([target]);
  }

  async look(yaw: number, pitch: number, _force?: boolean): Promise<void> {
    this.world.self.yaw = yaw;
    this.world.self.pitch = pitch;
  }

  chat(message: string): void {
    this.calls.chat.push([message]);
  }

  // ── 原子动作 ──────────────────────────────────────────
  attack(entityId: number): void {
    this.calls.attack.push([entityId]);
  }

  async dig(pos: Vec3): Promise<void> {
    this.calls.dig.push([pos]);
  }

  async equip(itemName: string, _destination?: string): Promise<void> {
    this.calls.equip.push([itemName]);
    const item = this.world.inventory.find(candidate => candidate.name === itemName && candidate.count > 0);
    if (!item) throw new Error(`item_not_found:${itemName}`);
    this.world.heldItem = item;
  }

  async toss(itemName: string, count?: number): Promise<number> {
    this.calls.toss.push([itemName, count]);
    let want = count == null ? Infinity : Math.max(0, count);
    let tossed = 0;
    for (const it of this.world.inventory) {
      if (it.name !== itemName || want <= 0) continue;
      const n = Math.min(it.count, want);
      it.count -= n; tossed += n; want -= n;
    }
    this.world.inventory = this.world.inventory.filter(i => i.count > 0);
    return tossed;
  }

  activateItem(_offHand?: boolean): void {
    this.calls.activateItem.push([]);
  }

  deactivateItem(): void {
    this.calls.deactivateItem.push([]);
  }

  async interactBlock(pos: Vec3): Promise<void> {
    this.calls.interactBlock.push([pos]);
  }

  async placeBlock(_block: RawBlock, _faceVector: Vec3): Promise<void> {
    this.calls.placeBlock.push([]);
  }

  // ── 合成 / 配方数据（mock：默认空，测试可覆盖） ──
  async craft(_itemName: string, _count: number, _tablePos: Vec3 | null): Promise<CraftResult> {
    return { ok: false, reason: 'mock_no_craft' };
  }
  async smelt(_furnacePos: Vec3, _input: string, _fuel: string, _count: number): Promise<{ ok: boolean; produced: number; reason?: string }> {
    return { ok: false, produced: 0, reason: 'mock_no_smelt' };
  }
  getCraftRecipes(_itemName: string, _withTable: boolean): RecipeInfo[] {
    return [];
  }
  getItemSource(_itemName: string): ItemSource | null {
    return null;
  }

  // ── 生存 / 容器（mock：默认 no-op，测试可覆盖） ──
  async consume(): Promise<boolean> {
    return true;
  }
  findBestFood(): string | null {
    return null;
  }
  async sleep(_pos: Vec3): Promise<void> {}
  async wake(): Promise<void> {}
  async mount(_entityId: number): Promise<void> { throw new Error('mock_mount_unavailable'); }
  async dismount(): Promise<void> { throw new Error('mock_dismount_unavailable'); }
  findNearbyBed(_maxDistance: number): Vec3 | null {
    return null;
  }
  async depositToChest(_chestPos: Vec3, _itemName: string, _count: number): Promise<ChestOpResult> {
    return { ok: false, moved: 0, reason: 'mock_no_chest' };
  }
  async withdrawFromChest(_chestPos: Vec3, _itemName: string, _count: number): Promise<ChestOpResult> {
    return { ok: false, moved: 0, reason: 'mock_no_chest' };
  }

  // ── 事件订阅 ──────────────────────────────────────────
  onChat(handler: (sender: string, message: string) => void): Unsubscribe {
    this.chatHandlers.push(handler);
    return () => {
      this.chatHandlers = this.chatHandlers.filter(h => h !== handler);
    };
  }

  onWhisper(handler: (sender: string, message: string) => void): Unsubscribe {
    this.whisperHandlers.push(handler);
    return () => {
      this.whisperHandlers = this.whisperHandlers.filter(h => h !== handler);
    };
  }

  onHealthChange(handler: (h: { health: number; food: number }) => void): Unsubscribe {
    this.healthHandlers.push(handler);
    return () => {
      this.healthHandlers = this.healthHandlers.filter(h => h !== handler);
    };
  }

  onDeath(handler: () => void): Unsubscribe {
    this.deathHandlers.push(handler);
    return () => {
      this.deathHandlers = this.deathHandlers.filter(h => h !== handler);
    };
  }

  onSpawn(handler: () => void): Unsubscribe {
    this.spawnHandlers.push(handler);
    return () => {
      this.spawnHandlers = this.spawnHandlers.filter(h => h !== handler);
    };
  }
}
