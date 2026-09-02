import { randomUUID } from 'node:crypto';
import type { GameView } from '../../../../../../apps/minecraft-companion/src/bot/adapter/GameAdapter.js';
import type { GameActions } from '../../../../../../apps/minecraft-companion/src/bot/adapter/GameActions.js';
import type { NavigationActions } from '../../../../../../apps/minecraft-companion/src/bot/adapter/NavigationExecution.js';
import type { EventBusV2 } from '../../../../../../apps/minecraft-companion/src/bot/v2/infra/eventBus.js';
import type { ActionRequest, WorldStateView } from '../../../../../../apps/minecraft-companion/src/bot/v2/types.js';
import type { IBehaviorRegistry } from '../../../../../../apps/minecraft-companion/src/bot/v2/behavior/types.js';
import { BehaviorRunner } from '../../../../../../apps/minecraft-companion/src/bot/v2/behavior/behaviorRunner.js';
import { executeAtomic } from '../../../../../../apps/minecraft-companion/src/bot/v2/atomic/atomics.js';
import { BodyExecutionRuntime } from '../../../../../../apps/minecraft-companion/src/bot/v2/task/execution/bodyExecutionRuntime.js';
import { ExecutionAuthority } from '../../../../../../apps/minecraft-companion/src/bot/v2/task/execution/executionAuthority.js';
import { failureFromLegacy, failureDetail } from '../../../../../../apps/minecraft-companion/src/bot/v2/task/execution/failureEnvelope.js';
import type { OperationIntent } from '../../../../../../apps/minecraft-companion/src/bot/v2/task/contracts/bodyOperation.js';

/** Unit fixtures supply simulated device functions; lifetime/child tracking is the real runtime. */
export interface AtomicFixture {
  game: GameView & GameActions;
  nav: NavigationActions;
  bus: EventBusV2;
  worldState?: WorldStateView;
  behaviorRegistry?: IBehaviorRegistry;
}

export async function runControlledAtomic(request: ActionRequest, fixture: AtomicFixture) {
  const authority = new ExecutionAuthority();
  const start = Date.now();
  const runtime = new BodyExecutionRuntime({authority,driver:{
    resources:()=>['test-body'],
    bind:(_identity,command)=>({
      run:async context=>{
        const req: ActionRequest = command.ref.id==='fixture:root' ? request : {
          ...request,type:command.ref.id.slice(7) as ActionRequest['type'],
          target:command.args.target as ActionRequest['target'],source:String(command.args.source),
        };
        if (req.type==='invoke_behavior') {
          const behavior=fixture.behaviorRegistry?.get(String(req.target?.behavior));
          if (!behavior) return {ok:false,failure:failureFromLegacy('behavior_not_found')};
          return new BehaviorRunner({bus:fixture.bus,getWorld:()=>fixture.worldState!}).run(behavior,{
            ...context,command:{ref:{id:`behavior:${behavior.id}`,contribution:contribution(`behavior:${behavior.id}`)},args:req.target?.behaviorParams ?? {}},
          });
        }
        // No fake no-op Context: each simulated write is effect-gated by OperationLifetime.
        const actions = new Proxy({} as GameActions,{get:(_target,key)=> (...args:unknown[])=>context.effect(()=>{
          const method=fixture.game[key as keyof GameActions] as (...a:unknown[])=>unknown;
          return method.apply(fixture.game,args);
        })});
        const result=await executeAtomic(req,{game:fixture.game,actions,nav:fixture.nav,bus:fixture.bus,
          execution:context,getWorld:()=>fixture.worldState ?? {owner:null} as WorldStateView});
        return {ok:result.ok,...(!result.ok?{failure:failureFromLegacy(result.error)}:{})};
      },
      stop:async()=>{},
    }),
  }});
  const contribution = (id: string) => ({ pluginId: 'mineclaw.legacy-builtin', pluginVersion: '1.0.0', contributionId: id, contributionVersion: '1.0.0' });
  const intent: OperationIntent={operationId:randomUUID(),owner:{kind:'task',taskId:'atomic-unit',ownerEpoch:1},
    command:{ref:{id:'fixture:root',contribution:contribution('fixture:root')},args:{}},scope:{dimension:'overworld',targetRefs:[],bindings:[]},
    deadlineAt:Date.now()+10000,budget:{maxActions:256},priority:1,preemption:'none'};
  const receipt=await runtime.submit({intent,grant:authority.issue(intent,{isCurrent:()=>true,allowsChild:()=>true})}).result;
  return {ok:receipt.status==='succeeded',request,durationMs:Date.now()-start,
    ...(receipt.failure?{error:receipt.failure.detail ?? receipt.failure.code}:{})};
}
