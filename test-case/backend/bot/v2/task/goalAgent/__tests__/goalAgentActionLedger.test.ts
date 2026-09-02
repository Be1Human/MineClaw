import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import type { GoalAgentActionResult } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/goalAgent/goalAgentState.js';
import { GoalAgentActionLedger } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/goalAgent/production/goalAgentActionLedger.js';
import { GoalAgentProductionExecutionPort } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/goalAgent/production/goalAgentProductionPorts.js';

function result(key:string):GoalAgentActionResult {
  return {
    executionSessionId:`execution:${key}`,idempotencyKey:key,ok:true,detail:'done',
    startedAt:'2026-08-20T00:00:00.000Z',completedAt:'2026-08-20T00:00:01.000Z',
    evidenceRefs:[`action:${key}:ok`],
  };
}

test('action ledger persists completed replay across process instances', () => {
  const root=mkdtempSync(join(tmpdir(),'goal-action-ledger-'));
  const file=join(root,'actions.db');
  try {
    const first=new GoalAgentActionLedger(file);
    assert.deepEqual(first.begin({idempotencyKey:'k1',sessionId:'s1',epoch:1,proposal:{action:'craft'},startedAt:'now'}),{status:'new'});
    assert.deepEqual(first.begin({idempotencyKey:'k1',sessionId:'s1',epoch:1,proposal:{action:'craft'},startedAt:'later'}),{status:'in_doubt',startedAt:'now'});
    first.complete(result('k1'));
    first.close();

    const restarted=new GoalAgentActionLedger(file);
    assert.deepEqual(restarted.begin({idempotencyKey:'k1',sessionId:'s1',epoch:1,proposal:{action:'craft'},startedAt:'later'}),{
      status:'completed',result:result('k1'),
    });
    restarted.close();
  } finally {
    rmSync(root,{recursive:true,force:true});
  }
});

test('production execution never repeats an in-doubt physical action after restart', async () => {
  let physicalCalls=0;
  const port=new GoalAgentProductionExecutionPort({
    game:{} as never,bus:{} as never,getWorld:()=>{throw new Error('must not observe');},
    body:{executeGoal:async()=>{physicalCalls+=1;throw new Error('must not execute');},drainTask:async()=>{throw new Error('must not drain');}},
    behaviors:{list:()=>[]} as never,
    tasks:{} as never,
    parentTaskId:()=>null,
    actionLedger:{
      begin:()=>({status:'in_doubt',startedAt:'2026-08-20T00:00:00.000Z'}),
      complete:()=>{throw new Error('must not complete');},
    },
  });
  const action=await port.execute({
    sessionId:'s1',epoch:1,idempotencyKey:'k1',
    proposal:{source:'slow_llm',action:'craft',args:{itemName:'oak_planks'}},
    state:{} as never,signal:new AbortController().signal,
  });
  assert.equal(action.ok,false);
  assert.equal(action.failure?.code,'execution.result_unknown');
  assert.equal(action.failure?.ownerActionable,false);
  assert.equal(action.failure?.retryable,true);
  assert.equal(physicalCalls,0);
});
