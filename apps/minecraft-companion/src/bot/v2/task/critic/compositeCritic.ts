/**
 * L6 · CompositeCritic · 多 Critic 聚合（多数投票）
 *
 * 算法：
 *   1. 收集所有子 Critic 的 Verdict
 *   2. 统计 success / partial / fail 票数（unknown 忽略）
 *   3. 取最高票数的状态作为最终结论；平票取优先级高的（success > partial > fail）
 *   4. 若全部为 unknown → 返回 unknown
 */

import type { WorldStateView } from '../../types.js';
import type { Task } from '../taskRuntime.js';
import type { ICritic, Verdict, VerdictStatus } from './types.js';

export class CompositeCritic implements ICritic {
  readonly id: string;
  private critics: ICritic[];

  constructor(id: string, critics: ICritic[]) {
    this.id = id;
    this.critics = critics;
  }

  verify(task: Task, before: WorldStateView, after: WorldStateView): Verdict {
    const verdicts = this.critics.map((c) => c.verify(task, before, after));

    const counts: Record<VerdictStatus, number> = {
      success: 0,
      partial: 0,
      fail: 0,
      unknown: 0,
    };

    for (const v of verdicts) {
      counts[v.status]++;
    }

    // 多数投票：忽略 unknown，从 success/partial/fail 中取最高票
    let best: VerdictStatus = 'unknown';
    let maxCount = 0;

    for (const s of ['success', 'partial', 'fail'] as VerdictStatus[]) {
      if (counts[s] > maxCount) {
        maxCount = counts[s];
        best = s;
      }
    }

    return {
      taskId: task.id,
      taskKind: task.kind,
      status: best,
      reason: `composite vote: ${JSON.stringify(counts)}`,
      evaluatedAt: Date.now(),
      metrics: {
        counts,
        verdicts: verdicts.map((v) => v.status),
      },
    };
  }
}
