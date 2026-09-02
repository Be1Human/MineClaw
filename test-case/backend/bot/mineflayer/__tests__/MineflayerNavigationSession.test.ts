import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { navigationFixture, navigationBot, deferred, flush } from './navigationFixture.js';
import { __setTuningOverride } from '../../../../../apps/minecraft-companion/src/bot/v2/infra/tuning.js';

afterEach(()=>__setTuningOverride(null));
test('cancelled path digging waits for native equip and never issues a late dig',async()=>{
  const bot=navigationBot();bot.planWithActions([{x:1,y:63,z:0}],[]);
  const equip=deferred<void>();bot.raw.equip=()=>{bot.writes.push('equip');return equip.promise;};
  const f=navigationFixture(bot);f.nav.setMovementOptions({canDig:true});
  const h=f.start(nav=>nav.goto({type:'xz',x:3,z:0}));await flush();assert.equal(bot.writes.includes('equip'),true);
  h.cancel('stop');await flush();assert.equal(f.runtime.active().length,1);
  equip.resolve();assert.equal((await h.result).status,'cancelled');assert.equal(bot.writes.includes('dig'),false);
});
test('cancelled path placement drains equip and does not place a late block',async()=>{
  const bot=navigationBot();bot.raw.inventory.items=()=>[{name:'cobblestone',type:bot.raw.registry.itemsByName.cobblestone.id,count:32}];
  bot.planWithActions([],[{x:0,y:63,z:0,dx:1,dy:0,dz:0}]);
  const equip=deferred<void>();bot.raw.equip=()=>{bot.writes.push('equip');return equip.promise;};
  const f=navigationFixture(bot);const h=f.start(nav=>nav.goto({type:'xz',x:3,z:0}));
  await flush();assert.equal(bot.writes.includes('equip'),true);h.cancel('stop');equip.resolve();
  assert.equal((await h.result).status,'cancelled');assert.equal(bot.writes.includes('place'),false);
});
test('follow is ongoing at range and a disappearing target fails instead of succeeding',async()=>{
  __setTuningOverride({navigationExecution:{controlTickMs:1}});
  const f=navigationFixture();f.device.raw.entities[42]={position:f.device.bot.entity.position.clone(),id:42};
  let settled=false;const h=f.start(nav=>nav.follow(42,2));void h.result.then(()=>{settled=true;});
  await flush();assert.equal(settled,false);assert.equal(f.nav.isFollowing(42),true);
  delete f.device.raw.entities[42];assert.equal((await h.result).status,'failed');assert.equal(f.nav.isFollowing(),false);
});
test('movement options forbid path excavation before even selecting a tool',async()=>{
  const bot=navigationBot();bot.planWithActions([{x:1,y:63,z:0}],[]);
  const f=navigationFixture(bot);const result=await f.start(nav=>nav.goto({type:'xz',x:3,z:0})).result;
  assert.equal(result.status,'failed');assert.equal(bot.writes.includes('equip'),false);assert.equal(bot.writes.includes('dig'),false);
});

test('path excavation awaits the native dig, replans, and settles only after arrival',async()=>{
  __setTuningOverride({navigationExecution:{controlTickMs:1}});
  const bot=navigationBot(),planner=bot.raw.pathfinder.getPathFromTo;
  const blocks=bot.raw.blockAt;let obstacle=true;
  bot.raw.blockAt=(p:any)=>{
    if(obstacle&&p.floored().equals(bot.bot.entity.position.offset(1,0,0).floored())) {
      const block=blocks(p.offset(0,-1,0));block.position=p.floored();return block;
    }
    return blocks(p);
  };
  bot.planWithActions([{x:1,y:64,z:0}],[]);
  bot.raw.dig=async()=>{bot.writes.push('dig');obstacle=false;bot.raw.pathfinder.getPathFromTo=planner;};
  const f=navigationFixture(bot);f.nav.setMovementOptions({canDig:true});
  const result=await f.start(nav=>nav.goto({type:'xz',x:3,z:0})).result;
  assert.equal(result.status,'succeeded');assert.equal(bot.writes.filter(v=>v==='dig').length,1);
  assert.equal(Math.floor(bot.bot.entity.position.x),3);assert.equal(f.nav.isMining(),false);
});

test('bridge edge and return movements, equip and place all finish within the same operation',async()=>{
  __setTuningOverride({navigationExecution:{controlTickMs:1}});
  const bot=navigationBot(),planner=bot.raw.pathfinder.getPathFromTo;
  bot.raw.inventory.items=()=>[{name:'cobblestone',type:bot.raw.registry.itemsByName.cobblestone.id,count:32}];
  bot.planWithActions([],[{x:0,y:63,z:0,dx:1,dy:0,dz:0,returnPos:{x:0,y:64,z:0}}]);
  bot.raw.placeBlock=async()=>{bot.writes.push('place');bot.raw.pathfinder.getPathFromTo=planner;};
  const f=navigationFixture(bot);const result=await f.start(nav=>nav.goto({type:'xz',x:3,z:0})).result;
  assert.equal(result.status,'succeeded');assert.equal(result.stop?.state,'quiesced');
  assert.equal(bot.writes.filter(v=>v==='place').length,1);assert.ok(bot.writes.includes('sneak:true'));
  assert.equal(bot.raw.controlState.sneak,false);assert.equal(f.nav.isBuilding(),false);
});
