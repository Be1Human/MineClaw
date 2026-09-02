import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { InteractionSessionManager } from '../../../../../../../apps/minecraft-companion/src/bot/v2/decision/goalAgentPort/interactionSessionManager.js';

function reportFor(
  requestId: string,
  status: 'answered' | 'running' | 'completed' | 'failed' | 'need_clarification',
  summary = 'ok',
) {
  return { requestId, status, summary, evidence: [] };
}

describe('BUG-CROSS-51 · InteractionSessionV2', () => {
  it('直接 task 保存玩家原话、session 和 must_reply', () => {
    const sessions = new InteractionSessionManager();
    sessions.beginPlayerTurn('turn-1', '给我一把石镐');
    const request = sessions.createRequest({ requestKind: 'task', requestText: '给我一把石镐' });
    const session = sessions.getSession(request.meta.sessionId);

    assert.equal(request.requestKind, 'task');
    assert.equal(request.originalText, '给我一把石镐');
    assert.equal(request.requestText, '给我一把石镐');
    assert.equal(session?.originalText, '给我一把石镐');
    assert.equal(session?.state, 'awaiting_report');
    assert.equal(session?.replyObligation, 'must_reply');
  });

  it('一次任务委托在 answered 报告后进入 completed', () => {
    const sessions = new InteractionSessionManager();
    sessions.beginPlayerTurn('turn-1', '给我一把稿子');
    const query = sessions.createRequest({
      requestKind: 'task',
      requestText: '看看我背包里有哪些镐',
    });
    const continuation = sessions.handleReport(reportFor(query.meta.messageId, 'answered', '有木镐和石镐'));

    assert.equal(continuation?.session.originalText, '给我一把稿子');
    assert.equal(continuation?.session.state, 'completed');
    assert.deepEqual(continuation?.allowedDecisions, ['respond']);
  });

  it('直接回答的任务终止 session，且玩家来源不得静默', () => {
    const sessions = new InteractionSessionManager();
    sessions.beginPlayerTurn('turn-1', '我背包里有什么');
    const query = sessions.createRequest({
      requestKind: 'task', requestText: '我背包里有什么',
    });
    const continuation = sessions.handleReport(reportFor(query.meta.messageId, 'answered', '有石头'));
    assert.equal(continuation?.session.state, 'completed');
    assert.equal(continuation?.session.replyObligation, 'must_reply');
    assert.deepEqual(continuation?.allowedDecisions, ['respond']);
  });

  it('歧义澄清与玩家补充保持同一 session', () => {
    const sessions = new InteractionSessionManager();
    sessions.beginPlayerTurn('turn-1', '给我一把稿子');
    const task = sessions.createRequest({ requestKind: 'task', requestText: '给我一把稿子' });
    const continuation = sessions.handleReport(reportFor(task.meta.messageId, 'need_clarification', '木镐还是石镐？'));
    assert.equal(continuation?.session.state, 'awaiting_player');
    assert.deepEqual(continuation?.allowedDecisions, ['clarify']);

    sessions.beginPlayerTurn('turn-2', '石镐');
    const resumed = sessions.createRequest({ requestKind: 'task', requestText: '石镐' });
    assert.equal(resumed.meta.sessionId, task.meta.sessionId);
    assert.equal(resumed.parentRequestId, task.meta.messageId);
    assert.equal(resumed.originalText, '给我一把稿子');
    assert.equal(resumed.requestText, '石镐');
  });

  it('重复报告和过期 session 不会复活执行链', () => {
    let now = 1_000;
    const sessions = new InteractionSessionManager(() => now, 100);
    sessions.beginPlayerTurn('turn-1', '给我石镐');
    const task = sessions.createRequest({ requestKind: 'task', requestText: '给我石镐' });
    const first = sessions.handleReport(reportFor(task.meta.messageId, 'completed'));
    const duplicate = sessions.handleReport(reportFor(task.meta.messageId, 'completed'));
    assert.equal(first?.session.state, 'completed');
    assert.equal(duplicate, null);

    sessions.beginPlayerTurn('turn-2', '去找钻石');
    const expiring = sessions.createRequest({ requestKind: 'task', requestText: '去找钻石' });
    now += 101;
    assert.equal(sessions.handleReport(reportFor(expiring.meta.messageId, 'completed')), null);
    assert.equal(sessions.getSession(expiring.meta.sessionId)?.state, 'expired');
  });

  it('取消屏障终止全部在途 session，迟到报告不能复活', () => {
    const sessions = new InteractionSessionManager();
    sessions.beginPlayerTurn('turn-1', '去找钻石');
    const task = sessions.createRequest({ requestKind:'task', requestText:'去找钻石' });
    const cancelled = sessions.cancelAll('玩家要求停止');
    assert.equal(cancelled.length, 1);
    assert.equal(cancelled[0]?.session.state, 'cancelled');
    assert.equal(cancelled[0]?.session.replyObligation, 'must_reply');
    assert.equal(sessions.handleReport(reportFor(task.meta.messageId, 'completed')), null);
  });

  it('主动请求保留 initiative 来源，而玩家请求不能伪造 initiative', () => {
    const initiative = {
      capabilityId: 'auto_follow',
      activationId: 'activation-1',
      evidenceRefs: ['owner:Steve'],
      idempotencyKey: 'owner:nearby',
      preemptible: true,
    };
    const autonomous = new InteractionSessionManager().createRequest({
      requestKind: 'task', requestText: '持续跟随主人', initiative,
    });
    assert.equal(autonomous.origin, 'mainbrain_self');
    assert.deepEqual(autonomous.initiative, initiative);
    assert.notEqual(autonomous.initiative?.evidenceRefs, initiative.evidenceRefs);

    const playerSessions = new InteractionSessionManager();
    playerSessions.beginPlayerTurn('turn-player', '跟着我');
    const player = playerSessions.createRequest({
      requestKind: 'task', requestText: '跟着我', initiative,
    });
    assert.equal(player.origin, 'player_message');
    assert.equal(player.initiative, undefined);
  });

  it('精确取消只终止给定主动请求，不影响其他会话', () => {
    const sessions = new InteractionSessionManager();
    const first = sessions.createRequest({ requestKind: 'task', requestText: '主动任务一' });
    const second = sessions.createRequest({ requestKind: 'task', requestText: '主动任务二' });
    const cancelled = sessions.cancelRequest(first.meta.messageId, 'player_preempted');
    assert.equal(cancelled?.session.state, 'cancelled');
    assert.equal(sessions.getSession(first.meta.sessionId)?.state, 'cancelled');
    assert.equal(sessions.getSession(second.meta.sessionId)?.state, 'awaiting_report');
  });

  it('watchdog running 快照生成可回复 continuation，但 session 保持 executing', () => {
    const sessions = new InteractionSessionManager();
    sessions.beginPlayerTurn('turn-1','跟我来');
    const task=sessions.createRequest({requestKind:'task',requestText:'跟我来'});
    assert.equal(sessions.handleReport(reportFor(task.meta.messageId,'running')),null);
    const continuation=sessions.handleStatusReport(reportFor(task.meta.messageId,'running','仍在跟随，距离 4.2 格'));
    assert.equal(continuation?.session.state,'executing');
    assert.deepEqual(continuation?.allowedDecisions,['respond','wait']);
  });
});
