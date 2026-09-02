import type { Vec3, MovementOptions, Unsubscribe } from './types.js';
import type { BoundNavigation, NavigationBindingInput, NavigationView } from './NavigationExecution.js';

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

/** Live observation/configuration only; physical work requires an operation binding. */
export interface NavigationAdapter extends NavigationView {
  bind(input: NavigationBindingInput): BoundNavigation;
  /** Configuration is stored for subsequent plans; it does not start or stop movement. */
  setMovementOptions(options: MovementOptions): void;
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
