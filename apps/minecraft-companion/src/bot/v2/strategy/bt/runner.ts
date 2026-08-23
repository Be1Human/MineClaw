/**
 * 🌳 BT Runner · 节点工厂函数集
 *
 * 所有工厂函数都返回 BtNode，调用方用函数组合拼出任意深度的行为树：
 *
 *   sel('root', [
 *     seq('combat', [ cond('hostile_near', ...), cooldown(1200, action('attack', ...)) ]),
 *     seq('patrol',  [ cond('has_center', ...), cooldown(8000, action('move', ...)) ]),
 *   ])
 *
 * 节点类型（最小集）：
 *   Composite : seq / sel / parallel
 *   Decorator : cooldown / timeLimit / inv / repeat
 *   Leaf      : cond / action
 *
 * 约定：
 *   - Action  节点 → emit ActionRequest 到 ctx.requests，返回 'running'
 *     若 fn 返回 null（条件不满足），返回 'failure'
 *   - Condition节点 → 只读 WorldState，返回 'success'|'failure'，绝不 emit
 *   - Composite 使用"有记忆"模式：记住上次 running 的子节点索引，下 tick 续跑
 */

import type { BtNode, BtContext, BtStatus } from './nodes.js';
import type { ActionRequest } from '../../types.js';

// ──────────────────────────────────────────────────────────────────
// Composite Nodes
// ──────────────────────────────────────────────────────────────────

/**
 * Sequence（与门）· 所有子节点依次成功才 success。
 * 记忆模式：记住上次 running 的子节点，下 tick 从该节点续跑。
 * 任何子节点 failure → 重置索引，返回 failure。
 */
export function seq(label: string, children: BtNode[]): BtNode {
  let runningIdx = 0;
  return {
    label,
    tick(ctx: BtContext): BtStatus {
      for (let i = runningIdx; i < children.length; i++) {
        const status = children[i].tick(ctx);
        if (status === 'running') {
          runningIdx = i;
          return 'running';
        }
        if (status === 'failure') {
          ctx.debug.lastFailure = {
            node: `${label}[${i}]:${children[i].label}`,
            tick: ctx.tick,
          };
          runningIdx = 0;
          return 'failure';
        }
        // success → 继续下一个
      }
      runningIdx = 0;
      return 'success';
    },
    reset() {
      runningIdx = 0;
      for (const c of children) c.reset();
    },
  };
}

/**
 * Selector（或门）· 第一个成功的子节点 → success。
 * 记忆模式：记住上次 running 的子节点，下 tick 从该节点续跑。
 * 所有子节点都 failure → failure。
 */
export function sel(label: string, children: BtNode[]): BtNode {
  let runningIdx = 0;
  return {
    label,
    tick(ctx: BtContext): BtStatus {
      for (let i = runningIdx; i < children.length; i++) {
        const status = children[i].tick(ctx);
        if (status === 'running') {
          runningIdx = i;
          return 'running';
        }
        if (status === 'success') {
          runningIdx = 0;
          return 'success';
        }
        // failure → 试下一个
      }
      runningIdx = 0;
      return 'failure';
    },
    reset() {
      runningIdx = 0;
      for (const c of children) c.reset();
    },
  };
}

/**
 * Parallel · 每 tick 同时 tick 所有子节点。
 * policy='all_success'  → 全部 success 才 success；任一 failure → failure
 * policy='any_success'  → 任一 success 即 success；全部 failure → failure
 * 只要有任一 running，整体返回 running（仍继续推进其余子节点）。
 */
export function parallel(
  label: string,
  policy: 'all_success' | 'any_success',
  children: BtNode[],
): BtNode {
  return {
    label,
    tick(ctx: BtContext): BtStatus {
      const results: BtStatus[] = children.map(c => c.tick(ctx));
      if (results.some(r => r === 'running')) return 'running';
      if (policy === 'all_success') {
        return results.every(r => r === 'success') ? 'success' : 'failure';
      }
      // any_success
      return results.some(r => r === 'success') ? 'success' : 'failure';
    },
    reset() {
      for (const c of children) c.reset();
    },
  };
}

// ──────────────────────────────────────────────────────────────────
// Decorator Nodes
// ──────────────────────────────────────────────────────────────────

/**
 * Cooldown · 最多每 ms 执行一次。
 * 在冷却期间直接返回 'failure'（子节点不执行）。
 * 子节点执行且返回非 failure 时才刷新计时。
 */
export function cooldown(ms: number, child: BtNode): BtNode {
  let lastFiredAt = 0;
  return {
    label: `Cooldown(${ms}ms)[${child.label}]`,
    tick(ctx: BtContext): BtStatus {
      if (Date.now() - lastFiredAt < ms) return 'failure';
      const status = child.tick(ctx);
      if (status !== 'failure') lastFiredAt = Date.now();
      return status;
    },
    reset() {
      lastFiredAt = 0;
      child.reset();
    },
  };
}

/**
 * TimeLimit · 子节点累计运行超过 ms → 强制 failure。
 * 用于防止 running 状态永不结束的 Action 节点挂死树。
 */
export function timeLimit(ms: number, child: BtNode): BtNode {
  let startedAt = 0;
  return {
    label: `TimeLimit(${ms}ms)[${child.label}]`,
    tick(ctx: BtContext): BtStatus {
      if (startedAt === 0) startedAt = Date.now();
      if (Date.now() - startedAt > ms) {
        ctx.debug.lastFailure = { node: child.label, tick: ctx.tick, reason: 'time_limit' };
        startedAt = 0;
        child.reset();
        return 'failure';
      }
      const status = child.tick(ctx);
      if (status !== 'running') startedAt = 0;
      return status;
    },
    reset() {
      startedAt = 0;
      child.reset();
    },
  };
}

/**
 * Inverter · 翻转 success/failure，running 透传。
 */
export function inv(child: BtNode): BtNode {
  return {
    label: `Inv[${child.label}]`,
    tick(ctx: BtContext): BtStatus {
      const s = child.tick(ctx);
      if (s === 'success') return 'failure';
      if (s === 'failure') return 'success';
      return 'running';
    },
    reset() {
      child.reset();
    },
  };
}

/**
 * Repeat · 成功 N 次后返回 success。
 * 子节点 failure 立即中止，返回 failure。
 */
export function repeat(times: number, child: BtNode): BtNode {
  let count = 0;
  return {
    label: `Repeat(${times})[${child.label}]`,
    tick(ctx: BtContext): BtStatus {
      if (count >= times) { count = 0; return 'success'; }
      const s = child.tick(ctx);
      if (s === 'success') {
        count++;
        if (count >= times) { count = 0; return 'success'; }
        return 'running';
      }
      if (s === 'failure') { count = 0; return 'failure'; }
      return 'running';
    },
    reset() {
      count = 0;
      child.reset();
    },
  };
}

// ──────────────────────────────────────────────────────────────────
// Leaf Nodes
// ──────────────────────────────────────────────────────────────────

/**
 * Condition · 纯谓词检查，返回 success/failure。
 * 绝对不能 emit ActionRequest（只读）。
 */
export function cond(
  label: string,
  fn: (ctx: BtContext) => boolean,
): BtNode {
  return {
    label,
    tick(ctx: BtContext): BtStatus {
      return fn(ctx) ? 'success' : 'failure';
    },
    reset() { /* stateless */ },
  };
}

/**
 * Action · 核心 emit 节点。
 *
 * fn 返回：
 *   ActionRequest | ActionRequest[]  → push 到 ctx.requests，返回 'running'
 *   null                             → 条件不满足，返回 'failure'（不 emit）
 *
 * 返回 'running' 意味着"已发出请求，等待 Arbitrator 处理"。
 * 注意：Action 节点本身是无状态的；持续行动用 cooldown 包装控制频率。
 */
export function action(
  label: string,
  fn: (ctx: BtContext) => ActionRequest | ActionRequest[] | null,
): BtNode {
  return {
    label,
    tick(ctx: BtContext): BtStatus {
      const result = fn(ctx);
      if (result === null) return 'failure';
      if (Array.isArray(result)) {
        ctx.requests.push(...result);
      } else {
        ctx.requests.push(result);
      }
      ctx.debug.activeActions.push(label);
      return 'running';
    },
    reset() { /* stateless */ },
  };
}
