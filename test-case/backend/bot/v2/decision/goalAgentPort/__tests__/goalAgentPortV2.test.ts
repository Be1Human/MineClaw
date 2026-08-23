import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventBusV2 } from '../../../../../../../apps/minecraft-companion/src/bot/v2/infra/eventBus.js';
import { GoalAgentPort } from '../../../../../../../apps/minecraft-companion/src/bot/v2/decision/goalAgentPort/goalAgentPort.js';
import { clarifyGoalRequest } from '../../../../../../../apps/minecraft-companion/src/bot/v2/decision/goalAgentPort/goalRequestClassifier.js';
import type { GoalContinuationV2, GoalRequestV2 } from '../../../../../../../apps/minecraft-companion/src/bot/v2/decision/goalAgentPort/contracts.js';
import type { PerceptionPipeline } from '../../../../../../../apps/minecraft-companion/src/bot/v2/perception/pipeline.js';

describe('BUG-CROSS-51 · GoalAgentPort V2', () => {
  it('同步终态也按 request → report → receipt 单调编号并生成 continuation', () => {
    const bus = new EventBusV2();
    const continuations: GoalContinuationV2[] = [];
    bus.on('goalagent.continuation', event => continuations.push(event.payload as GoalContinuationV2));
    const port = new GoalAgentPort(
      bus,
      { getWorldState: () => null } as unknown as PerceptionPipeline,
      {
        submit(request: GoalRequestV2) {
          bus.publish('goalagent.report', 'info', {
            meta:request.meta, requestId:request.meta.messageId, status:'completed', summary:'已交付', evidence:[],
          });
          return { accepted:true };
        },
      },
    );
    port.beginPlayerTurn('turn-1', '给我石镐');
    const receipt = port.request({ requestKind:'task', requestText:'给我石镐' });
    assert.equal(continuations.length, 1);
    assert.equal(continuations[0]?.session.originalText, '给我石镐');
    assert.equal(continuations[0]?.triggeringReport.meta.sequence, 2);
    assert.equal(receipt.meta.sequence, 3);
    assert.equal(receipt.meta.sessionId, continuations[0]?.session.sessionId);
    port.shutdown();
  });

  it('歧义判断属于 GoalAgent 侧，并只在存在多个真实候选时询问', () => {
    const inventory = [{name:'wooden_pickaxe',count:1},{name:'stone_pickaxe',count:1}];
    assert.equal(clarifyGoalRequest('给我一把稿子', inventory), '你想要木镐还是石镐？');
    assert.equal(clarifyGoalRequest('给我一把石镐', inventory), null);
    assert.equal(clarifyGoalRequest('给我一把稿子', [{name:'stone_pickaxe',count:1}]), null);
  });

  it('状态 Inspector 故障只返回 communication_delayed，不伪造成功/失败',()=>{
    const bus=new EventBusV2();
    const port=new GoalAgentPort(bus,{getWorldState:()=>null} as unknown as PerceptionPipeline,{submit:()=>({accepted:true})},undefined,undefined,{inspector:{inspect:()=>{throw new Error('probe timeout');}},autoStart:false});
    port.beginPlayerTurn('turn-1','现在怎么样');
    port.request({requestKind:'task',requestText:'跟我来'});
    const snapshot=port.getCurrentStatus();
    assert.equal(snapshot?.state,'unknown');
    assert.match(snapshot?.stage??'',/communication_delayed/);
    assert.equal(snapshot?.evidence.length,0);
    port.shutdown();
  });

  it('FEAT-CROSS-18 · balanced 只让获准语义报告生成 continuation，并保留治理轨迹', () => {
    const bus = new EventBusV2();
    let captured: GoalRequestV2 | null = null;
    const continuations: GoalContinuationV2[] = [];
    const governed: Array<{ allowed: boolean; reason: string }> = [];
    bus.on('goalagent.continuation', event => continuations.push(event.payload as GoalContinuationV2));
    bus.on('goalagent.progress_report.governed', event => governed.push(event.payload as { allowed: boolean; reason: string }));
    const port = new GoalAgentPort(
      bus,
      { getWorldState: () => null } as unknown as PerceptionPipeline,
      { submit: request => { captured = request; return { accepted: true }; } },
      undefined, undefined, undefined,
      { level: 'balanced', now: () => 0 },
    );
    port.beginPlayerTurn('turn-progress', '做一个工作台');
    port.request({ requestKind: 'task', requestText: '做一个工作台' });
    const request = captured as GoalRequestV2 | null;
    assert.ok(request);
    const base = {
      meta: request.meta, requestId: request.meta.messageId, status: 'running', summary: '当前附近没有木材，准备重新规划', evidence: [],
    } as const;
    bus.publish('goalagent.report', 'info', {
      ...base,
      update: { kind: 'milestone', importance: 'medium', episodeKey: 'plan:1', dedupeKey: 'milestone:1', ownerActionable: false },
    });
    bus.publish('goalagent.report', 'info', {
      ...base,
      update: { kind: 'obstacle', importance: 'high', episodeKey: 'wood:missing', dedupeKey: 'obstacle:wood', ownerActionable: false },
    });
    assert.deepEqual(governed.map(item => ({ allowed: item.allowed, reason: item.reason })), [
      { allowed: false, reason: 'level_filtered' },
      { allowed: true, reason: 'allowed' },
    ]);
    assert.equal(continuations.length, 1);
    assert.equal(continuations[0]?.triggeringReport.update?.dedupeKey, 'obstacle:wood');
    port.shutdown();
  });

  it('FEAT-CROSS-18 · quiet 抑制 running continuation，但不抑制终态', () => {
    const bus = new EventBusV2();
    let captured: GoalRequestV2 | null = null;
    const continuations: GoalContinuationV2[] = [];
    bus.on('goalagent.continuation', event => continuations.push(event.payload as GoalContinuationV2));
    const port = new GoalAgentPort(
      bus,
      { getWorldState: () => null } as unknown as PerceptionPipeline,
      { submit: request => { captured = request; return { accepted: true }; } },
      undefined, undefined, undefined, { level: 'quiet' },
    );
    port.beginPlayerTurn('turn-quiet', '找木材');
    port.request({ requestKind: 'task', requestText: '找木材' });
    const request = captured as GoalRequestV2 | null;
    assert.ok(request);
    bus.publish('goalagent.report', 'info', {
      meta: request.meta, requestId: request.meta.messageId, status: 'running', summary: '正在重新规划', evidence: [],
      update: { kind: 'decision', importance: 'high', episodeKey: 'wood', dedupeKey: 'replan:1', ownerActionable: false },
    });
    assert.equal(continuations.length, 0);
    bus.publish('goalagent.report', 'info', {
      meta: request.meta, requestId: request.meta.messageId, status: 'failed', summary: '有限搜索后仍无木材', evidence: [],
    });
    assert.equal(continuations.length, 1);
    assert.equal(continuations[0]?.triggeringReport.status, 'failed');
    port.shutdown();
  });

  it('BUG-CROSS-75 · Watchdog 自动快照复用 Governor，主动查询仍可见', async () => {
    const bus = new EventBusV2();
    const continuations: GoalContinuationV2[] = [];
    const governed: Array<{ source?: string; allowed: boolean; reason: string }> = [];
    bus.on('goalagent.continuation', event => continuations.push(event.payload as GoalContinuationV2));
    bus.on('goalagent.progress_report.governed', event => governed.push(event.payload as typeof governed[number]));
    const now = Date.now();
    const port = new GoalAgentPort(
      bus,
      { getWorldState: () => null } as unknown as PerceptionPipeline,
      { submit: () => ({ accepted: true }) },
      undefined,
      undefined,
      {
        inspector: {
          inspect: probe => ({
            sessionId: probe.sessionId,
            requestId: probe.requestId,
            state: 'executing',
            stage: 'running:waiting_for_action:plan-r1',
            evidence: [],
            observedAt: new Date(now).toISOString(),
          }),
        },
        autoStart: false,
        now: () => now,
        config: { firstReportDeadlineMs: 0 },
      },
      { level: 'balanced', now: () => now },
    );
    port.beginPlayerTurn('turn-watchdog-balanced', '收割麦田');
    port.request({ requestKind: 'task', requestText: '收割麦田' });
    port.endPlayerTurn('turn-watchdog-balanced');

    await port.runWatchdogCycle();
    assert.deepEqual(governed.map(item => ({ source: item.source, allowed: item.allowed, reason: item.reason })), [
      { source: 'watchdog', allowed: false, reason: 'level_filtered' },
    ]);
    assert.equal(continuations.length, 0, 'balanced 不应被例行 executing heartbeat 唤醒');

    const queried = await port.getGoalStatus();
    assert.equal(queried?.reason, 'user_requested');
    assert.equal(continuations.length, 1, '玩家主动查询绕过自动播报 Governor');
    assert.equal(continuations[0]?.triggeringReport.progress?.milestone, 'executing');
    port.shutdown();
  });

  it('BUG-CROSS-75 · talkative 对同一 Watchdog 快照最多发布一次', async () => {
    const bus = new EventBusV2();
    let captured: GoalRequestV2 | null = null;
    let now = Date.now();
    const continuations: GoalContinuationV2[] = [];
    const governed: Array<{ source?: string; allowed: boolean; reason: string }> = [];
    bus.on('goalagent.continuation', event => continuations.push(event.payload as GoalContinuationV2));
    bus.on('goalagent.progress_report.governed', event => governed.push(event.payload as typeof governed[number]));
    const port = new GoalAgentPort(
      bus,
      { getWorldState: () => null } as unknown as PerceptionPipeline,
      { submit: request => { captured = request; return { accepted: true }; } },
      undefined,
      undefined,
      {
        inspector: {
          inspect: probe => ({
            sessionId: probe.sessionId,
            requestId: probe.requestId,
            state: 'executing',
            stage: 'running:waiting_for_action:plan-r1',
            evidence: [],
            observedAt: new Date(now).toISOString(),
          }),
        },
        autoStart: false,
        now: () => now,
        config: { plannedSilenceMs: 1, visibleProgressIntervalMs: 0 },
      },
      { level: 'talkative', now: () => now },
    );
    port.beginPlayerTurn('turn-watchdog-talkative', '收割麦田');
    port.request({ requestKind: 'task', requestText: '收割麦田' });
    port.endPlayerTurn('turn-watchdog-talkative');
    const request = captured as GoalRequestV2 | null;
    assert.ok(request);
    bus.publish('goalagent.report', 'info', {
      meta: request.meta,
      requestId: request.meta.messageId,
      status: 'running',
      summary: '执行已开始',
      evidence: [],
    });

    now += 1;
    await port.runWatchdogCycle();
    now += 1;
    await port.runWatchdogCycle();
    assert.deepEqual(governed.map(item => ({ source: item.source, allowed: item.allowed, reason: item.reason })), [
      { source: 'watchdog', allowed: true, reason: 'allowed' },
      { source: 'watchdog', allowed: false, reason: 'duplicate' },
    ]);
    assert.equal(continuations.length, 1);
    port.shutdown();
  });
});
