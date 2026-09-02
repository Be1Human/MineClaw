import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { BodyActionService } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/execution/bodyActionService.js';
import { BehaviorRegistry } from '../../../../../../../apps/minecraft-companion/src/bot/v2/behavior/behaviorRegistry.js';
import { EventBusV2 } from '../../../../../../../apps/minecraft-companion/src/bot/v2/infra/eventBus.js';
import { __setTuningOverride } from '../../../../../../../apps/minecraft-companion/src/bot/v2/infra/tuning.js';
import type { ActionRequest, WorldStateView } from '../../../../../../../apps/minecraft-companion/src/bot/v2/types.js';
import type { GoalAgentStateV1 } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/goalAgent/goalAgentState.js';
import { createMockBot } from '../../../__tests__/mocks/index.js';

afterEach(()=>__setTuningOverride(null));
function deferred<T>() { let resolve!:(v:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve}; }
const flush=()=>new Promise<void>(resolve=>setImmediate(resolve));
function request(type:ActionRequest['type']='look_at',priority=30):ActionRequest {
  return {id:'request',source:'producer',taskId:'task',type,priority,interrupt_level:'soft',resource:[],
    preconditions:[],timeout_ms:5000,target:{position:{x:3,y:64,z:0}}};
}
function fixture() {
  const bot=createMockBot();bot.nav.gotoDelay=0;
  const bus=new EventBusV2();const registry=new BehaviorRegistry();
  let running=true,embodied=true;
  let goal:GoalAgentStateV1|null=null;
  const world=():WorldStateView=>({timestamp:Date.now(),tick:1,self:{...bot.world.self,maxHealth:20},
    environment:{dimension:bot.game.getDimension(),isDay:true,isRaining:false,timeOfDay:6000},owner:null,
    entities:[],inventory:{items:bot.game.getInventoryItems(),held:null,freeSlots:36},taskContext:null} as WorldStateView);
  const body=new BodyActionService({game:bot.game,nav:bot.nav,bus,registry,getWorld:world,
    tasks:{list:()=>[{id:'task',state:'running'}],isRunning:(id:string)=>id==='task'&&running} as never,
    isEmbodied:()=>embodied,getGoalState:()=>goal});
  return {bot,bus,registry,body,pause:()=>{running=false;bus.publish('task.paused','info',{taskId:'task'});},
    resume:()=>{running=true;bus.publish('task.resumed','info',{taskId:'task'});},detach:()=>{embodied=false;},
    goal:(state:GoalAgentStateV1)=>{goal=state;}};
}

test('registered atomic executes through mandatory bound devices and settles its lease',async()=>{
  const f=fixture();const result=await f.body.executeTask(request());
  assert.equal(result.ok,true);assert.equal(result.receipt?.stop?.state,'quiesced');
  assert.equal(result.receipt?.noOp,false);assert.equal(f.bot.game.calls.lookAt.length,1);assert.equal(f.body.busy(),false);
});
test('forged source/resource fields cannot authorize an orphan request',async()=>{
  const f=fixture();const r=request();delete r.taskId;r.source='reflex';r.resource=[];
  assert.equal((await f.body.executeTask(r)).ok,false);assert.equal(f.bot.game.calls.lookAt.length,0);
});
test('non-embodied tasks cannot bind a physical device',async()=>{
  const f=fixture();f.detach();assert.equal((await f.body.executeTask(request())).ok,false);
  assert.equal(f.bot.game.calls.lookAt.length,0);
});
test('sequence Behavior children share one operation, owner and body lease',async()=>{
  const f=fixture();const identities:Array<{operationId:string;stepId:string;leaseRef:string}>=[];
  const original=f.bot.game.bind.bind(f.bot.game);
  f.bot.game.bind=scope=>{identities.push(scope as never);return original(scope);};
  f.registry.register({id:'two-looks',kind:'sequence',compile:()=>[request(),request()]});
  const result=await f.body.executeTask({...request('invoke_behavior'),target:{behavior:'two-looks'}});
  assert.equal(result.ok,true);assert.equal(f.bot.game.calls.lookAt.length,2);
  assert.equal(new Set(identities.map(v=>v.operationId)).size,1);assert.equal(new Set(identities.map(v=>v.leaseRef)).size,1);
  assert.equal(new Set(identities.map(v=>v.stepId)).size,2);
});
test('pausing a task fences queued equip continuation and waits for the native promise',async()=>{
  const f=fixture();const native=deferred<void>();let calls=0;
  f.bot.game.equip=async()=>{calls++;await native.promise;};
  f.registry.register({id:'two-equip',kind:'sequence',compile:()=>[
    {...request('equip'),target:{itemName:'stick'}},{...request('equip'),target:{itemName:'stick'}},
  ]});
  const work=f.body.executeTask({...request('invoke_behavior'),target:{behavior:'two-equip'}});
  await flush();assert.equal(calls,1);f.pause();await flush();assert.equal(f.body.busy(),true);
  native.resolve();const result=await work;assert.equal(result.receipt?.status,'cancelled');
  assert.equal(calls,1);assert.equal(result.receipt?.stop?.state,'quiesced');assert.equal(f.body.busy(),false);
});
test('low priority request cannot overlap a moving body even with empty resource metadata',async()=>{
  const f=fixture();const native=deferred<{ok:boolean}>();f.bot.nav.goto=()=>native.promise;
  const first=f.body.executeTask(request('move_to',80));await flush();
  const second=await f.body.executeTask(request('look_at',20));
  assert.equal(second.ok,false);assert.match(second.error??'',/body_resources_busy/);assert.equal(f.bot.game.calls.lookAt.length,0);
  native.resolve({ok:true});assert.equal((await first).ok,true);
});
test('equal-owner requests cannot implicitly replace an outstanding operation',async()=>{
  const f=fixture();const native=deferred<{ok:boolean}>();f.bot.nav.goto=()=>native.promise;
  const first=f.body.executeTask(request('move_to'));await flush();
  assert.equal((await f.body.executeTask(request())).ok,false);
  native.resolve({ok:true});assert.equal((await first).ok,true);
});
test('higher-priority preemption waits for native drainage before the new write',async()=>{
  const f=fixture();const native=deferred<{ok:boolean}>();f.bot.nav.goto=()=>native.promise;
  const first=f.body.executeTask(request('move_to'));await flush();
  const next=f.body.executeSafety({...request('look_at',90),interrupt_level:'hard'},'test-reflex');
  await flush();assert.equal(f.bot.game.calls.lookAt.length,0);assert.equal(f.body.busy(),true);
  native.resolve({ok:true});assert.equal((await first).receipt?.status,'cancelled');
  assert.equal((await next).ok,true);assert.equal(f.bot.game.calls.lookAt.length,1);
});
test('unconfirmed stop quarantines ownership and rejects preemption instead of clearing busy',async()=>{
  __setTuningOverride({controlledExecution:{stopConfirmTimeoutMs:5}});
  const f=fixture();const native=deferred<{ok:boolean}>();f.bot.nav.goto=()=>native.promise;
  const first=f.body.executeTask(request('move_to'));await flush();
  const next=f.body.executeSafety({...request('look_at',90),interrupt_level:'hard'},'test-reflex');
  const old=await first;assert.equal(old.receipt?.status,'in_doubt');assert.equal(old.receipt?.stop,null);
  assert.equal((await next).ok,false);assert.equal(f.body.busy(),true);assert.equal(f.bot.game.calls.lookAt.length,0);
  native.resolve({ok:true});await flush();await flush();assert.equal(f.body.busy(),false);
  assert.equal(old.receipt?.status,'in_doubt','late completion must not rewrite an emitted receipt');
});
test('follow remains an in-flight operation until cancellation, with no early success',async()=>{
  const f=fixture();f.bot.world.setOwner('owner',42,{x:4,y:64,z:0});
  let settled=false;const work=f.body.executeTask({...request('follow_entity'),target:{entityId:42,range:2}}).then(r=>{settled=true;return r;});
  await flush();assert.equal(settled,false);assert.equal(f.body.busy(),true);assert.equal(f.bot.nav.calls.startFollow.length,1);
  f.body.cancelAll('owner-stop');assert.equal((await work).receipt?.status,'cancelled');assert.equal(f.body.busy(),false);
});
test('stop is activity control: it joins the owned move without acquiring a second lease',async()=>{
  const f=fixture();const native=deferred<{ok:boolean}>();f.bot.nav.goto=()=>native.promise;
  const work=f.body.executeTask(request('move_to'));await flush();const stopping=f.body.executeTask(request('stop'));
  await flush();assert.equal(f.body.runtime.active().length,1);native.resolve({ok:true});
  assert.equal((await work).ok,false);assert.equal((await stopping).ok,true);assert.equal(f.body.busy(),false);
});
test('resumed task receives a fresh generation; its old operation never resumes',async()=>{
  const f=fixture();const native=deferred<{ok:boolean}>();f.bot.nav.goto=()=>native.promise;
  const old=f.body.executeTask(request('move_to'));await flush();f.pause();f.resume();
  native.resolve({ok:true});const oldResult=await old;assert.equal(oldResult.ok,false);
  const next=await f.body.executeTask(request());assert.equal(next.ok,true);
  assert.notDeepEqual(oldResult.receipt?.owner,next.receipt?.owner);
});

test('result distinguishes rejected admission, activity control and a required physical receipt',async()=>{
  const f=fixture();const orphan=request();delete orphan.taskId;
  assert.equal((await f.body.executeTask(orphan)).kind,'rejected');
  const control=await f.body.executeTask(request('stop'));
  assert.equal(control.kind,'control');assert.equal(control.receipt,null);
  const operation=await f.body.executeTask(request());
  assert.equal(operation.kind,'operation');assert.ok(operation.receipt);
});

test('dimension change fences an accepted Behavior before its next child writes',async()=>{
  const f=fixture(),native=deferred<void>();let calls=0;
  f.bot.game.equip=async()=>{calls++;await native.promise;};
  f.registry.register({id:'dimension-test',kind:'sequence',compile:()=>[
    {...request('equip'),target:{itemName:'stick'}},{...request('equip'),target:{itemName:'stick'}},
  ]});
  const work=f.body.executeTask({...request('invoke_behavior'),target:{behavior:'dimension-test'}});
  await flush();f.bot.world.dimension='the_nether';native.resolve();
  assert.equal((await work).ok,false);assert.equal(calls,1);assert.equal(f.body.busy(),false);
});

test('body cancellation stops a control pulse and cannot continue into its following attack',async()=>{
  const f=fixture();f.bot.world.setOwner('owner',42,{x:1,y:64,z:0});
  const controls=new Map<string,boolean>();let clears=0;
  f.bot.game.setControlState=(key,value)=>{controls.set(key,value);};
  f.bot.game.clearControlStates=()=>{clears++;controls.clear();};
  const work=f.body.executeTask({...request('crit_jump_attack'),target:{entityId:42}});
  await flush();assert.equal(controls.get('jump'),true);
  await f.body.drainAll('pulse_cancel');assert.equal((await work).receipt?.status,'cancelled');
  assert.equal(f.bot.game.calls.attack.length,0);assert.ok(clears>0);assert.equal(controls.size,0);
});

test('code-owned support reflects the live registry and excludes removed execution aliases',()=>{
  const f=fixture(),supports=(id:string)=>f.body.supports({ref:{id,contribution:{pluginId:'mineclaw.legacy-builtin',pluginVersion:'1.0.0',contributionId:id,contributionVersion:'1.0.0'}},args:{}});
  assert.equal(supports('atomic:move_to'),true);assert.equal(supports('atomic:stop'),false);
  assert.equal(supports('behavior:new-definition'),false);
  f.registry.register({id:'new-definition',kind:'sequence',compile:()=>[]});
  assert.equal(supports('behavior:new-definition'),true);
});

test('navigation range stays numeric, preserves zero, and rejects malformed ranges before navigation',async()=>{
  const f=fixture();
  for(const range of [-1,'1',null]) {
    const result=await f.body.executeTask({...request('move_to'),target:{position:{x:4,y:64,z:0},range:range as never}});
    if(range!==null) assert.equal(result.ok,false);
  }
  const result=await f.body.executeTask({...request('move_to'),target:{position:{x:4,y:64,z:0},range:0}});
  assert.equal(result.ok,true);assert.equal(f.bot.nav.calls.goto.at(-1)?.range,0);
});

test('goal owner plan revision is captured, not retargeted by a mutable caller state',async()=>{
  const f=fixture(),native=deferred<void>();let calls=0;
  const state={sessionId:'goal',epoch:1,phase:'running',plan:{revision:1}} as GoalAgentStateV1;
  f.goal(state);f.bot.game.equip=async()=>{calls++;await native.promise;};
  f.registry.register({id:'goal-generation',kind:'sequence',compile:()=>[
    {...request('equip'),target:{itemName:'stick'}},{...request('equip'),target:{itemName:'stick'}},
  ]});
  const work=f.body.executeGoal({...request('invoke_behavior'),target:{behavior:'goal-generation'}},
    {state,taskId:'task',operationId:'goal-operation',signal:new AbortController().signal});
  await flush();state.plan.revision=2;native.resolve();
  const result=await work;assert.equal(result.ok,false);assert.equal(calls,1);
  assert.equal(result.receipt?.owner.kind==='goal'&&result.receipt.owner.planRevision,1);
});
