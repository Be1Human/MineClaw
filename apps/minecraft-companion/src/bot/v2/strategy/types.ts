/**
 * L5 · Strategy 决策策略层 · 契约
 *
 * 关键规则：策略只产 ActionRequest，不直接执行。
 * 由 Heartbeat ⑦ Arbitrate 决定谁动手。
 *
 * 三种策略实现：
 *   🎚 FSM  · StatefulStrategy<S>  · 简单线性行为（跟随 / 种田 / 闲置）
 *   🌳 BT   · BtStrategy           · 复杂决策（守卫 / 战斗 / 建造）  ★ 主力
 *   ⚡ 事件 · IEventDrivenStrategy  · 反射层（被怪打 / 血量危急）
 */

import type { ActionRequest, WorldStateView, BusEvent } from '../types.js';

// ──────────────────────────────────────────────────────────────────
// 策略算法类型标签
// ──────────────────────────────────────────────────────────────────

export type StrategyKind = 'fsm' | 'bt' | 'rl' | 'reflex' | 'rule';

// ──────────────────────────────────────────────────────────────────
// 策略上下文（每 tick 传入）
// ──────────────────────────────────────────────────────────────────

export interface StrategyContext {
  world: WorldStateView;
  /** 当前 tick 号 */
  tick: number;
  /** 当前激活的任务 id（如果有） */
  activeTaskId: string | null;
  activeTaskKind: string | null;
  /** 当前激活任务的参数（follow 用来取 targetPosition 等） */
  activeTaskParams?: Record<string, unknown> | null;
  /** FEAT-NARR-01 · 上报中性事件通知（由 Heartbeat 注入 · 缺省则不发） */
  narrate?: (intent: import('../narration/types.js').SpeechIntent) => void;
  /** FEAT-WEBUI-08 · 写当前活跃任务的人话动作（progress.phase）· 任务面板 NPC 行为展示用 · 缺省 no-op */
  setPhase?: (text: string) => void;
}

// ──────────────────────────────────────────────────────────────────
// 调试快照 · inspect() 返回值
// ──────────────────────────────────────────────────────────────────

export interface StrategyInspect {
  kind: StrategyKind;
  /**
   * 算法特定视图：
   *   FSM  → { state: string, sinceTick: number }
   *   BT   → { activeActions: string[], lastFailure: {...} | null }
   *   RL   → { topActions: string[] }
   *   rule → { matchedRules: string[] }
   */
  view: unknown;
  /** 进入当前状态的 tick（FSM / BT running 节点） */
  sinceTick?: number;
}

// ──────────────────────────────────────────────────────────────────
// IStrategy · 所有策略实现的统一接口
// ──────────────────────────────────────────────────────────────────

export interface IStrategy {
  readonly id: string;
  /** 算法类型标签 · Supervisor / 前端区分展示 */
  readonly kind: StrategyKind;

  /** 本 tick 是否激活 · TaskRuntime / EventBus 决定 */
  isActive(ctx: StrategyContext): boolean;

  /** 输出本 tick 的 ActionRequest 列表（可为空） */
  tick(ctx: StrategyContext): ActionRequest[];

  /** ★ 暴露内部状态给 Supervisor / 前端调试 */
  inspect(): StrategyInspect;

  /** 任务结束时清理内部状态（可选） */
  reset?(): void;
  /** 自动防御关闭沿清理：取消策略拥有的紧急任务并丢弃待处理事件。 */
  suspend?(): void;
}

// ──────────────────────────────────────────────────────────────────
// IEventDrivenStrategy · 事件驱动策略额外接口
// ──────────────────────────────────────────────────────────────────

/** 事件驱动策略：可被 EventBus 直接触发 onEvent */
export interface IEventDrivenStrategy extends IStrategy {
  onEvent(event: BusEvent, ctx: StrategyContext): ActionRequest[];
}

// 让未使用的导入通过（WorldStateView 被子文件 re-import，此处仅作类型锚点）
export type { WorldStateView };
