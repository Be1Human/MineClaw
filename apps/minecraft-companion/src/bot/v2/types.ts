/**
 * v2.0 核心契约 —— 所有跨层通信的"形状"都在这里
 *
 * 三个最重要的 schema：
 * 1. WorldStateView · 名词态 · Perception 输出 · 决策/执行层只读
 * 2. BusEvent · 动词态 · EventBus 流通 · 四级分类
 * 3. ActionRequest · 想做事的统一格式 · 仲裁器一处决议
 */

import type { Vec3 } from '../adapter/types.js';

// ──────────────────────────────────────────────────────────────────
// EventBus · 事件四级分类
// ──────────────────────────────────────────────────────────────────

export type EventLevel = 'critical' | 'recoverable' | 'suggestion' | 'info';

export interface BusEvent<T = unknown> {
  /** 唯一 id（去重） */
  id: string;
  /** 事件类型，如 'chat.from_owner' / 'under_attack' / 'tool_broken' */
  type: string;
  /** 四级紧急程度 */
  level: EventLevel;
  /** 时间戳 ms */
  timestamp: number;
  /** 业务载荷 */
  payload: T;
}

// ──────────────────────────────────────────────────────────────────
// WorldStateView · Perception 输出的名词态快照
// ──────────────────────────────────────────────────────────────────

export interface WorldStateView {
  /** 本快照的 tick 号 */
  tick: number;
  timestamp: number;
  self: SelfView;
  owner: OwnerView | null;
  environment: EnvironmentView;
  /** 视野内的实体（简化）·perception 的 EntityInfo 还在 v1 那边 */
  entities: EntityView[];
  /** 背包（含工具耐久 · 用于 Preflight 检查 has_hoe / has_durability 等） */
  inventory: InventoryView;
  /** 当前任务上下文（L6 写） */
  taskContext: TaskContextView | null;
}

export interface InventoryView {
  /** 物品列表（按 RawItem 的 slot 顺序）· 不含盔甲/副手槽 */
  items: InventoryItemView[];
  /** 手持物品（主手） */
  held: InventoryItemView | null;
  /** 穿戴的盔甲四件（空槽为 null）· 真感知始终填，旧测试夹具可省 */
  armor?: ArmorView;
  /** 副手物品（盾牌/火把等）· 同上可选 */
  offhand?: InventoryItemView | null;
  /** 空槽数量 */
  freeSlots: number;
}

/** 自身穿戴的盔甲四件 */
export interface ArmorView {
  head: InventoryItemView | null;
  torso: InventoryItemView | null;
  legs: InventoryItemView | null;
  feet: InventoryItemView | null;
}

/** 自身当前生效的状态效果（药水 buff/debuff） */
export interface EffectView {
  id: number;
  /** 效果名（poison/weakness/regeneration…） */
  name: string;
  /** 等级（0 基，0=I 级） */
  amplifier: number;
  /** 剩余 tick（20 tick=1s） */
  duration: number;
}

export interface InventoryItemView {
  name: string;
  count: number;
  slot: number;
  /** 工具类才有 · 当前耐久 */
  durability?: number;
  maxDurability?: number;
}

export interface SelfView {
  position: Vec3;
  yaw: number;
  pitch: number;
  health: number;
  maxHealth: number;
  food: number;
  isOnGround: boolean;
  /** 当前选中的快捷栏槽位号（0-8） */
  heldSlot?: number;
  /** 经验等级 */
  xpLevel?: number;
  /** 氧气/水下呼吸值（满或陆地上为 20） */
  oxygen?: number;
  /** 当前生效的状态效果（buff/debuff） */
  effects?: EffectView[];
}

export interface OwnerView {
  username: string;
  /** 实体可见时才有位置 */
  position: Vec3 | null;
  /** 与 self 的距离（owner 不可见时为 Infinity） */
  distance: number;
  /** owner 实体 id（用于 NavGoal） */
  entityId: number | null;
  isVisible: boolean;
  /** 可见玩家实体朝向（弧度）；相对位置指令使用，旧适配器可省略。 */
  yaw?: number;
}

export interface EnvironmentView {
  dimension: string;
  timeOfDay: number;
  isDay: boolean;
  isRaining: boolean;
}

export interface EntityView {
  id: number;
  name: string;
  type: string;
  position: Vec3;
  distance: number;
  category: 'player' | 'hostile' | 'passive' | 'neutral' | 'item' | 'other';
  /** 地面物品实体的精确物品栈身份。 */
  droppedItem?: {
    name: string;
    count: number;
  };
  /** 实体朝向（弧度）· 玩家/生物有效 */
  yaw?: number;
}

export interface TaskContextView {
  currentTaskId: string | null;
  currentTaskKind: string | null;
  currentTaskState: 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled' | null;
}

// ──────────────────────────────────────────────────────────────────
// ActionRequest · 所有"想做事"的统一格式
// ──────────────────────────────────────────────────────────────────

export type ActionType =
  | 'move_to'
  | 'goto_position'
  | 'follow_entity'
  | 'stop_follow'
  | 'attack'
  | 'say'
  | 'stop'
  | 'equip'
  | 'use_tool'
  | 'place_block'
  | 'dig'
  | 'craft'
  | 'smelt'
  | 'walk'
  | 'mine_to'
  | 'escape_pit'
  | 'look_at'
  | 'invoke_behavior'
  // FEAT-L3-02 生存技能：吃 / 睡 / 起床
  | 'eat'
  | 'sleep'
  | 'wake'
  // FEAT-L3-03 箱子存取
  | 'deposit'
  | 'withdraw'
  // FEAT-L3-07 自动装备最佳盔甲（按 armorPoints 排序逐槽位选最佳）
  | 'equip_best_armor'
  // FEAT-L3-05 钓鱼（抛钩 → 等 → 收杆 · 当前无咬钩感知）
  | 'fish'
  // FEAT-L3-08 垂直移动：爬梯/塔升/挖下/搭脚手架
  | 'climb_up'
  | 'pillar_up'
  | 'dig_down'
  | 'place_scaffold'
  // FEAT-L3-09 载具骨架（mount/dismount 当前 adapter_unsupported · vehicle_goto = move_to 别名）
  | 'mount'
  | 'dismount'
  | 'vehicle_goto'
  // FEAT-L3-12 战斗完善：拉怪 / 格挡 / 弓箭 / 暴击跳劈
  | 'kite'
  | 'block_with_shield'
  | 'bow_shoot'
  | 'crit_jump_attack'
  // FEAT-L3-13 · 把物品扔出去交给玩家（默认主人）· target: itemName + count? + entityId/position?
  | 'toss_item';

export type Resource = 'movement' | 'inventory' | 'vision';

export interface ActionRequest {
  /** 去重 id */
  id: string;
  /** 来源 'follow_strategy' / 'reflex.damage_revenge' / 'supervisor.recovery' */
  source: string;
  /** FEAT-CROSS-05 · 背书的 L6 任务 id（占 movement/执行锁的请求必须有）· 仲裁器据此拒绝孤儿请求 */
  taskId?: string;
  /** 类型 */
  type: ActionType;
  /** 0-100 · Reflex P99 > emergency P60 > follow P40 > gather P30 */
  priority: number;
  /** soft = 等当前 atomic 结束 · hard = 立即抢占 */
  interrupt_level: 'soft' | 'hard';
  /** 占用资源 · 用来检测冲突 */
  resource: Resource[];
  /** 目标参数 */
  target?: {
    entityId?: number;
    position?: Vec3;
    /** move_to/goto_position 的到达半径；省略时保持默认 1 格。 */
    range?: number;
    text?: string; // for 'say'
    itemName?: string; // for 'equip' / 'place_block'
    behavior?: string; // for 'invoke_behavior' — skill id to look up in BehaviorRegistry
    behaviorParams?: Record<string, unknown>; // for 'invoke_behavior' — forwarded as BehaviorContext.taskParams
    faceVector?: Vec3; // for 'place_block' — which face to place against (e.g. {x:0,y:1,z:0} = top)
    referencePosition?: Vec3; // for 'place_block' — position of the reference block to place against
    count?: number; // for 'craft' / 'smelt' — number of operations / items to smelt
    /** BUG-CROSS-09 · craft 递归求解的目标库存总数；物理合成次数仍由 count/Resolver step 决定。 */
    inventoryTargetCount?: number;
    needTable?: boolean; // for 'craft' — whether a crafting table is required
    tablePos?: Vec3; // for 'craft' — crafting table position; for 'smelt' — furnace position
    fuelName?: string; // for 'smelt' — fuel item (coal/charcoal/planks…)
    durationMs?: number; // for 'walk' — how long to walk forward (ms); also reused by 'fish' / 'block_with_shield'
    backDurationMs?: number; // for 'kite' — how long to walk backwards after the swing (ms)
    drawMs?: number; // for 'bow_shoot' — how long to charge the bow (ms)
    forceRepath?: boolean; // for 'follow_entity' — BUG-L5-02：强制重设 GoalFollow（绕过幂等 no-op），跟手重算
  };
  /** 前置条件 · 名字列表，Arbitrator 来 WorldState 查 */
  preconditions: string[];
  /** 期望效果（评测用，可选） */
  expected_effect?: string[];
  /** 超时毫秒，超出 Supervisor 介入 */
  timeout_ms: number;
}

// ──────────────────────────────────────────────────────────────────
// 仲裁结果 / 执行结果
// ──────────────────────────────────────────────────────────────────

export interface ArbitrationResult {
  /** 本 tick 的胜出请求（按提交顺序：高优先级在前，可有多个资源不冲突的并行） */
  winners: ActionRequest[];
  /** 被拒绝的请求（含原因） */
  rejected: Array<{ request: ActionRequest; reason: string }>;
}

export interface ExecutionResult {
  ok: boolean;
  request: ActionRequest;
  /** 执行耗时 ms */
  durationMs: number;
  /** 失败原因 */
  error?: string;
}
