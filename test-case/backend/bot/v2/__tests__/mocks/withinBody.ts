import { randomUUID } from 'node:crypto';
import { BodyExecutionRuntime } from '../../../../../../apps/minecraft-companion/src/bot/v2/task/execution/bodyExecutionRuntime.js';
import { ExecutionAuthority } from '../../../../../../apps/minecraft-companion/src/bot/v2/task/execution/executionAuthority.js';
import type { ControlledExecutionContext } from '../../../../../../apps/minecraft-companion/src/bot/v2/task/execution/ports/controlledExecution.js';
import type { OperationIntent } from '../../../../../../apps/minecraft-companion/src/bot/v2/task/contracts/bodyOperation.js';

/** Exercise an operation-local component under the actual mandatory lifecycle contract. */
export async function withinBody<T>(work:(context:ControlledExecutionContext)=>Promise<T>):Promise<T> {
  const authority=new ExecutionAuthority(); let result:T;
  const runtime=new BodyExecutionRuntime({authority,driver:{resources:()=>['test-body'],bind:()=>({
    run:async context=>{result=await work(context);return {ok:true};},stop:async()=>{},
  })}});
  const intent:OperationIntent={operationId:randomUUID(),owner:{kind:'task',taskId:'unit',generation:1},
    command:{ref:{id:'unit',version:'1'},args:{}},scope:{dimension:'overworld',targetRefs:[],bindings:[]},
    deadlineAt:Date.now()+20000,budget:{maxActions:256},priority:1,preemption:'none'};
  const receipt=await runtime.submit({intent,grant:authority.issue(intent,{isCurrent:()=>true,allowsChild:()=>false})}).result;
  if(receipt.status!=='succeeded')throw new Error(receipt.failure?.detail ?? receipt.status);
  return result!;
}
