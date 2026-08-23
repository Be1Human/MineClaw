import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GOAL_INTERACTION_SCHEMA_VERSION_V2, type GoalMessageReceiptV2 } from '../../../../../../../apps/minecraft-companion/src/bot/v2/decision/goalAgentPort/contracts.js';
import { InteractionSessionManager } from '../../../../../../../apps/minecraft-companion/src/bot/v2/decision/goalAgentPort/interactionSessionManager.js';
import {
  GoalSessionWatchdog,
  RuntimeGoalStatusInspector,
  type GoalStatusInspector,
} from '../../../../../../../apps/minecraft-companion/src/bot/v2/decision/goalAgentPort/goalSessionWatchdog.js';
import { classifyGoalAgentStatusChange } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/goalAgent/goalAgentMonitoring.js';

function harness(
  inspector: GoalStatusInspector,
  config: ConstructorParameters<typeof GoalSessionWatchdog>[0]['config'] = {},
  extra: Pick<ConstructorParameters<typeof GoalSessionWatchdog>[0], 'isPersistentRequest' | 'onSnapshot'> = {},
) {
  let now = 1_000;
  const sessions = new InteractionSessionManager(() => now);
  const watchdog = new GoalSessionWatchdog({
    inspector,
    getSession: id => sessions.getSession(id),
    expireSession: id => sessions.expireSession(id),
    nextMessageMeta: (requestId, messageId, suffix) => sessions.nextMessageMeta(requestId, messageId, suffix),
    now: () => now,
    config,
    ...extra,
  });
  const request = (text = '制作铁镐', player = true) => {
    if (player) sessions.beginPlayerTurn(`turn-${now}`, text);
    const value = sessions.createRequest({ requestText: text, requestKind: 'task' });
    if (player) sessions.endPlayerTurn(`turn-${now}`);
    watchdog.trackRequest(value);
    const receipt: GoalMessageReceiptV2 = {
      meta: {
        ...value.meta,
        messageId: `receipt-${now}`,
        causationId: value.meta.messageId,
        sequence: value.meta.sequence + 1,
        emittedAt: new Date(now).toISOString(),
        idempotencyKey: `${value.meta.idempotencyKey}:receipt`,
      },
      sourceMessageId: value.meta.messageId,
      outcome: 'consumed',
    };
    watchdog.recordReceipt(receipt);
    return value;
  };
  return { sessions, watchdog, request, advance: (ms: number) => { now += ms; }, now: () => now };
}

describe('BUG-CROSS-51-009-007 · GoalSessionWatchdog', () => {
  it('首报超时探测真实执行态，相同自动快照在可见窗口内去重', async () => {
    let calls = 0;
    const h = harness({
      inspect: probe => {
        calls += 1;
        return {
          sessionId: probe.sessionId,
          requestId: probe.requestId,
          state: 'executing',
          stage: 'mine_iron',
          runtimeRef: 'execution:7',
          evidence: [],
          observedAt: new Date(h.now()).toISOString(),
        };
      },
    }, { firstReportDeadlineMs: 10, plannedSilenceMs: 5, visibleProgressIntervalMs: 30 });
    const request = h.request();
    h.advance(10);
    const first = await h.watchdog.tick();
    assert.equal(first.length, 1);
    assert.equal(first[0]?.reason, 'first_report_due');
    assert.equal(first[0]?.triggeringReport.status, 'running');
    assert.equal(first[0]?.triggeringReport.progress?.milestone, 'executing');
    assert.equal(first[0]?.triggeringReport.update?.kind, 'milestone');
    assert.match(first[0]?.triggeringReport.update?.dedupeKey ?? '', /^watchdog:/);

    h.watchdog.recordReport({ requestId: request.meta.messageId, status: 'running' });
    h.advance(5);
    assert.equal((await h.watchdog.tick()).length, 0);
    assert.equal(calls, 2, '仍执行探测，但重复快照不唤醒 MainBrain');
  });

  it('probe 超时只报告 communication_delayed，重试一次且不改 session 执行态', async () => {
    let calls = 0;
    const h = harness({ inspect: () => { calls += 1; return new Promise(() => undefined); } }, {
      firstReportDeadlineMs: 1,
      probeTimeoutMs: 2,
      maxProbeRetries: 1,
    });
    const request = h.request();
    h.advance(1);
    const result = await h.watchdog.tick();
    assert.equal(calls, 2);
    assert.equal(result[0]?.triggeringReport.status, 'communication_delayed');
    assert.equal(result[0]?.statusSnapshot?.state, 'unknown');
    assert.equal(h.sessions.getSession(request.meta.sessionId)?.state, 'awaiting_report');
    assert.deepEqual(result[0]?.allowedDecisions, ['respond', 'wait']);
  });

  it('主动查询选择最近活跃 player session，并绕过相同快照节流', async () => {
    const seen: string[] = [];
    const h = harness({
      inspect: probe => {
        seen.push(probe.sessionId);
        return {
          sessionId: probe.sessionId,
          requestId: probe.requestId,
          state: 'recovering',
          stage: 'navigation_retry',
          evidence: [],
          observedAt: new Date(h.now()).toISOString(),
        };
      },
    });
    h.request('第一个任务');
    h.advance(1);
    const latest = h.request('第二个任务');
    const first = await h.watchdog.queryStatus();
    const second = await h.watchdog.queryStatus();
    assert.equal(first?.reason, 'user_requested');
    assert.equal(second?.reason, 'user_requested');
    assert.deepEqual(seen, [latest.meta.sessionId, latest.meta.sessionId]);
    assert.equal(first?.triggeringReport.progress?.milestone, 'recovering');
    assert.equal(first?.triggeringReport.update?.kind, 'recovery');
  });

  it('session TTL 独立于 probe 时限，到期履行回复义务但不调用 Inspector', async () => {
    let calls = 0;
    const h = harness({ inspect: () => { calls += 1; throw new Error('should not inspect'); } }, {
      firstReportDeadlineMs: 100,
      sessionTtlMs: 20,
    });
    const request = h.request();
    h.advance(20);
    const result = await h.watchdog.tick();
    assert.equal(calls, 0);
    assert.equal(result[0]?.reason, 'session_expired');
    assert.equal(result[0]?.triggeringReport.status, 'failed');
    assert.equal(result[0]?.session.state, 'expired');
    assert.equal(h.sessions.getSession(request.meta.sessionId)?.state, 'expired');
  });

  it('确定性 Runtime Inspector 优先读取 Coordinator，保持 queued/blocked/terminal 真值', () => {
    let queue: { state: string; sessionId: string | null; running: string | null; remaining: number } = {
      state: 'running', sessionId: 'exec-1', running: '挖铁矿', remaining: 2,
    };
    const inspector = new RuntimeGoalStatusInspector({
      goalRuntime: { status: () => queue },
      getExecutionSession: () => ({
        id: 'exec-1',
        state: 'recovering',
        updatedAt: 2_000,
      }),
      now: () => 3_000,
    });
    const probe = {
      meta: {
        schemaVersion: GOAL_INTERACTION_SCHEMA_VERSION_V2,
        sessionId: 'interaction-1',
        messageId: 'request-1',
        correlationId: 'correlation-1',
        conversationId: 'turn-1',
        sequence: 1,
        emittedAt: new Date(1_000).toISOString(),
        idempotencyKey: 'request-1',
      },
      sessionId: 'interaction-1',
      requestId: 'request-1',
      reason: 'user_requested' as const,
    };
    assert.equal(inspector.inspect(probe).state, 'recovering');

    queue = { state: 'paused', sessionId: null, running: '等待材料', remaining: 1 };
    const paused = new RuntimeGoalStatusInspector({ goalRuntime: { status: () => queue }, now: () => 3_000 });
    assert.equal(paused.inspect(probe).state, 'blocked');
  });

  it('persistent probe uses its own cadence and classifies only stable snapshot changes as meaningful', async () => {
    let ownerBucket = 4;
    const changes: string[] = [];
    const h = harness({
      inspect: probe => ({
        sessionId: probe.sessionId,
        requestId: probe.requestId,
        state: 'executing',
        stage: 'follow_owner:running',
        runtimeRef: 'task-follow',
        evidence: [
          { type: 'action_result', ref: 'task:task-follow:running', observedAt: new Date(h.now()).toISOString() },
          { type: 'world_snapshot', ref: `owner-position:${ownerBucket}:0`, observedAt: new Date(h.now()).toISOString() },
        ],
        observedAt: new Date(h.now()).toISOString(),
      }),
    }, {
      plannedSilenceMs: 100,
      persistentSilenceMs: 5,
      visibleProgressIntervalMs: 100,
    }, {
      isPersistentRequest: () => true,
      onSnapshot: observation => {
        changes.push(classifyGoalAgentStatusChange(observation.previousSnapshot, observation.snapshot));
      },
    });
    const follow = h.request('跟着我');
    h.watchdog.recordReport({ requestId: follow.meta.messageId, status: 'running' });

    h.advance(5);
    await h.watchdog.tick();
    h.advance(5);
    await h.watchdog.tick();
    ownerBucket = 6;
    h.advance(5);
    await h.watchdog.tick();

    assert.deepEqual(changes, ['heartbeat', 'heartbeat', 'world_changed']);
  });
});
