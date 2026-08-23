/**
 * GameAdapter —— 上层依赖的游戏后端抽象
 *
 * 设计原则：
 * 1. 只暴露"上层真实用到"的方法（基于 src 全量使用扫描）
 * 2. 参数/返回值全部用 adapter/types.ts 的 Raw* 中性类型，不泄漏 mineflayer 类型
 * 3. **不包含寻路**——寻路是 NavigationAdapter 的职责
 * 4. **不包含 perception 快照构造**——perception 在适配层内部完成，对外只暴露 WorldState（perception/types.ts）
 *
 * 实现位置：bot/mineflayer/MineflayerGameAdapter.ts
 * 未来若要换游戏后端，只需新建一份实现，cognitive/skills/behaviorTree 零改动。
 */

import type {
  Vec3,
  RawBlock,
  RawEntity,
  RawItem,
  GameRegistrySnapshot,
  RawArmor,
  RawEffect,
  RawPlayer,
  ControlKey,
  EquipDestination,
  FindBlocksOptions,
  Unsubscribe,
  RecipeInfo,
  ItemSource,
  CraftResult,
  ChestOpResult,
  SmeltResult,
} from './types.js';

export interface GameAdapter {
  // ── 身份 ──────────────────────────────────────────────
  readonly username: string;

  // ── 自身状态（快照式读取） ─────────────────────────
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

  // ── 世界查询 ──────────────────────────────────────────
  getBlockAt(pos: Vec3, forceLoad?: boolean): RawBlock | null;
  findBlocks(opts: FindBlocksOptions): Vec3[];
  getEntities(): RawEntity[];
  getEntityById(id: number): RawEntity | null;
  getPlayers(): Record<string, RawPlayer>;
  getPlayer(name: string): RawPlayer | null;

  // ── 物品栏 ────────────────────────────────────────────
  getInventoryItems(): RawItem[];
  /** 当前服务端版本的权威对象注册表；无身体/后端不支持时可不提供。 */
  getRegistrySnapshot?(): GameRegistrySnapshot | null;
  getHeldItem(): RawItem | null;
  getFreeSlotCount(): number;
  /** 自身穿戴的盔甲四件（bot.inventory.items() 不含盔甲槽，需单独取） */
  getArmorItems(): RawArmor;
  /** 副手物品（盾牌/火把常放副手） */
  getOffhandItem(): RawItem | null;
  /** 当前生效的状态效果（药水 buff/debuff） */
  getEffects(): RawEffect[];
  /** 氧气/水下呼吸值（满或不适用为 20） */
  getOxygen(): number;

  // ── 低级控制 ──────────────────────────────────────────
  setControlState(key: ControlKey, value: boolean): void;
  clearControlStates(): void;
  lookAt(target: Vec3, force?: boolean): Promise<void>;
  look(yaw: number, pitch: number, force?: boolean): Promise<void>;
  chat(message: string): void;

  // ── 原子动作 ──────────────────────────────────────────
  attack(entityId: number): void;
  dig(pos: Vec3): Promise<void>;
  equip(itemName: string, destination?: EquipDestination): Promise<void>;
  /** FEAT-L3-13 · 把背包里的物品扔出去（交给玩家）· 返回实际扔出的数量。count 缺省=该物品全部 */
  toss(itemName: string, count?: number): Promise<number>;
  activateItem(offHand?: boolean): void;
  deactivateItem(): void;
  /** 读取方块属性（门的 open/half/facing 等 blockstate 属性） */
  getBlockProperties(pos: Vec3): Record<string, string> | null;
  /** 与方块交互（开门、躺床、按按钮等） */
  interactBlock(pos: Vec3): Promise<void>;
  /** 放置方块 · block = 参考方块（邻接面）· faceVector = 放置面法向量 */
  placeBlock(block: RawBlock, faceVector: Vec3): Promise<void>;

  // ── 生存 / 容器（FEAT-L3-02 吃睡 / FEAT-L3-03 箱子） ──────
  /** 吃当前手持的食物（需先 equip 食物到 hand）· 返回是否成功 */
  consume(): Promise<boolean>;
  /** 从背包挑最值得吃的食物名（按回复值排序）· 无食物返回 null */
  findBestFood(): string | null;
  /** 躺床睡觉（pos = 床方块坐标）· 失败抛错（白天 / 怪物在附近等） */
  sleep(pos: Vec3): Promise<void>;
  /** 起床 */
  wake(): Promise<void>;
  /** 找附近的床方块坐标 · 无返回 null */
  findNearbyBed(maxDistance: number): Vec3 | null;
  /** 往箱子存物（chestPos = 箱子坐标，需在交互距离内）· 返回实际存入数量 */
  depositToChest(chestPos: Vec3, itemName: string, count: number): Promise<ChestOpResult>;
  /** 从箱子取物 · 返回实际取出数量 */
  withdrawFromChest(chestPos: Vec3, itemName: string, count: number): Promise<ChestOpResult>;

  // ── 合成 / 配方数据（来自 minecraft-data） ──────────
  /**
   * 合成物品。
   * @param itemName 产物物品名
   * @param count    合成次数（每次产出 recipe.result.count 个）
   * @param tablePos 工作台坐标（null = 仅用 2x2 背包合成格）
   */
  craft(itemName: string, count: number, tablePos: Vec3 | null): Promise<CraftResult>;
  /**
   * 熔炼（FEAT-L3-06）。开炉→放料+燃料→等产出→取出。
   * @param furnacePos 熔炉方块坐标（需在交互距离内）
   * @param input      原料物品名（如 raw_iron / cobblestone / sand）
   * @param fuel       燃料物品名（如 coal / charcoal / oak_planks）
   * @param count      要熔炼的原料个数
   * @returns 实际产出数量
   */
  smelt(furnacePos: Vec3, input: string, fuel: string, count: number): Promise<SmeltResult>;
  /**
   * 查询某物品的所有合成配方（忽略当前库存，用于材料树反推）。
   * @param withTable true = 包含需要工作台的 3x3 配方
   */
  getCraftRecipes(itemName: string, withTable: boolean): RecipeInfo[];
  /**
   * 查询某物品的采集来源（哪个方块能挖出它 + 需要的最低工具）。
   * 找不到可挖来源返回 null（说明它只能合成 / 熔炼 / 其他途径获得）。
   */
  getItemSource(itemName: string): ItemSource | null;

  // ── 事件订阅（最小集，供 cognitive 用） ─────────────
  onChat(handler: (sender: string, message: string) => void): Unsubscribe;
  onWhisper(handler: (sender: string, message: string) => void): Unsubscribe;
  onHealthChange(handler: (h: { health: number; food: number }) => void): Unsubscribe;
  onDeath(handler: () => void): Unsubscribe;
  onSpawn(handler: () => void): Unsubscribe;
}
