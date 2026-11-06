import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { Bot } from 'mineflayer';
import { buildRuntimePluginKernel } from '../../../../../../apps/minecraft-companion/src/bot/v2/infra/pluginRuntimeBridge.js';
import { MineflayerGameAdapter } from '../../../../../../apps/minecraft-companion/src/bot/mineflayer/MineflayerGameAdapter.js';
import { SwitchableGameAdapter } from '../../../../../../apps/minecraft-companion/src/bot/adapter/SwitchableGameAdapter.js';
import { FASTBRAIN_DECISION_SERVICE, type DecisionPort } from '../../../../../../apps/minecraft-companion/src/bot/v2/plugins/builtin/fastbrain/adapter.js';

test('loaded integration waits on fixed device ticks; integration.stop releases pending wait listeners', async()=>{
  const emitter=Object.assign(new EventEmitter(),{ username:'worker',entity:{id:9,position:{x:1,y:2,z:3},yaw:0,pitch:0,onGround:true},
    world:{},game:{dimension:'overworld'},food:18,health:20,inventory:{items:()=>[]} });
  const bot=emitter as unknown as Bot;
  const concrete=new MineflayerGameAdapter(()=>bot);
  concrete.rebindSubscriptions(bot);
  emitter.emit('spawn');
  const game=new SwitchableGameAdapter(concrete);
  try {
    const k=await buildRuntimePluginKernel({buildId:'wait-wire',systemPorts:{game}});
    assert.equal(k.ok,true,k.failures.join(';'));
    const active=k.slot!.read().active;
    const entry=k.resolvers!.resolveById({generationId:active.generationId,buildId:active.buildId,graphHash:active.graphHash},'mineclaw.minecraft-system.integration.game').entry;
    assert.ok(entry?.contribution.kind==='integration');
    const integration=entry.contribution.integration;
    const port=integration.services?.[FASTBRAIN_DECISION_SERVICE] as DecisionPort;
    assert.equal(port.catalog().find(x=>x.name==='wait')?.available,true);
    const ctx={sessionId:'s',requestId:'wait-wire-1',actor:'worker',dimension:'overworld',notBefore:Date.now(),deadlineAt:Date.now()+2000,
      signal:new AbortController().signal,isCurrent:()=>true};
    const wire={type:'call',skill:'wait',args:{max_ticks:1}};
    const first=port.submit(wire,ctx);
    emitter.emit('physicsTick');
    const r=await first;
    assert.equal(r.status,'success');assert.equal(r.reason,'wait_ticks_elapsed');
    assert.deepEqual(r.observation?.self.position,{x:1,y:2,z:3});
    const second=port.submit(wire,{...ctx,requestId:'wait-wire-2'});
    assert.equal(emitter.listenerCount('physicsTick'),1);
    await integration.stop(new AbortController().signal);
    assert.notEqual((await second).status,'success');
    assert.equal(emitter.listenerCount('physicsTick'),0);
  } finally { concrete.rebindSubscriptions(null); }
});

async function loadWaitFixture(t: TestContext, spawned = false) {
  const emitter = Object.assign(new EventEmitter(), { username:'worker',
    entity:{id:9,position:{x:1,y:2,z:3},yaw:0,pitch:0,onGround:true},
    world:{},game:{dimension:'overworld'},food:18,health:20,inventory:{items:()=>[]} });
  const bot = emitter as unknown as Bot;
  const concrete = new MineflayerGameAdapter(() => bot);
  concrete.rebindSubscriptions(bot);
  if (spawned) emitter.emit('spawn');
  let stop: (() => Promise<void>) | undefined;
  t.after(async () => {
    try { await stop?.(); }
    finally { concrete.rebindSubscriptions(null); }
  });
  const game = new SwitchableGameAdapter(concrete);
  const kernel = await buildRuntimePluginKernel({ buildId:'wait-generation-wire', systemPorts:{game} });
  assert.equal(kernel.ok,true,kernel.failures.join(';'));
  const active = kernel.slot!.read().active;
  const entry = kernel.resolvers!.resolveById({generationId:active.generationId,buildId:active.buildId,graphHash:active.graphHash},
    'mineclaw.minecraft-system.integration.game').entry;
  assert.ok(entry?.contribution.kind === 'integration');
  const integration = entry.contribution.integration;
  stop = () => integration.stop(new AbortController().signal);
  const port = integration.services?.[FASTBRAIN_DECISION_SERVICE] as DecisionPort;
  let sequence = 0;
  const wait = () => port.submit({type:'call',skill:'wait',args:{max_ticks:1}},
    {requestId:`generation-${++sequence}`,sessionId:'generation-session',actor:'worker',dimension:'overworld',
      notBefore:Date.now(),deadlineAt:Date.now()+2000,signal:new AbortController().signal,isCurrent:()=>true});
  return {emitter,wait};
}

test('formal plugin entry refuses a pre-spawn wait even when a Bot has populated state', async t => {
  const f = await loadWaitFixture(t);
  const preSpawn = f.wait();
  f.emitter.emit('spawn');
  f.emitter.emit('physicsTick');
  const rejected = await preSpawn;
  assert.equal(rejected.status,'blocked');
  assert.equal(rejected.observation,undefined);
  assert.equal(f.emitter.listenerCount('physicsTick'),0);
  const current = f.wait();
  f.emitter.emit('physicsTick');
  assert.equal((await current).status,'success');
});

test('formal plugin entry cannot publish an old wait after same-dimension respawn', async t => {
  const f = await loadWaitFixture(t,true);
  const old = f.wait();
  f.emitter.emit('physicsTick');
  f.emitter.emit('respawn');
  f.emitter.emit('spawn');
  const rejected = await old;
  assert.equal(rejected.status,'cancelled');
  assert.equal(rejected.observation,undefined);
  assert.equal(f.emitter.listenerCount('physicsTick'),0);
  const current = f.wait();
  f.emitter.emit('physicsTick');
  assert.equal((await current).status,'success');
});
