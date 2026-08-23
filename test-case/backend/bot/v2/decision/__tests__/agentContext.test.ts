import assert from 'node:assert/strict';
import { describe,it } from 'node:test';
import { buildMainBrainContext } from '../../../../../../apps/minecraft-companion/src/bot/v2/decision/agentContext.js';
import type { GoalReportV2 } from '../../../../../../apps/minecraft-companion/src/bot/v2/decision/goalAgentPort/contracts.js';

const report:GoalReportV2={
  meta:{schemaVersion:2,sessionId:'s1',messageId:'m1',correlationId:'c1',conversationId:'v1',sequence:2,emittedAt:'2026-08-04T00:00:00.000Z',idempotencyKey:'m1'},
  requestId:'r1',status:'running',summary:'正在跟随',evidence:[],
};

describe('MainBrain 与 GoalAgent 外部边界',()=>{
  it('MainBrain 只看到 session 与报告，不含执行 trace/messages',()=>{
    const context=buildMainBrainContext({sessionId:'s1',origin:'player',originalText:'跟我来',desiredOutcome:'跟我来',state:'executing',replyObligation:'must_reply'},report);
    const json=JSON.stringify(context);
    assert.equal(json.includes('messages'),false);
    assert.equal(json.includes('executionTrace'),false);
    assert.equal(context.latestGoalReport.status,'running');
  });
});
