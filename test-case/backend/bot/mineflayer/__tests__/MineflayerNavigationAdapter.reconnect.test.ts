import assert from 'node:assert/strict';
import { test } from 'node:test';
import { navigationFixture, navigationBot, deferred, flush } from './navigationFixture.js';

test('navigation subscriptions follow controlled sessions; reconnect fences the old Bot and its events',async()=>{
  const first=navigationBot(),second=navigationBot(),f=navigationFixture(first);
  const seen:string[]=[];
  f.nav.onGoalReached(()=>seen.push('reached'));f.nav.onPathStop(reason=>seen.push('stop:'+reason));
  const look=deferred<void>();first.raw.look=()=>look.promise;
  const old=f.start(nav=>nav.goto({type:'xz',x:3,z:0}));await flush();
  f.replace(second.bot);first.raw.emit('goal_reached');second.raw.emit('goal_reached');
  assert.deepEqual(seen,[],'raw pathfinder events are not controlled-operation proof');
  look.resolve();assert.equal((await old.result).status,'failed');
  assert.deepEqual(second.writes,[],'old cleanup must never write to a replacement Bot');
  assert.equal(first.writes.includes('forward:true'),false);
  const next=f.start(nav=>nav.goto({type:'xz',x:0,z:0}),undefined,'next');
  assert.equal((await next.result).status,'succeeded');
  assert.deepEqual(seen,['reached','stop:settled']);
});
