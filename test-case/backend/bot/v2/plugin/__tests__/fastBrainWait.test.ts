import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { EventEmitter } from 'node:events';
import type { Bot } from 'mineflayer';
import { MineflayerGameAdapter } from '../../../../../../apps/minecraft-companion/src/bot/mineflayer/MineflayerGameAdapter.js';
import { createFastBrainWaitHandler } from '../../../../../../apps/minecraft-companion/src/bot/v2/plugins/builtin/fastbrain/wait.js';
import { FastBrainPendingRequests } from '../../../../../../apps/minecraft-companion/src/bot/v2/plugins/builtin/fastbrain/pendingRequests.js';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

function fixture(spawned = true) {
  const bot = Object.assign(new EventEmitter(), { username: 'worker', entity: {id:9,position:{x:2,y:64,z:3},yaw:0,pitch:0,onGround:true},
    world:{}, game:{dimension:'overworld'}, food:18, health:20, inventory:{items:()=>[{name:'oak_log',count:1,slot:36}]} });
  const controller = new AbortController();
  const game = new MineflayerGameAdapter(() => bot as unknown as Bot);
  game.rebindSubscriptions(bot as unknown as Bot);
  if (spawned) bot.emit('spawn');
  cleanups.push(() => game.rebindSubscriptions(null));
  const listeners = () => bot.eventNames().map(name => [String(name), bot.listenerCount(name)]).sort();
  const baseline = listeners();
  let current: unknown = game;
  const handler = createFastBrainWaitHandler({getTarget: () => current})!;
  const host = { requestId:'r1',sessionId:'s1',actor:'worker',dimension:'overworld',notBefore:Date.now(),deadlineAt:Date.now()+2000,
    signal:controller.signal,isCurrent:()=>true };
  const wait = (args:Record<string,unknown>) => handler.run({type:'call',skill:'wait',args},host);
  return { bot, game, wait, host, controller, unbind:()=>{current=null;},
    assertReleased: () => assert.deepEqual(listeners(), baseline) };
}
test('two emitted game ticks, not elapsed wall time, return a fresh self snapshot', async () => {
  const f=fixture();
  const pending=f.wait({max_ticks:2});
  f.bot.emit('physicsTick');
  assert.equal(f.bot.listenerCount('physicsTick'),1);
  f.bot.entity.position.x=4;
  f.bot.emit('physicsTick');
  const r=await pending;
  assert.equal(r.status,'success');
  assert.deepEqual(r.observation?.self.position,{x:4,y:64,z:3});
  assert.deepEqual(r.observation?.inventory,[{name:'oak_log',count:1,slot:36}]);
  f.assertReleased();
});
test('the allowed health event wins; reaching the budget without it is timeout',async()=>{
  for(const event of ['physicsTick','health']) {
    const f=fixture();
    const p=f.wait({max_ticks:1,event:'health'});
    f.bot.emit(event);
    const r=await p;
    assert.equal(r.status,event==='health'?'success':'timeout');
    assert.ok(r.observation);
    f.assertReleased();
  }
});
test('request/job/unsupported selectors do not subscribe to unrelated ticks', async()=>{
  for(const selector of [{request_id:'another'}, {job_id:'j'}, {event:'whisper'}]) {
    const f=fixture();
    assert.equal((await f.wait({max_ticks:2,...selector})).status,'blocked');
    f.assertReleased();
  }
});
test('revoke on detach, respawn, death, disconnect, or host abort and release listeners',async()=>{
  for(const cause of ['detach','respawn','death','end','abort']){
    const f=fixture();const p=f.wait({max_ticks:2});
    if(cause==='detach'){f.unbind();f.bot.emit('physicsTick');}
    else if(cause==='abort')f.controller.abort();
    else f.bot.emit(cause);
    const r=await p;
    assert.equal(r.status,'cancelled');assert.equal(r.observation,undefined);
    f.assertReleased();
  }
});
test('wrong actor, missing target, or elapsed deadline cannot produce a success',async()=>{
  const f=fixture();f.host.actor='not-worker';
  assert.equal((await f.wait({max_ticks:1})).status,'blocked');
  f.host.actor='worker';f.host.deadlineAt=Date.now()-1;
  assert.equal((await f.wait({max_ticks:1})).status,'timeout');
  f.unbind();
  assert.equal((await f.wait({max_ticks:1})).status,'blocked');
  f.assertReleased();
});
test('wait for the same live request observes its failure; it never turns it into action success',async()=>{
  const f=fixture(); const live=new FastBrainPendingRequests();
  let release!:()=>void;
  const original=live.wrap({available:true,lifetime:'body',run:async()=>{
    await new Promise<void>(r=>{release=r;});
    return {status:'error',reason:'native_uncertain',effectKnowledge:'unknown',evidenceRefs:['original:mine']};
  }}).run({type:'call',skill:'mine',args:{}},{...f.host,requestId:'mine-1'});
  const wait=createFastBrainWaitHandler(f.game,live)!;
  const decision={type:'call' as const, skill:'wait' as const,args:{request_id:'mine-1',max_ticks:3}};
  const listening=wait.run(decision,f.host);
  await Promise.resolve(); f.bot.emit('physicsTick'); release(); await original;
  f.bot.emit('physicsTick');
  const r=await listening;
  assert.equal(r.reason,'original_receipt_observed');assert.equal(r.details?.originalStatus,'error');
  assert.equal(r.effectKnowledge,'unknown');assert.ok(r.evidenceRefs.includes('original:mine'));
  f.assertReleased();
});

test('pre-spawn reads are unavailable and a later spawn cannot revive their captured proof', async () => {
  const f = fixture(false);
  const beforeSpawn = f.wait({ max_ticks: 1 });
  f.bot.emit('spawn');
  f.bot.emit('physicsTick');
  const rejected = await beforeSpawn;
  assert.equal(rejected.status, 'blocked');
  assert.equal(rejected.observation, undefined);
  f.assertReleased();
  const current = f.wait({ max_ticks: 1 });
  f.bot.emit('physicsTick');
  assert.equal((await current).status, 'success');
  f.assertReleased();
});

test('same-Bot same-dimension respawn between the last tick and publication rejects the old observation', async () => {
  const f = fixture();
  const beforeRespawn = f.wait({ max_ticks: 1 });
  f.bot.emit('physicsTick');
  // No await: preserve the old entity/world objects and respawn before the
  // handler continuation can publish its already-resolved tick result.
  f.bot.emit('respawn');
  f.bot.emit('spawn');
  const rejected = await beforeRespawn;
  assert.equal(rejected.status, 'cancelled');
  assert.equal(rejected.observation, undefined);
  f.assertReleased();
  const current = f.wait({ max_ticks: 1 });
  f.bot.emit('physicsTick');
  assert.equal((await current).status, 'success');
  f.assertReleased();
});

test('a completed tick result remains revoked after a same-world respawn', async () => {
  const f = fixture();
  const pending = f.game.waitForGameTicks({ actor: f.host.actor, dimension: f.host.dimension, maxTicks: 1,
    deadlineAt: f.host.deadlineAt, signal: f.host.signal, isCurrent: f.host.isCurrent });
  f.bot.emit('physicsTick');
  const result = await pending;
  assert.equal(result.kind, 'elapsed');
  assert.equal(result.stillCurrent(), true);
  f.bot.emit('respawn');
  f.bot.emit('spawn');
  assert.equal(result.stillCurrent(), false);
  f.assertReleased();
});

test('request read errors reject and clean up instead of becoming an observed game event', async () => {
  const f = fixture();
  const pending = f.game.waitForGameTicks({ actor: f.host.actor, dimension: f.host.dimension, maxTicks: 2,
    deadlineAt: f.host.deadlineAt, signal: f.host.signal, isCurrent: f.host.isCurrent,
    arrived: () => { throw new Error('request_source_failed'); } });
  const rejected = assert.rejects(pending, /request_source_failed/);
  f.bot.emit('physicsTick');
  await rejected;
  f.assertReleased();
});
