import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import type { Bot } from 'mineflayer';
import type { BoundGameActions } from '../../../../../apps/minecraft-companion/src/bot/adapter/GameActions.js';
import type { BoundNavigation, NavigationActions } from '../../../../../apps/minecraft-companion/src/bot/adapter/NavigationExecution.js';
import type { OperationIntent } from '../../../../../apps/minecraft-companion/src/bot/v2/task/contracts/bodyOperation.js';
import { MineflayerGameAdapter } from '../../../../../apps/minecraft-companion/src/bot/mineflayer/MineflayerGameAdapter.js';
import { MineflayerNavigationAdapter } from '../../../../../apps/minecraft-companion/src/bot/mineflayer/MineflayerNavigationAdapter.js';
import { BodyExecutionRuntime } from '../../../../../apps/minecraft-companion/src/bot/v2/task/execution/bodyExecutionRuntime.js';
import { ExecutionAuthority } from '../../../../../apps/minecraft-companion/src/bot/v2/task/execution/executionAuthority.js';

const require = createRequire(new URL('../../../../../apps/minecraft-companion/package.json',import.meta.url));
const { Vec3 } = require('vec3');
const registry = require('minecraft-data')('1.20.4');
const Block = require('prismarine-block')(registry);
const Move = require('mineflayer-pathfinder/lib/move');
const AStar = require('mineflayer-pathfinder/lib/astar');
const { Physics } = require('prismarine-physics');
export const flush = () => new Promise<void>(resolve => setImmediate(resolve));
export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

/** Real A*, collision queries, device sessions and lifetime; deterministic server movement feedback. */
export function navigationBot() {
  const writes: string[] = [];
  let lookTarget: any = null, plans = 0;
  const bot: any = new EventEmitter();
  bot.version = '1.20.4'; bot.registry = registry;
  bot.game = {minY:-64,height:384,dimension:'overworld'};
  bot.entity = { position: new Vec3(0.5,64,0.5), velocity: new Vec3(0,0,0),
    yaw:0,pitch:0,onGround:true,effects:{},attributes:{} };
  bot.entities = {}; bot.players = {};
  bot.controlState = {forward:false,back:false,left:false,right:false,jump:false,sprint:false,sneak:false};
  bot.inventory = {items:()=>[{name:'stone',type:registry.itemsByName.stone.id,count:32}],slots:[]};
  bot.blockAt = (position:any) => {
    const p = position.floored();
    const block = Block.fromStateId(registry.blocksByName[p.y<64?'stone':'air'].defaultState,0);
    block.position = p;
    return block;
  };
  bot.physics = Physics(registry,{getBlock:bot.blockAt});
  bot.look = async (yaw:number,pitch:number) => { writes.push('look');bot.entity.yaw=yaw;bot.entity.pitch=pitch;lookTarget=null; };
  bot.lookAt = async (target:any) => {writes.push('lookAt');lookTarget=target;};
  bot.setControlState = (key:string,value:boolean) => {
    writes.push(`${key}:${value}`);bot.controlState[key]=value;
    if (key==='forward' && value) {
      if (lookTarget) {bot.entity.position.x=lookTarget.x;bot.entity.position.z=lookTarget.z;}
      else {bot.entity.position.x-=Math.sin(bot.entity.yaw)*0.2;bot.entity.position.z-=Math.cos(bot.entity.yaw)*0.2;}
    }
  };
  bot.clearControlStates = () => {writes.push('clear');for (const key of Object.keys(bot.controlState)) bot.controlState[key]=false;};
  bot.stopDigging=()=>{writes.push('stopDigging');};bot.deactivateItem=()=>{writes.push('deactivate');};
  bot.equip=async()=>{writes.push('equip');};bot.dig=async()=>{writes.push('dig');};
  bot.placeBlock=async()=>{writes.push('place');};
  bot.pathfinder = {
    goto:()=>{throw new Error('uncontrolled pathfinder.goto');},
    stop:()=>{throw new Error('uncontrolled pathfinder.stop');},
    setGoal:()=>{throw new Error('uncontrolled pathfinder.setGoal');},
    bestHarvestTool:()=>({name:'stone'}),
    *getPathFromTo(movements:any,position:any,goal:any,options:any) {
      plans++;
      const search = new AStar(new Move(position.x,position.y,position.z,32,0),movements,goal,options.timeout,options.tickTimeout,32);
      let result;
      do {result=search.compute();yield {result};} while(result.status==='partial');
    },
  };
  return {bot:bot as Bot,raw:bot,writes,get plans(){return plans;},
    planWithActions: (toBreak:unknown[],toPlace:unknown[]) => {
      bot.pathfinder.getPathFromTo=function*(){plans++;yield {result:{status:'success',path:[new Move(1,64,0,32,0,toBreak,toPlace)]}};};
    }};
}

export function navigationFixture(device = navigationBot()) {
  let current = device.bot;
  const game = new MineflayerGameAdapter(()=>current);
  const nav = new MineflayerNavigationAdapter(()=>current);
  const authority = new ExecutionAuthority();
  let work!: (actions:NavigationActions)=>Promise<unknown>;
  let maintain: (actions:NavigationActions)=>Promise<void> = async()=>{};
  const runtime = new BodyExecutionRuntime({authority,driver:{resources:()=>['minecraft:body'],bind:()=>{
    let boundGame:BoundGameActions|null=null,boundNav:BoundNavigation|null=null;
    return {
      run:async ctx=>{boundGame=game.bind(ctx);boundNav=nav.bind({scope:ctx,game:boundGame,maintain});
        const result:any=await work(boundNav.actions);return {ok:result?.ok??true};},
      stop:async reason=>{await Promise.all([boundGame?.stop(reason),boundNav?.stop(reason)]);},
    };
  }}});
  return {device,nav,runtime,replace:(replacement:Bot)=>{current=replacement;nav.rebindSubscriptions(replacement);},
    start:(run:typeof work,maintenance=maintain,id='nav-operation')=>{
      work=run;maintain=maintenance;
      const intent:OperationIntent={operationId:id,owner:{kind:'task',taskId:'task',generation:1},
        command:{ref:{id:'test-navigation',version:'1'},args:{}},scope:{dimension:'overworld',targetRefs:[],bindings:[]},
        deadlineAt:Date.now()+5000,budget:{maxActions:5000},priority:1,preemption:'none'};
      return runtime.submit({intent,grant:authority.issue(intent,{isCurrent:()=>true,allowsChild:()=>false})});
    }};
}
