import assert from 'node:assert/strict';
import test from 'node:test';

import { PlaceRelativeBehavior } from '../../../../../../apps/minecraft-companion/src/bot/v2/behavior/placeRelativeBehavior.js';
import type { WorldStateView, ActionRequest } from '../../../../../../apps/minecraft-companion/src/bot/v2/types.js';

function world(): WorldStateView {
  return {
    tick: 1, timestamp: 1,
    self: { position: { x: 55.5, y: -60, z: 37.5 }, yaw: 0, pitch: 0, health: 20, maxHealth: 20, food: 20, isOnGround: true },
    owner: { username: 'owner', position: { x: 60.5, y: -60, z: 37.5 }, distance: 5, entityId: 7, isVisible: true, yaw: Math.PI / 2 },
    environment: { dimension: 'overworld', timeOfDay: 1000, isDay: true, isRaining: false },
    entities: [], inventory: { items: [{ name: 'crafting_table', count: 1, slot: 0 }], held: null, freeSlots: 35 },
    taskContext: null,
  };
}

test('BUG-CROSS-63 · right/near relation moves opposite the target then places on a grounded cell', async () => {
  const calls: ActionRequest[] = [];
  const events: Array<{type:string;payload:Record<string,unknown>}> = [];
  const result = await new PlaceRelativeBehavior().run!({
    taskParams: { item: 'crafting_table', relativeTo: 'owner', relation: 'near' }, getWorld: world,
    execute: async request => {
      calls.push(request);
      return { ok: true, request, durationMs: 1 };
    },
    publish: (type, _level, payload) => events.push({ type, payload }),
  });
  assert.equal(result.ok, true);
  assert.equal(calls[0]?.type, 'move_to');
  assert.deepEqual(calls[0]?.target?.position, { x: 60, y: -60, z: 38 });
  assert.equal(calls[1]?.type, 'place_block');
  assert.deepEqual(calls[1]?.target?.position, { x: 60, y: -60, z: 36 });
  assert.deepEqual(calls[1]?.target?.referencePosition, { x: 60, y: -61, z: 36 });
  assert.equal(events[0]?.type, 'behavior.place_relative.success');
  assert.equal(events[0]?.payload.relativeTo, 'owner');
  assert.deepEqual(events[0]?.payload.referencePosition, { x: 60.5, y: -60, z: 37.5 });
});

test('BUG-CROSS-63 · atomic placement failure publishes no stable receipt', async () => {
  const events:string[]=[];
  let calls=0;
  const result=await new PlaceRelativeBehavior().run!({
    taskParams:{item:'crafting_table',relativeTo:'owner',relation:'near'},getWorld:world,
    execute:async request=>{
      calls+=1;
      return calls===1?{ok:true,request,durationMs:1}:{ok:false,request,durationMs:1,error:'blocked'};
    },
    publish:type=>events.push(type),
  });
  assert.equal(result.ok,false);
  assert.deepEqual(events,[]);
});

test('BUG-CROSS-66 · top surface places above the owner-relative support block', async () => {
  const calls:ActionRequest[]=[];
  const result=await new PlaceRelativeBehavior().run!({
    taskParams:{item:'torch',relativeTo:'owner',relation:'front',surface:'top'},getWorld:()=>({
      ...world(),
      inventory:{items:[{name:'torch',count:1,slot:0}],held:null,freeSlots:35},
    }),
    execute:async request=>{calls.push(request);return {ok:true,request,durationMs:1};},
    publish:()=>{},
  });
  assert.equal(result.ok,true);
  assert.deepEqual(calls[0]?.target?.position,{x:61,y:-60,z:37});
  assert.deepEqual(calls[1]?.target?.referencePosition,{x:59,y:-60,z:37});
  assert.deepEqual(calls[1]?.target?.position,{x:59,y:-59,z:37});
});

test('BUG-CROSS-74 · self-relative placement uses the bot snapshot, not the owner position', async () => {
  const calls: ActionRequest[] = [];
  const events: Array<{type:string;payload:Record<string,unknown>}> = [];
  const result = await new PlaceRelativeBehavior().run!({
    taskParams: { item: 'crafting_table', relativeTo: 'self', relation: 'near' }, getWorld: world,
    execute: async request => { calls.push(request); return { ok: true, request, durationMs: 1 }; },
    publish: (type, _level, payload) => events.push({ type, payload }),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(calls[0]?.target?.position, { x: 56, y: -60, z: 37 });
  assert.deepEqual(calls[1]?.target?.position, { x: 54, y: -60, z: 37 });
  assert.equal(events[0]?.payload.relativeTo, 'self');
  assert.deepEqual(events[0]?.payload.referencePosition, { x: 55.5, y: -60, z: 37.5 });
});
