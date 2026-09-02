import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { __setTuningOverride } from '../../../../../apps/minecraft-companion/src/bot/v2/infra/tuning.js';
import type { DoorPassageRequest } from '../../../../../apps/minecraft-companion/src/bot/adapter/NavigationAdapter.js';
import { navigationFixture, deferred, flush } from './navigationFixture.js';

afterEach(()=>__setTuningOverride(null));
const door:DoorPassageRequest={position:{x:0,y:64,z:1},blockName:'oak_door',
  properties:{facing:'north',hinge:'left',half:'lower',open:'true'}};

test('idle scoped stop cannot poison the next goto; pure planning never starts a background executor',async()=>{
  __setTuningOverride({navigationExecution:{controlTickMs:1}});
  const f=navigationFixture();
  const receipt=await f.start(async nav=>{await nav.stop();return nav.goto({type:'xz',x:3,z:0});}).result;
  assert.equal(receipt.status,'succeeded');assert.equal(receipt.stop?.state,'quiesced');
  assert.equal(Math.floor(f.device.bot.entity.position.x),3);assert.ok(f.device.plans>=1);
  assert.equal(f.device.raw.controlState.forward,false);
});

test('door maintenance crosses and resumes the same operation without another navigation owner',async()=>{
  __setTuningOverride({navigationExecution:{controlTickMs:1}});
  const f=navigationFixture();let passages=0;
  const handle=f.start(nav=>nav.goto({type:'xz',x:0,z:4}),async nav=>{
    if (passages++) return;
    assert.equal(f.runtime.active().length,1);
    assert.equal((await nav.guideThroughDoor(door)).ok,true);
  });
  assert.equal((await handle.result).status,'succeeded');
  assert.equal(Math.floor(f.device.bot.entity.position.z),4);assert.ok(passages>=1);
  assert.ok(f.device.plans>=2,'crossing invalidates the old path and replans the same goal');
  assert.equal(f.device.raw.controlState.forward,false);
});

test('cancellation during a door look drains native work and never restarts movement',async()=>{
  const f=navigationFixture();const look=deferred<void>();let looks=0;
  f.device.raw.lookAt=()=>{looks++;return look.promise;};
  const handle=f.start(nav=>nav.goto({type:'xz',x:0,z:4}),async nav=>{await nav.guideThroughDoor(door);});
  await flush();assert.equal(looks,1);handle.cancel('owner_stop');await flush();
  assert.equal(f.runtime.inspect('nav-operation')?.stop,null);
  look.resolve();assert.equal((await handle.result).status,'cancelled');
  const count=f.device.writes.length;await flush();assert.equal(f.device.writes.length,count);
  assert.equal(f.device.writes.filter(v=>v==='forward:true').length,0);assert.equal(f.device.plans,1);
  assert.equal(f.device.raw.controlState.forward,false);
});
