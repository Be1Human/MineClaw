/**
 * v2 · L5 Strategy Layer · 统一出口
 *
 * 接口 / 基类：
 *   IStrategy, IEventDrivenStrategy, StrategyContext, StrategyInspect, StrategyKind
 *   StatefulStrategy<S>   FSM 基类
 *   BtStrategy            BT 基类
 *
 * 内置策略：
 *   FollowStrategy   FSM · 跟随 owner
 *   FarmStrategy     FSM · 种田
 *   ReflexStrategy   reflex · 反射反击
 *   GuardStrategy    BT  · 守卫区域（标杆实现）
 *
 * BT Runner（工厂函数）：
 *   seq, sel, parallel, cond, action, cooldown, timeLimit, inv, repeat
 */

// ── 接口 / 类型 ─────────────────────────────────────────────────
export type {
  IStrategy,
  IEventDrivenStrategy,
  StrategyContext,
  StrategyInspect,
  StrategyKind,
} from './types.js';

// ── FSM 基类 ────────────────────────────────────────────────────
export { StatefulStrategy } from './fsm/StatefulStrategy.js';

// ── BT 基础设施 ─────────────────────────────────────────────────
export type { BtNode, BtContext, BtDebug, BtStatus } from './bt/nodes.js';
export { BtStrategy } from './bt/BtStrategy.js';
export {
  seq, sel, parallel,
  cond, action,
  cooldown, timeLimit, inv, repeat,
} from './bt/runner.js';

// ── 内置策略 ────────────────────────────────────────────────────
export { FollowStrategy }       from './followStrategy.js';
export type { FollowState }     from './followStrategy.js';
export { FarmStrategy }         from './farmStrategy.js';
export { ReflexStrategy }       from './reflexStrategy.js';
export { GuardStrategy }        from './guard/GuardStrategy.js';
export type { GuardConfig }     from './guard/GuardStrategy.js';
