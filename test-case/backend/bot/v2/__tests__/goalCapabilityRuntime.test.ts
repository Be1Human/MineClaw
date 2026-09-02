import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GoalReportV2 } from '../../../../../apps/minecraft-companion/src/bot/v2/decision/goalAgentPort/contracts.js';
import { V2Runtime } from '../../../../../apps/minecraft-companion/src/bot/v2/v2Runtime.js';
import { createMockBot } from './mocks/index.js';

test('BUG-CROSS-68 · production capability routing starts and uniformly cancels follow_owner', async () => {
  const bot = createMockBot();
  bot.world.setOwner('TestOwner', 42, { x: 4, y: 64, z: 0 });
  const runtime = new V2Runtime({
    game: bot.game,
    nav: bot.nav,
    embodied: true,
    ownerName: 'TestOwner',
    botName: 'MineFriend',
    tickMs: 20,
    blockingExecute: true,
    dbPath: ':memory:',
    worldMapDbPath: ':memory:',
    chatMemoryDbPath: ':memory:',
  });
  const reports: GoalReportV2[] = [];
  runtime.bus.on('goalagent.report', event => reports.push(event.payload as unknown as GoalReportV2));
  runtime.start();
  try {
    runtime.perception.perceive();
    runtime.goalAgentPort.beginPlayerTurn('turn-follow', '跟着我走');
    const followReceipt = runtime.goalAgentPort.request({ requestKind: 'task', requestText: '跟着我走' });
    runtime.goalAgentPort.endPlayerTurn('turn-follow');
    assert.equal(followReceipt.outcome, 'consumed');
    const followTask = runtime.tasks.list().find(task => task.kind === 'follow_owner');
    assert.equal(followTask?.state, 'running');
    assert.ok(reports.some(report => report.requestId === followReceipt.sourceMessageId && report.status === 'running'));

    const deadline=Date.now()+1500;
    while(!runtime.body.busy() && Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(runtime.body.busy(),true,'following must enter the shared body runtime');
    await new Promise(resolve=>setImmediate(resolve));

    runtime.goalAgentPort.beginPlayerTurn('turn-cancel', '停止跟随');
    const cancelReceipt = runtime.goalAgentPort.request({ requestKind: 'cancel', requestText: '停止跟随' });
    runtime.goalAgentPort.endPlayerTurn('turn-cancel');
    assert.equal(cancelReceipt.outcome, 'consumed');
    assert.equal(runtime.tasks.getById(followTask!.id)?.state, 'cancelled');
    await runtime.body.drainTask(followTask!.id,'test-cancel-confirmation');
    assert.equal(runtime.body.busy(),false);
    assert.ok(bot.nav.calls.stop >= 1);
    assert.ok(reports.some(report => report.requestId === followReceipt.sourceMessageId && report.status === 'cancelled'));
    assert.ok(reports.some(report => report.requestId === cancelReceipt.sourceMessageId && report.status === 'completed'));
  } finally {
    runtime.stop();
  }
});
