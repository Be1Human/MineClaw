import assert from 'node:assert/strict';
import test from 'node:test';
import type { WorldStateView } from '../../../../../../../apps/minecraft-companion/src/bot/v2/types.js';
import { PerceptionAttentionGate } from '../../../../../../../apps/minecraft-companion/src/bot/v2/decision/goalAgentPort/perceptionAttentionGate.js';

function world(health = 18): WorldStateView {
  return {
    tick: 1,
    timestamp: 1,
    self: { position:{x:0,y:64,z:0},yaw:0,pitch:0,health,maxHealth:20,food:20,isOnGround:true },
    owner: null,
    environment: { dimension:'overworld',timeOfDay:0,isDay:true,isRaining:false },
    entities: [
      { id:1,name:'zombie',type:'mob',position:{x:2,y:64,z:0},distance:2,category:'hostile' },
      { id:2,name:'skeleton',type:'mob',position:{x:4,y:64,z:0},distance:4,category:'hostile' },
    ],
    inventory: { items:[],held:null,freeSlots:36 },
    taskContext: null,
  };
}

test('同一攻击 episode 高频事件被合并，摘要不包含完整世界帧', () => {
  let now = 1_000;
  const gate = new PerceptionAttentionGate({ now:()=>now, updateIntervalMs:3_000 });
  const opened = gate.onUnderAttack({prevHealth:20,currHealth:18,damage:2},world(18),'attack-1');
  assert.equal(opened?.state,'opened');
  assert.equal(opened?.delta.threatCount,2);
  assert.equal(opened?.delta.nearestDistance,2);
  assert.equal('entities' in (opened?.delta ?? {}),false);
  now += 100;
  assert.equal(gate.onUnderAttack({prevHealth:18,currHealth:17,damage:1},world(17),'attack-2'),null);
});

test('critical 更新可越过普通时间预算但仍复用 episode', () => {
  let now = 1_000;
  const gate = new PerceptionAttentionGate({ now:()=>now, updateIntervalMs:30_000 });
  const opened = gate.onUnderAttack({prevHealth:20,currHealth:18,damage:2},world(18),'a');
  now += 100;
  const updated = gate.onUnderAttack({prevHealth:18,currHealth:5,damage:13},world(5),'b');
  assert.equal(updated?.state,'updated');
  assert.equal(updated?.urgency,'critical');
  assert.equal(updated?.episodeKey,opened?.episodeKey);
});

test('威胁解除只发送一次 resolved', () => {
  const gate = new PerceptionAttentionGate({ now:()=>1_000 });
  const opened = gate.onUnderAttack({prevHealth:20,currHealth:18,damage:2},world(),'a');
  const resolved = gate.onDangerCleared('clear-1');
  assert.equal(resolved?.episodeKey,opened?.episodeKey);
  assert.equal(resolved?.state,'resolved');
  assert.equal(gate.onDangerCleared('clear-2'),null);
});

test('普通通知受窗口预算限制', () => {
  let now=1_000;
  const gate=new PerceptionAttentionGate({now:()=>now,maxNormalNotificationsPerWindow:2,windowMs:1_000});
  assert.equal(gate.admitNormal(),true);
  assert.equal(gate.admitNormal(),true);
  assert.equal(gate.admitNormal(),false);
  now+=1_001;
  assert.equal(gate.admitNormal(),true);
});
