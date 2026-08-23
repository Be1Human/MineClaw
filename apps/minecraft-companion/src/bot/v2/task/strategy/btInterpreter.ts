/**
 * L6 · BTInterpreter（FEAT-CROSS-07 R3）—— 数据驱动行为树解释器。
 *
 * 把 `strategyTypes.ts` 里的纯数据 BTNode 树解释执行成真实动作：
 *   sequence / fallback / condition / action / loop 五类节点，
 *   叶子动作三选一执行源（atomic | behavior | strategy 递归）。
 *
 * 设计要点：
 *   - 执行器全部注入（BTExecutors），便于 mock 单测，框架层不耦合具体实现。
 *   - 参数绑定：args 里 `"{xxx}"` / `"${xxx}"` 整串占位符 → bindings[xxx] 替换后再传执行器。
 *   - 抢占：每个节点执行前查 isPreempted()，真 → 立即返回 {status:'preempted'} 逐层冒泡。
 */

import type {
  BTNode,
  BTSequence,
  BTFallback,
  BTCondition,
  BTAction,
  BTLoop,
  BTResult,
} from './strategyTypes.js';

/** 注入的一组执行器（全 async / 可 mock）。 */
export interface BTExecutors {
  /** 执行原子动作。 */
  runAtomic: (atomic: string, args: Record<string, unknown>) => Promise<{ ok: boolean; detail?: string }>;
  /** 执行 L4 behavior。 */
  runBehavior: (behavior: string, args: Record<string, unknown>) => Promise<{ ok: boolean; detail?: string }>;
  /** 递归执行另一棵固化 strategy（直接返回 BTResult）。 */
  runStrategy: (strategyId: string, args: Record<string, unknown>) => Promise<BTResult>;
  /** 求值条件谓词（查世界状态）。 */
  checkCondition: (check: string, args: Record<string, unknown>) => boolean | Promise<boolean>;
  /** 紧急反射抢占检查；返回 true → 立即中止返回 status:'preempted'。 */
  isPreempted?: () => boolean;
  /** 调试日志。 */
  onLog?: (m: string) => void;
}

const DEFAULT_MAX_ITERATIONS = 100;
const BRACED_PLACEHOLDER_RE = /^(?:\$)?\{([A-Za-z_][A-Za-z0-9_]*)\}$/;
const DOLLAR_PLACEHOLDER_RE = /^\$([A-Za-z_][A-Za-z0-9_]*)(?:\[(\d+)\])?$/;

/**
 * 深度遍历 args，把整串形如 `"{xxx}"` 或 `"${xxx}"` 的占位符替换为 bindings[xxx]。
 * 仅替换「整个字符串就是一个占位符」的情况；其余字符串/标量原样保留。
 */
export function bindArgs(
  value: unknown,
  bindings: Record<string, unknown>,
): unknown {
  if (typeof value === 'string') {
    const braced = BRACED_PLACEHOLDER_RE.exec(value);
    if (braced) {
      const key = braced[1]!;
      return key in bindings ? bindings[key] : value;
    }
    const dollar = DOLLAR_PLACEHOLDER_RE.exec(value);
    if (dollar) {
      const key = dollar[1]!;
      if (!(key in bindings)) return value;
      const bound = bindings[key];
      if (dollar[2] === undefined) return bound;
      const index = Number(dollar[2]);
      return Array.isArray(bound) && index < bound.length ? bound[index] : value;
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((v) => bindArgs(v, bindings));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = bindArgs(v, bindings);
    }
    return out;
  }
  return value;
}

function bindRecord(
  args: Record<string, unknown> | undefined,
  bindings: Record<string, unknown>,
): Record<string, unknown> {
  if (!args) return {};
  return bindArgs(args, bindings) as Record<string, unknown>;
}

export class BTInterpreter {
  constructor(private readonly exec: BTExecutors) {}

  /**
   * 解释执行一棵 BT。
   * @param bt        行为树根节点
   * @param bindings  参数绑定（替换 args 里的 `{xxx}` 占位）
   */
  async run(bt: BTNode, bindings: Record<string, unknown> = {}): Promise<BTResult> {
    return this.visit(bt, bindings, { steps: 0 });
  }

  /** steps 用引用计数器在整棵树共享，统计执行过的 action 叶子数。 */
  private async visit(
    node: BTNode,
    bindings: Record<string, unknown>,
    counter: { steps: number },
  ): Promise<BTResult> {
    // 抢占检查：每个节点执行前先看是否被紧急反射抢占。
    if (this.exec.isPreempted?.()) {
      this.log('preempted');
      return { status: 'preempted', detail: 'preempted by reflex', steps: counter.steps };
    }

    switch (node.type) {
      case 'sequence':
        return this.visitSequence(node, bindings, counter);
      case 'fallback':
        return this.visitFallback(node, bindings, counter);
      case 'condition':
        return this.visitCondition(node, bindings, counter);
      case 'action':
        return this.visitAction(node, bindings, counter);
      case 'loop':
        return this.visitLoop(node, bindings, counter);
      default: {
        // 穷尽性兜底：未知节点类型直接失败。
        const unknownType = (node as { type?: string }).type;
        return { status: 'failure', detail: `unknown node type: ${String(unknownType)}`, steps: counter.steps };
      }
    }
  }

  /** sequence：全成才成，一失败/抢占即中止。 */
  private async visitSequence(
    node: BTSequence,
    bindings: Record<string, unknown>,
    counter: { steps: number },
  ): Promise<BTResult> {
    for (const child of node.children) {
      const r = await this.visit(child, bindings, counter);
      if (r.status !== 'success') {
        // failure 或 preempted → 中止，后续不执行。
        return { status: r.status, detail: r.detail ?? 'sequence child not success', steps: counter.steps };
      }
    }
    return { status: 'success', detail: 'sequence all success', steps: counter.steps };
  }

  /** fallback：一成即成；遇 preempted 立即冒泡；全失败才失败。 */
  private async visitFallback(
    node: BTFallback,
    bindings: Record<string, unknown>,
    counter: { steps: number },
  ): Promise<BTResult> {
    let lastDetail: string | undefined;
    for (const child of node.children) {
      const r = await this.visit(child, bindings, counter);
      if (r.status === 'success') {
        return { status: 'success', detail: r.detail ?? 'fallback child success', steps: counter.steps };
      }
      if (r.status === 'preempted') {
        return { status: 'preempted', detail: r.detail, steps: counter.steps };
      }
      lastDetail = r.detail;
    }
    return { status: 'failure', detail: lastDetail ?? 'fallback all failed', steps: counter.steps };
  }

  /**
   * condition：求值 check 谓词。
   *   真 → success（继续主干）；
   *   假 → 有 fallback 子树则执行它，否则 failure。
   */
  private async visitCondition(
    node: BTCondition,
    bindings: Record<string, unknown>,
    counter: { steps: number },
  ): Promise<BTResult> {
    const args = bindRecord(node.args, bindings);
    const ok = await this.exec.checkCondition(node.check, args);
    this.log(`condition ${node.check} -> ${ok}`);
    if (ok) {
      return { status: 'success', detail: `condition ${node.check} true`, steps: counter.steps };
    }
    if (node.fallback) {
      return this.visit(node.fallback, bindings, counter);
    }
    return { status: 'failure', detail: `condition ${node.check} false (no fallback)`, steps: counter.steps };
  }

  /** action 叶子：三选一执行源 dispatch。 */
  private async visitAction(
    node: BTAction,
    bindings: Record<string, unknown>,
    counter: { steps: number },
  ): Promise<BTResult> {
    const args = bindRecord(node.args, bindings);
    counter.steps += 1;

    if (node.atomic !== undefined) {
      this.log(`atomic ${node.atomic}`);
      const r = await this.exec.runAtomic(node.atomic, args);
      return {
        status: r.ok ? 'success' : 'failure',
        detail: r.detail ?? `atomic ${node.atomic}`,
        steps: counter.steps,
      };
    }
    if (node.behavior !== undefined) {
      this.log(`behavior ${node.behavior}`);
      const r = await this.exec.runBehavior(node.behavior, args);
      return {
        status: r.ok ? 'success' : 'failure',
        detail: r.detail ?? `behavior ${node.behavior}`,
        steps: counter.steps,
      };
    }
    if (node.strategy !== undefined) {
      this.log(`strategy ${node.strategy}`);
      const r = await this.exec.runStrategy(node.strategy, args);
      // 递归 strategy 直接透传其 status（success / failure / preempted）。
      return {
        status: r.status,
        detail: r.detail ?? `strategy ${node.strategy}`,
        steps: counter.steps,
      };
    }

    // 三者都没填 → 配置错误，判失败。
    return { status: 'failure', detail: 'action has no execution source (atomic/behavior/strategy)', steps: counter.steps };
  }

  /**
   * loop：反复跑 child 直到 until 谓词为真（或到 maxIterations）。
   *   每轮：先判 until（真→success 退出）→ 再判 preempt → 再跑 child。
   *   child failure → 整个 loop failure；到上限仍未满足 until → failure。
   */
  private async visitLoop(
    node: BTLoop,
    bindings: Record<string, unknown>,
    counter: { steps: number },
  ): Promise<BTResult> {
    const max = node.maxIterations && node.maxIterations > 0 ? node.maxIterations : DEFAULT_MAX_ITERATIONS;
    // BTLoop 无 until 独立 args 字段，until 谓词以空参求值。

    for (let i = 0; i < max; i++) {
      // 1. 先判 until —— until 一开始就真则 0 次执行直接 success。
      const done = await this.exec.checkCondition(node.until, {});
      this.log(`loop until ${node.until} -> ${done} (iter ${i})`);
      if (done) {
        return { status: 'success', detail: `loop until ${node.until} satisfied @${i}`, steps: counter.steps };
      }

      // 2. 抢占检查（child 跑之前）。
      if (this.exec.isPreempted?.()) {
        return { status: 'preempted', detail: 'preempted by reflex', steps: counter.steps };
      }

      // 3. 跑一轮 child；失败即整个 loop 失败。
      const r = await this.visit(node.child, bindings, counter);
      if (r.status === 'preempted') {
        return { status: 'preempted', detail: r.detail, steps: counter.steps };
      }
      if (r.status === 'failure') {
        return { status: 'failure', detail: `loop child failed @${i}: ${r.detail ?? ''}`, steps: counter.steps };
      }
    }

    return { status: 'failure', detail: `loop ${node.until} not satisfied within ${max} iterations`, steps: counter.steps };
  }

  private log(m: string): void {
    this.exec.onLog?.(`[BT] ${m}`);
  }
}
