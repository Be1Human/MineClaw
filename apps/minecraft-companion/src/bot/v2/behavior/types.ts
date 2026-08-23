/**
 * L4 Skill 层 · 接口契约
 *
 * IBehavior 是"一次性任务步骤复合行为"：
 *   - 接收 BehaviorContext（WorldState + 任务参数）
 *   - 返回 ActionRequest[]（供仲裁器执行）
 *   - 不 tick，不持续运行（区别于 L5 BtStrategy）
 */

import type {
  WorldStateView,
  ActionRequest,
  ExecutionResult,
  EventLevel,
} from '../types.js';

// ──────────────────────────────────────────────────────────────────
// BehaviorContext · plan() 入参
// ──────────────────────────────────────────────────────────────────

export interface BehaviorContext {
  /** 当前世界状态快照（只读） */
  world: WorldStateView;
  /** 调用方传入的任务参数 */
  taskParams?: Record<string, unknown>;
}

export interface AdaptiveBehaviorResult {
  ok: boolean;
  error?: string;
  details?: Record<string, unknown>;
}

/**
 * Optional runtime port for stateful behaviors that must observe the world
 * between short atomic actions. The executor remains the only layer allowed
 * to touch the game adapter.
 */
export interface AdaptiveBehaviorContext {
  taskParams?: Record<string, unknown>;
  getWorld(): WorldStateView;
  execute(request: ActionRequest): Promise<ExecutionResult>;
  publish(type: string, level: EventLevel, payload: Record<string, unknown>): void;
}

// ──────────────────────────────────────────────────────────────────
// IBehavior · 单个技能契约
// ──────────────────────────────────────────────────────────────────

export interface IBehavior {
  /** 全局唯一 id，BehaviorRegistry 按此查找 */
  readonly id: string;
  /**
   * 规划：根据当前 WorldState 和任务参数，生成 ActionRequest 列表。
   * 返回空数组表示"无事可做"（正常静默），不得抛异常。
   */
  plan(ctx: BehaviorContext): ActionRequest[];
  /** Stateful execution is opt-in; static behaviors keep the plan() path. */
  run?(ctx: AdaptiveBehaviorContext): Promise<AdaptiveBehaviorResult>;
}

// ──────────────────────────────────────────────────────────────────
// IBehaviorRegistry · 注册表契约
// ──────────────────────────────────────────────────────────────────

export interface IBehaviorRegistry {
  /** 注册（同 id 覆盖） */
  register(skill: IBehavior): void;
  /** 按 id 查找，找不到返回 undefined */
  get(id: string): IBehavior | undefined;
  /** 列出所有已注册技能 */
  list(): IBehavior[];
  /** 清空（测试用） */
  clear(): void;
}
