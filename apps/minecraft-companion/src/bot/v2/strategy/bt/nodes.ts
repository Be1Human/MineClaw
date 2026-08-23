/**
 * 🌳 BT 节点契约 · 类型定义
 *
 * BtNode  · 所有节点实现的统一接口（Composite / Decorator / Leaf）
 * BtContext · tick() 接收的上下文（含 requests 缓冲区）
 * BtDebug · 调试信息（activeActions / lastFailure）
 *
 * 设计约定：
 *   - Action 节点把 ActionRequest 推进 ctx.requests，返回 'running'
 *   - Condition 节点只读 WorldState，返回 'success' | 'failure'，绝不推请求
 *   - Composite / Decorator 节点永远不直接 emit，靠子节点 emit
 */

import type { WorldStateView, ActionRequest } from '../../types.js';

// ──────────────────────────────────────────────────────────────────
// BT 三态
// ──────────────────────────────────────────────────────────────────

export type BtStatus = 'success' | 'failure' | 'running';

// ──────────────────────────────────────────────────────────────────
// 调试信息（每 tick 重置）
// ──────────────────────────────────────────────────────────────────

export interface BtDebug {
  /** 本 tick 内实际 emit 了请求的 action 节点标签列表 */
  activeActions: string[];
  /** 上一次节点失败记录（跨 tick 保持，方便调试） */
  lastFailure: { node: string; tick: number; reason?: string } | null;
}

// ──────────────────────────────────────────────────────────────────
// BT tick 上下文
// ──────────────────────────────────────────────────────────────────

export interface BtContext {
  /** 当前 WorldState 快照（只读） */
  world: WorldStateView;
  /** 当前 tick 号 */
  tick: number;
  /** Action 节点把 ActionRequest 推到这里；BtStrategy.tick() 统一收割 */
  requests: ActionRequest[];
  /** 调试信息缓冲区（由 BtStrategy 初始化，runner 写入） */
  debug: BtDebug;
}

// ──────────────────────────────────────────────────────────────────
// BtNode · 所有节点的统一接口
// ──────────────────────────────────────────────────────────────────

export interface BtNode {
  /** 调试标签（在 lastFailure / inspect 中显示） */
  readonly label: string;
  /** 执行节点逻辑，返回三态 */
  tick(ctx: BtContext): BtStatus;
  /** 重置内部状态（running 索引、计时器等） */
  reset(): void;
}
