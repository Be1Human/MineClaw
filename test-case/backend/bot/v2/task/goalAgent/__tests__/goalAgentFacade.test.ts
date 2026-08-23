import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { GoalReportV2, GoalRequestV2 } from '../../../../../../../apps/minecraft-companion/src/bot/v2/decision/goalAgentPort/contracts.js';
import type { WorldStateView } from '../../../../../../../apps/minecraft-companion/src/bot/v2/types.js';
import { GoalAgent } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/goalAgent/goalAgent.js';

function request():GoalRequestV2 {
  return {
    meta:{
      schemaVersion:2,sessionId:'interaction-1',messageId:'request-1',correlationId:'correlation-1',
      conversationId:'conversation-1',sequence:1,emittedAt:'2026-08-20T00:00:00.000Z',idempotencyKey:'request-1',
    },
    origin:'player_message',originalText:'我背包里有什么',requestText:'我背包里有什么',
    requestKind:'query',queryPurpose:'answer_player',constraints:[],
  };
}

function world():WorldStateView {
  return {
    tick:7,timestamp:Date.parse('2026-08-20T00:00:07.000Z'),
    self:{position:{x:0,y:64,z:0},yaw:0,pitch:0,health:20,maxHealth:20,food:20,isOnGround:true},
    owner:null,environment:{dimension:'overworld',timeOfDay:1000,isDay:true,isRaining:false},
    entities:[],inventory:{items:[{name:'oak_log',count:2,slot:0}],held:null,freeSlots:35},taskContext:null,
  };
}

test('GoalAgent facade owns submission, status, reports and request idempotency', async () => {
  const reports:GoalReportV2[]=[];
  const contexts:string[]=[];
  let modelCalls=0;
  const agent=new GoalAgent({
    profileId:'test',stateDbPath:':memory:',
    modelClient:{
      async callWithTools(args){
        modelCalls+=1;
        const sessionId=args.traceContext?.goalSessionId;
        if(sessionId)contexts.push(sessionId);
        if(modelCalls===1)return {
          content:'',
          toolCalls:[{id:'observe-1',name:'world_observe',arguments:{}}],
        };
        return {content:'背包里有 2 个橡木原木。',toolCalls:[]};
      },
    },
    tools:{perception:{async observe(){return world();}}},
    publishReport:report=>reports.push(report),
  });
  try {
    const first=agent.submit(request());
    assert.equal(first.accepted,true);
    const sessionId=String(first.details?.sessionId);
    await waitFor(()=>reports.some(report=>report.status==='answered'));
    assert.equal(agent.inspect({
      meta:request().meta,sessionId:'interaction-1',requestId:'request-1',reason:'user_requested',
    }).state,'completed');
    assert.equal(agent.snapshot('interaction-1')?.sessionId,sessionId);
    assert.equal(modelCalls,2);
    assert.equal(new Set(contexts).size,1);

    const duplicate=agent.submit(request());
    assert.equal(duplicate.accepted,true);
    assert.equal(duplicate.details?.deduplicated,true);
    assert.equal(duplicate.details?.sessionId,sessionId);
    await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(modelCalls,2);
    assert.equal(reports.filter(report=>report.status==='answered').length,1);
  } finally {
    agent.close();
  }
});

async function waitFor(predicate:()=>boolean):Promise<void> {
  const deadline=Date.now()+1000;
  while(Date.now()<deadline){
    if(predicate())return;
    await new Promise(resolve=>setTimeout(resolve,5));
  }
  throw new Error('timed out waiting for GoalAgent report');
}

test('persistent monitor survives restore without planned pump and invokes cognition only on meaningful change', async () => {
  let modelCalls = 0;
  let observed = world();
  observed.owner = {
    username: 'owner', position: { x: 4, y: 64, z: 0 }, distance: 4,
    entityId: 1, isVisible: true,
  };
  const agent = new GoalAgent({
    profileId: 'persistent-test',
    stateDbPath: ':memory:',
    modelClient: {
      async callWithTools() {
        modelCalls += 1;
        return { content: '{"decision":"continue","summary":"owner moved"}', toolCalls: [] };
      },
    },
    tools: { perception: { async observe() { return structuredClone(observed); } } },
  });
  try {
    const follow = request();
    follow.requestKind = 'task';
    follow.originalText = '跟着我';
    follow.requestText = '跟着我';
    const started = agent.startPersistentMonitor(follow, {
      world: observed,
      runtimeRef: 'task-follow-1',
      evidenceRefs: ['owner-position:4:0'],
    });
    const sessionId = String(started.details?.sessionId);
    assert.equal(started.accepted, true);
    assert.equal(agent.snapshot(sessionId)?.mode, 'persistent_monitor');
    assert.equal(agent.restore(), 1);
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(modelCalls, 0, 'restore must not run the planned graph');

    const heartbeat = await agent.monitorPersistent({
      sessionId, source: 'watchdog', change: 'heartbeat', summary: 'same snapshot', evidenceRefs: [],
    });
    assert.equal(heartbeat.cognitiveTriggered, false);
    assert.equal(modelCalls, 0);

    observed = { ...observed, tick: 8, timestamp: observed.timestamp + 1_000 };
    const changed = await agent.monitorPersistent({
      sessionId, source: 'watchdog', change: 'world_changed', summary: 'owner crossed bucket',
      evidenceRefs: ['owner-position:6:0'],
    });
    assert.equal(changed.cognitiveTriggered, true);
    assert.equal(changed.advice?.decision, 'continue');
    assert.equal(changed.state.cognition.activeNode, 'monitor');
    assert.equal(changed.state.world.latest?.tick, 8);
    assert.equal(modelCalls, 1);

    const terminal = await agent.finishPersistentMonitor(
      sessionId, 'cancelled', 'owner stopped follow', ['task:task-follow-1:cancelled'],
    );
    assert.equal(terminal?.phase, 'cancelled');
    assert.equal(agent.activeCount(), 0);
  } finally {
    agent.close();
  }
});
