/**
 * NavigationAdapter —— 寻路后端抽象
 *
 * 设计原则：
 * 1. 把 mineflayer-pathfinder 的所有 API 全部封进来，**上层零依赖 pathfinder**
 * 2. 不暴露 Goal 类型——目标用中性参数（坐标、距离阈值、实体 id）表达
 * 3. 不暴露 Movements 类型——能力开关用 MovementOptions 中性结构
 * 4. **进度事件**用回调订阅，不暴露 mineflayer 的事件名（'goal_reached'/'path_update' 等）
 *
 * 实现位置：bot/mineflayer/MineflayerNavigationAdapter.ts
 *
 * 注：smartGoto / smartFollow / navigationRouter 这些"上层寻路策略"在重构后
 * 应该依赖 NavigationAdapter 而非 mineflayer-pathfinder 本身。
 */

import type { Vec3, MovementOptions, NavResult, Unsubscribe } from './types.js';

/** 寻路目标的中性表达 */
export type NavGoal =
  | { type: 'block'; position: Vec3; range?: number }
  | { type: 'entity'; entityId: number; range?: number }
  | { type: 'player'; username: string; range?: number }
  | { type: 'follow_entity'; entityId: number; range: number }
  // 仅 X/Z 列目标（任意 Y）· 长距离地表转移用：强制真实穿越地形(翻坎/下坡/绕崖)，
  // 不会像 GoalNear 对空中航点"秒判已近不动"。
  | { type: 'xz'; x: number; z: number };

/**
 * 普通门物理通行请求。属性保持字符串形式，与 GameAdapter.getBlockProperties 一致；
 * 具体后端负责把 facing/hinge 等属性转换成安全的亚方块路径。
 */
export interface DoorPassageRequest {
  position: Vec3;
  blockName: string;
  properties: Record<string, string>;
}

export interface NavigationAdapter {
  /**
   * 启动寻路。返回 Promise 在到达 / 失败 / 被取消时 resolve。
   * 同一时刻只有一个活动寻路；调用此方法会取消上一次。
   */
  goto(goal: NavGoal, opts?: GotoOptions): Promise<NavResult>;

  /**
   * 在当前导航内部穿过一扇已打开的普通门。
   * 实现必须保留原目标；内部暂停不得让外层 goto 误报 cancelled。
   */
  guideThroughDoor(request: DoorPassageRequest): Promise<NavResult>;

  /** 主动取消当前寻路（不抛错） */
  stop(): void;

  /**
   * BUG-L5-01 · 持续跟随移动实体。
   * 设置一次 pathfinder 动态目标（dynamic goal），由 pathfinder 后台 physicsTick 持续驱动：
   * bot 进 range 内自动停、entity 走远自动追、永不 timeout。
   * 幂等：已在跟同一实体则不重设目标。直到 stopFollow() / 设置新目标才结束。
   * 与 goto() 互斥（同一时刻一个目标）。
   */
  startFollow(entityId: number, range: number, force?: boolean): { ok: boolean; reason?: string };
  /** 撤销跟随动态目标（owner 丢失 / 任务结束）。无目标时 no-op。 */
  stopFollow(): void;
  /** 当前是否正持续跟随（可指定实体 id 精确判断）。 */
  isFollowing(entityId?: number): boolean;

  /** 是否正在寻路 / 正在挖掘开路 / 正在搭桥 */
  isMoving(): boolean;
  isMining(): boolean;
  isBuilding(): boolean;

  /** 配置移动能力开关；缺省走 pathfinder 默认 */
  setMovementOptions(opts: MovementOptions): void;

  /** 当前目标（无目标时返回 null） */
  getCurrentGoal(): NavGoal | null;
  /** 当前已规划路径节点（实时随重规划而变） */
  getCurrentPath(): Vec3[];

  // ── 事件 ──────────────────────────────────────────────
  onGoalReached(handler: () => void): Unsubscribe;
  onPathUpdate(handler: (path: Vec3[]) => void): Unsubscribe;
  onPathStop(handler: (reason: string) => void): Unsubscribe;
  onGoalUpdated(handler: (goal: NavGoal | null) => void): Unsubscribe;
}

export interface GotoOptions {
  /** 思考超时毫秒，默认 5000 */
  thinkTimeout?: number;
  /** tick 超时毫秒，默认 40 */
  tickTimeout?: number;
  /** 整体导航超时毫秒 · 超过则 stop + 返回 nav_timeout · 默认 30000 */
  totalTimeout?: number;
}
