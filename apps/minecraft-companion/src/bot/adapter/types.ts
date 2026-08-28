/**
 * 适配层中性类型 —— 与具体游戏后端无关的"原始快照"
 *
 * 与 perception 层的 WorldState 区别：
 * - 这里的 Raw* 是适配器吐出的最小未加工事实（位置/id/名字/数量）
 * - perception 在 Raw 之上加工出 category/threatLevel/distance 等业务字段
 *
 * 上层（cognitive/skills/navigation/behaviorTree）应该：
 *   - 查询世界状态 → 用 perception.WorldState
 *   - 主动控制 / 单点查询 → 用 GameAdapter 方法（参数/返回值是 Raw*）
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface RawBlock {
  name: string;
  position: Vec3;
  /** 是否对玩家碰撞箱实心（用于占用图判断） */
  boundingBox?: 'block' | 'empty';
}

export interface RawEntity {
  id: number;
  name: string;
  /** mob / player / object / projectile / orb / ... 适配器原样透传 */
  type: string;
  position: Vec3;
  velocity?: Vec3;
  yaw?: number;
  pitch?: number;
  health?: number;
  /** 玩家名（仅 type === 'player' 时有效） */
  username?: string;
  /** 服务器 player_info 下发的玩家皮肤纹理地址。 */
  skinUrl?: string;
  /** 玩家皮肤手臂模型；Mineflayer 没有 slim 标记时按 classic。 */
  skinModel?: 'classic' | 'slim';
  /** 地面掉落物的真实物品栈；非 item 实体为空。 */
  droppedItem?: {
    name: string;
    count: number;
  };
}

export interface RawItem {
  name: string;
  count: number;
  /** 物品栏槽位编号 */
  slot: number;
  /** 剩余耐久（工具类才有 · 不适用的物品为 undefined） */
  durability?: number;
  /** 最大耐久（同上） */
  maxDurability?: number;
}

/** 游戏版本注册表的中性快照；上层目录只消费事实，不依赖 mineflayer 类型。 */
export interface GameRegistryObject {
  registryId: string;
  name: string;
  displayName: string;
  kind: 'item' | 'block' | 'entity';
  isBlock?: boolean;
}

export interface GameRegistrySnapshot {
  revision: string;
  objects: GameRegistryObject[];
}

/** 自身穿戴的盔甲四件（空槽为 null） */
export interface RawArmor {
  head: RawItem | null;
  torso: RawItem | null;
  legs: RawItem | null;
  feet: RawItem | null;
}

/** 自身当前生效的状态效果（药水 buff/debuff） */
export interface RawEffect {
  /** 效果数值 id */
  id: number;
  /** 效果名（如 poison/weakness/regeneration · 取不到则为 id 字符串） */
  name: string;
  /** 等级（0 基，0 = I 级） */
  amplifier: number;
  /** 剩余时长（tick · 20 tick=1s） */
  duration: number;
}

export interface RawPlayer {
  username: string;
  /** 玩家可能未渲染（远距离），此时 entity 字段为空 */
  entity?: RawEntity;
}

/** 控制键 —— 适配器需把这些映射到底层输入 */
export type ControlKey =
  | 'forward'
  | 'back'
  | 'left'
  | 'right'
  | 'jump'
  | 'sprint'
  | 'sneak';

export type EquipDestination = 'hand' | 'off-hand' | 'head' | 'torso' | 'legs' | 'feet';

export type Unsubscribe = () => void;

/** 找方块的过滤条件（中性，避免暴露 mineflayer 的 matching 数组语义） */
export interface FindBlocksOptions {
  /** 块名（minecraft:xxx 不带前缀）或多个块名 */
  names: string | string[];
  /** 最大搜索距离 */
  maxDistance: number;
  /** 最多返回多少个 */
  count?: number;
  /** 搜索原点（缺省 = bot 当前位置） */
  origin?: Vec3;
}

/** 合成配方（中性 · 来自 minecraft-data，不暴露 mineflayer Recipe 对象） */
export interface RecipeInfo {
  /** 产物 */
  result: { name: string; count: number };
  /** 所需材料（已合并同名） */
  ingredients: { name: string; count: number }[];
  /** 是否需要工作台（3x3） */
  requiresTable: boolean;
}

/** 某物品的采集来源（哪个方块能挖出它 + 需要什么工具） */
export interface ItemSource {
  /** 可挖出该物品的方块名（如 cobblestone ← 'stone'，oak_log ← 'oak_log'） */
  block: string;
  /** 需要的最低工具物品名（如 'wooden_pickaxe'）· null = 徒手即可掉落 */
  requiredTool: string | null;
}

/** 合成执行结果 */
export interface CraftResult {
  ok: boolean;
  reason?: string;
}

/** 箱子存/取执行结果（FEAT-L3-03） */
export interface ChestOpResult {
  ok: boolean;
  /** 实际转移的物品数量 */
  moved: number;
  reason?: string;
  /**
   * FEAT-MEM-06 · 关闭前抓到的箱子内全部物品名（去重后）。
   * 写 spatial.meta.items 用，让 ChestMemoryProvider / find_chest_with 工具可查。
   * 即使 ok=false（比如取空），只要成功开过箱就会附带；adapter 异常时 undefined。
   */
  contents?: string[];
}

/** 熔炼执行结果（FEAT-L3-06） */
export interface SmeltResult {
  ok: boolean;
  /** 实际产出的成品数量 */
  produced: number;
  reason?: string;
}

/** 寻路结果 */
export interface NavResult {
  ok: boolean;
  /** 失败原因：'unreachable' | 'cancelled' | 'timeout' | 'blocked' | ... 适配器定义 */
  reason?: string;
}

/** 移动能力开关（pathfinder Movements 的中性表达） */
export interface MovementOptions {
  canDig?: boolean;
  canPlace?: boolean;
  /** 寻路时自动开门/栅栏门通过（默认 true） */
  canOpenDoors?: boolean;
  allowParkour?: boolean;
  allowSprinting?: boolean;
  /** 允许踩在哪些方块上 */
  scafoldingBlocks?: string[];
  /** 视为可破坏的方块（白名单） */
  allowedDigBlocks?: string[];
  /** 不能破坏的方块（黑名单） */
  blocksToAvoid?: string[];
}
