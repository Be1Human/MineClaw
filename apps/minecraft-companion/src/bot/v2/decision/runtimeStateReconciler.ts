import type { TaskSnapshot } from '../infra/memory.js';
import { taskResumePolicyFromSnapshot } from '../task/taskRuntime.js';

export interface RuntimeReconciliationPlan {
  resumable: TaskSnapshot[];
  dormant: TaskSnapshot[];
  discardedProjections: TaskSnapshot[];
  interrupted: TaskSnapshot[];
  ignoredTerminal: TaskSnapshot[];
}

/**
 * 进程重启后 Memory 只是“上次所知状态”，不是当前运行事实。
 * paused 有显式断点可恢复；running/pending 的执行 handle 已随进程消失，必须先判 interrupted。
 */
export function reconcileTaskSnapshots(snapshots: TaskSnapshot[]): RuntimeReconciliationPlan {
  const latest = new Map<string,TaskSnapshot>();
  for (const snapshot of snapshots) {
    const current=latest.get(snapshot.taskId);
    if (!current || snapshot.updatedAt >= current.updatedAt) latest.set(snapshot.taskId,snapshot);
  }
  const values=[...latest.values()];
  const paused=values.filter(item=>item.state==='paused');
  return {
    resumable:paused.filter(item=>
      item.kind!=='goal_exec' && taskResumePolicyFromSnapshot(item)!=='explicit'),
    dormant:paused.filter(item=>
      item.kind!=='goal_exec' && taskResumePolicyFromSnapshot(item)==='explicit'),
    discardedProjections:paused.filter(item=>item.kind==='goal_exec'),
    interrupted:values.filter(item=>item.state==='running'||item.state==='pending'),
    ignoredTerminal:values.filter(item=>['completed','failed','cancelled'].includes(item.state)),
  };
}
