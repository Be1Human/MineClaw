import assert from 'node:assert/strict';
import { describe,it } from 'node:test';
import type { TaskSnapshot } from '../../../../../../apps/minecraft-companion/src/bot/v2/infra/memory.js';
import { reconcileTaskSnapshots } from '../../../../../../apps/minecraft-companion/src/bot/v2/decision/runtimeStateReconciler.js';

const snap=(taskId:string,state:TaskSnapshot['state'],updatedAt=1):TaskSnapshot=>({taskId,kind:'follow_owner',state,createdAt:0,updatedAt});

describe('RuntimeStateReconciler',()=>{
  it('只恢复有显式断点的 paused，旧 running/pending 标为 interrupted',()=>{
    const plan=reconcileTaskSnapshots([snap('paused','paused'),snap('running','running'),snap('pending','pending'),snap('done','completed')]);
    assert.deepEqual(plan.resumable.map(x=>x.taskId),['paused']);
    assert.deepEqual(plan.dormant,[]);
    assert.deepEqual(plan.discardedProjections,[]);
    assert.deepEqual(plan.interrupted.map(x=>x.taskId),['running','pending']);
    assert.deepEqual(plan.ignoredTerminal.map(x=>x.taskId),['done']);
  });

  it('同 taskId 只采用 updatedAt 最新快照',()=>{
    const plan=reconcileTaskSnapshots([snap('same','running',1),snap('same','paused',2)]);
    assert.deepEqual(plan.resumable.map(x=>x.taskId),['same']);
    assert.equal(plan.interrupted.length,0);
  });

  it('BUG-CROSS-55-006 · explicit 暂停休眠，automatic 暂停恢复，goal_exec 旧投影丢弃',()=>{
    const explicit={...snap('explicit','paused'),resumePoint:{reason:'need_owner',__taskResumePolicy:'explicit'}};
    const automatic={...snap('automatic','paused'),resumePoint:{reason:'preempted',__taskResumePolicy:'automatic'}};
    const goalProjection={...snap('goal-projection','paused'),kind:'goal_exec',resumePoint:{reason:'need_owner',__taskResumePolicy:'explicit'}};
    const plan=reconcileTaskSnapshots([explicit,automatic,goalProjection]);

    assert.deepEqual(plan.resumable.map(x=>x.taskId),['automatic']);
    assert.deepEqual(plan.dormant.map(x=>x.taskId),['explicit']);
    assert.deepEqual(plan.discardedProjections.map(x=>x.taskId),['goal-projection']);
  });
});
