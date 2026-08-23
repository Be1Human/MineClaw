/**
 * L6 · StrategyExecutor —— fast-path：跑一棵命中的固化 BT（FEAT-CROSS-07 R4/R6）
 *
 * 把 BTInterpreter 接到真实执行：叶子 atomic/behavior → runAtomicOnce（心跳环外直驱，背书任务由 caller 管）；
 *   strategy → 递归（静态查环防成环）；condition/loop-until → 查 WorldState 谓词（bind 注入解析 {target}）。
 * 返回 BTResult；fast 失败由上层 router 决定降级 slow。
 */

import { BTInterpreter, type BTExecutors } from './btInterpreter.js';
import { runAtomicOnce, type AtomDispatchDeps } from '../goalRunner/atomExec.js';
import type { Strategy, BTResult } from './strategyTypes.js';
import type { WorldStateView } from '../../types.js';

export interface StrategyExecDeps {
  atom: AtomDispatchDeps;
  getStrategy: (id: string) => Strategy | undefined;
  getWorld: () => WorldStateView | null;
  /** 自定义谓词（可选）；缺省走内置 defaultCheckCondition */
  checkCondition?: (check: string, args: Record<string, unknown>, world: WorldStateView | null) => boolean;
  isPreempted?: () => boolean;
  onLog?: (m: string) => void;
}

export interface StrategyActionExecutionPort {
  execute(action: string, args: Record<string, unknown>): Promise<{ ok: boolean; detail: string }>;
}

export class StrategyExecutor {
  private seq = 0;
  constructor(private readonly deps: StrategyExecDeps) {}

  async run(
    strategy: Strategy,
    bind: Record<string, unknown>,
    isPreempted?: () => boolean,
    actionPort?: StrategyActionExecutionPort,
  ): Promise<BTResult> {
    const interp = new BTInterpreter(this.buildExecutors(bind, new Set([strategy.id]), isPreempted, actionPort));
    return interp.run(strategy.bt, bind);
  }

  private buildExecutors(
    bind: Record<string, unknown>,
    stack: Set<string>,
    runIsPreempted?: () => boolean,
    actionPort?: StrategyActionExecutionPort,
  ): BTExecutors {
    const eid = () => `bt-${++this.seq}-${Date.now()}`;
    return {
      runAtomic: (atomic, args) => actionPort?.execute(atomic, args)
        ?? runAtomicOnce(atomic, args, eid(), this.deps.atom),
      runBehavior: (behavior, args) => actionPort?.execute('invoke_behavior', { behavior, behaviorParams: args })
        ?? runAtomicOnce('invoke_behavior', { behavior, behaviorParams: args }, eid(), this.deps.atom),
      runStrategy: async (id, args) => {
        if (stack.has(id)) { this.deps.onLog?.(`[strategy] 递归成环 ${id} → 拒绝`); return { status: 'failure', detail: 'cycle' }; }
        const sub = this.deps.getStrategy(id);
        if (!sub) return { status: 'failure', detail: `no strategy ${id}` };
        const interp = new BTInterpreter(this.buildExecutors(
          { ...bind, ...args }, new Set([...stack, id]), runIsPreempted, actionPort));
        return interp.run(sub.bt, { ...bind, ...args });
      },
      // 谓词求值：bind 注入（loop until 空参时也能拿到 {target}），args 覆盖 bind
      checkCondition: (check, args) => {
        const world = this.deps.getWorld();
        const merged = { ...bind, ...args };
        return this.deps.checkCondition
          ? this.deps.checkCondition(check, merged, world)
          : defaultCheckCondition(check, merged, world);
      },
      isPreempted: runIsPreempted ?? this.deps.isPreempted,
      onLog: this.deps.onLog,
    };
  }
}

/** 内置常用谓词：查 WorldState 推 has_item / hp_below / target_dead / reached */
export function defaultCheckCondition(check: string, args: Record<string, unknown>, world: WorldStateView | null): boolean {
  if (!world) return false;
  switch (check) {
    case 'has_item': {
      const item = String(args.item ?? '');
      const need = Number(args.count ?? 1);
      const have = (world.inventory?.items ?? []).filter(i => i.name === item).reduce((s, i) => s + i.count, 0);
      return have >= need;
    }
    case 'hp_below': {
      const th = Number(args.value ?? args.hp ?? 0);
      return (world.self?.health ?? 20) < th;
    }
    case 'target_dead':
    case 'target_dead_or_fled': {
      const t = args.target ?? args.entity ?? args.entityId;
      if (t == null) return false;
      const alive = (world.entities ?? []).some(e => String(e.id) === String(t) || e.name === String(t));
      return !alive;
    }
    case 'reached': {
      const self = world.self?.position;
      const p = args.position as { x: number; y: number; z: number } | undefined;
      if (!self || !p) return false;
      return Math.hypot(self.x - p.x, self.y - p.y, self.z - p.z) <= Number(args.radius ?? 2);
    }
    default:
      return false;
  }
}
