/**
 * FEAT-L6-03 阶段二 · 声明式后置验证器工厂
 *
 * 把 task.yaml 的 `postconditions` 声明编译成 PostconditionFn——
 * 新任务类型写 yaml 即得 complete() 验证门，无需改 v2Runtime 代码（OCP 收口）。
 *
 * 当前支持断言：inventory_gte（库存计数 ≥ 阈值，木头类自动"全原木求和"）。
 */

import type { WorldStateView } from '../../types.js';
import type { Task } from '../taskRuntime.js';
import type { PostconditionSpec, PostValue } from '../../knowledge/types.js';
import type { PostconditionFn } from './ruleCritic.js';
import { makeVerdict } from './ruleCritic.js';

const isLog = (n: string) => n === 'log' || n.endsWith('_log');

/** 解析 PostValue：字面量 / { fromSlot, default } → 运行时从 task.params 取 */
function resolve(v: PostValue, task: Task): unknown {
  if (v != null && typeof v === 'object' && 'fromSlot' in v) {
    const slotVal = task.params[v.fromSlot];
    return slotVal ?? v.default;
  }
  return v;
}

function sumInv(after: WorldStateView, pred: (name: string) => boolean): number {
  return after.inventory.items.filter(it => pred(it.name)).reduce((s, it) => s + it.count, 0);
}

/** 编译一组后置断言为单个 PostconditionFn（任一 fail → fail；全过 → success；无断言 → unknown） */
export function buildPostconditionFn(specs: PostconditionSpec[]): PostconditionFn {
  return (task: Task, after: WorldStateView) => {
    if (!specs.length) return makeVerdict(task, 'unknown', 'no postcondition specs');
    for (const spec of specs) {
      if (spec.type === 'inventory_gte') {
        const item = String(resolve(spec.item, task) ?? '');
        const count = Math.max(1, Number(resolve(spec.count, task) ?? 1));
        if (!item) return makeVerdict(task, 'unknown', 'inventory_gte: item 未解析');
        const have = isLog(item) ? sumInv(after, isLog) : sumInv(after, n => n === item);
        if (have < count) {
          return makeVerdict(task, 'fail', `false_success: ${item} ${have}/${count} 未达标`, { item, have, count });
        }
      }
    }
    return makeVerdict(task, 'success', 'postconditions met');
  };
}
