import test from 'node:test';
import assert from 'node:assert/strict';
import { createMockBot } from '../../../__tests__/mocks/index.js';
import { EventBusV2 } from '../../../../../../../apps/minecraft-companion/src/bot/v2/infra/eventBus.js';
import { MemoryV2 } from '../../../../../../../apps/minecraft-companion/src/bot/v2/infra/memory.js';
import { TaskRuntime } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/taskRuntime.js';
import { BodyActionService } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/execution/bodyActionService.js';
import { BehaviorRegistry } from '../../../../../../../apps/minecraft-companion/src/bot/v2/behavior/behaviorRegistry.js';
import { GoalAgentRoundLoop } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/goalAgent/goalAgentRoundLoop.js';
import { GoalAgentModelRuntime } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/goalAgent/goalAgentModelRuntime.js';
import { GoalAgentSessionStore } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/goalAgent/goalAgentSessionStore.js';
import { GoalAgentActionLedger } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/goalAgent/production/goalAgentActionLedger.js';
import { GoalAgentProductionExecutionPort,GoalAgentProductionPerceptionPort,GoalAgentProductionVerificationPort } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/goalAgent/production/goalAgentProductionPorts.js';
import { createGoalAgentState } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/goalAgent/goalAgentState.js';
import type { WorldStateView } from '../../../../../../../apps/minecraft-companion/src/bot/v2/types.js';
import type { OperationReceipt } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/contracts/operationReceipt.js';

test('production GoalAgent action_list → action_execute → body lease → device → independent verification',async()=>{
  const bot=createMockBot(),bus=new EventBusV2(),memory=new MemoryV2(':memory:');
  const store=new GoalAgentSessionStore(':memory:'),ledger=new GoalAgentActionLedger(':memory:');
  const tasks=new TaskRuntime(memory,bus),registry=new BehaviorRegistry();
  const parent=tasks.createTask('goal_exec',{goalAgentSessionId:'goal-body'});tasks.startEmergency(parent.id);
  bot.world.addItem({name:'oak_planks',count:2,slot:0});let crafts=0;
  bot.game.getCraftRecipes=item=>item==='stick'?[{result:{name:'stick',count:4},ingredients:[{name:'oak_planks',count:2}],requiresTable:false}]:[];
  bot.game.craft=async()=>{crafts++;bot.world.removeItem('oak_planks');bot.world.addItem({name:'stick',count:4,slot:0});return {ok:true};};
  const world=():WorldStateView=>({tick:crafts+1,timestamp:Date.now(),self:{...bot.world.self},owner:null,
    environment:{dimension:'overworld',isDay:true,isRaining:false,timeOfDay:6000},entities:[],
    inventory:{items:bot.game.getInventoryItems(),held:null,freeSlots:35},taskContext:null} as WorldStateView);
  let loop!:GoalAgentRoundLoop;
  const TEST_SNAPSHOT = { generationId: 'gen-test', buildId: 'test-build', graphHash: 'test-graph' };
  const body=new BodyActionService({game:bot.game,nav:bot.nav,bus,tasks,registry,getWorld:world,isEmbodied:()=>true,getGoalState:id=>loop.snapshot(id),getSnapshot:()=>TEST_SNAPSHOT});
  const receipts:OperationReceipt[]=[];bus.on('body.operation_receipt',e=>receipts.push(e.payload as unknown as OperationReceipt));
  const execution=new GoalAgentProductionExecutionPort({game:bot.game,bus,body,getWorld:world,behaviors:registry,tasks,parentTaskId:()=>parent.id,actionLedger:ledger});
  let rounds=0;
  loop=new GoalAgentRoundLoop({profileId:'body-integration',store,model:new GoalAgentModelRuntime({
    async callWithTools(input) {
      rounds++;
      if(rounds===1) return {content:'',toolCalls:[{id:'observe',name:'world_observe',arguments:{}}]};
      if(rounds===2) return {content:'',toolCalls:[{id:'list',name:'action_list',arguments:{}}]};
      assert.equal(rounds,3,'successful action must terminate by verification: '+JSON.stringify(input.messages.filter(m=>m.role==='tool').at(-1)));
      const candidates=input.messages.filter(m=>m.role==='tool').map(m=>JSON.parse(m.content)).flatMap(m=>m.candidates??[]);
      const candidate=candidates.find(c=>c.id==='atomic:craft');assert.ok(candidate?.candidateHandle);
      return {content:'',toolCalls:[{id:'execute',name:'action_execute',arguments:{candidateHandle:candidate.candidateHandle,arguments:{itemName:'stick'}}}]};
    },
  },{eventLog:store}),tools:{execution,perception:new GoalAgentProductionPerceptionPort(world),verification:new GoalAgentProductionVerificationPort(()=>[])}});
  const at=new Date().toISOString();
  const initial=createGoalAgentState({sessionId:'goal-body',interactionSessionId:'interaction-body',request:{
    meta:{schemaVersion:2,sessionId:'interaction-body',messageId:'request-body',correlationId:'correlation-body',conversationId:'conversation-body',sequence:1,emittedAt:at,idempotencyKey:'request-body'},
    origin:'player_message',originalText:'合成四根木棍',requestText:'合成四根木棍',requestKind:'task',constraints:[],
  },snapshotRef:TEST_SNAPSHOT});
  initial.rootGoal={schema:'mineclaw.goal/v1',goalId:'root-body',profileId:'body-integration',goalText:'合成四根木棍',createdAt:at,
    successCriteria:[{type:'inventory',item:'stick',count:4}]};
  try {
    loop.create(initial);const terminal=await loop.run(initial.sessionId,{maxRounds:4});
    assert.equal(terminal.phase,'completed');assert.equal(crafts,1);assert.equal(receipts.length,1);
    assert.equal(receipts[0].owner.kind,'goal');assert.equal(receipts[0].stop?.state,'quiesced');
    assert.equal(body.busy(),false);assert.ok(terminal.action.result?.evidenceRefs.some(ref=>ref.startsWith('body-operation:')));
  } finally {loop.dispose();await body.drainAll('test_end');body.close();store.close();ledger.close();memory.close();}
});
