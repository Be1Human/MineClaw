import { randomUUID } from 'node:crypto';
import {
  GOAL_INTERACTION_SCHEMA_VERSION_V2,
  type GoalContinuationV2,
  type GoalInitiativeProvenanceV2,
  type GoalInteractionMetaV2,
  type GoalReportV2,
  type GoalRequestV2,
  type InteractionSessionV2,
} from './contracts.js';

type RequestInput = {
  requestText: string;
  requestKind: 'task' | 'query' | 'cancel';
  queryPurpose?: 'answer_player' | 'prepare_task';
  constraints?: string[];
  initiative?: GoalInitiativeProvenanceV2;
};

type MutableSession = InteractionSessionV2 & {
  correlationId: string;
  conversationId: string;
  sequence: number;
  lastRequestKind?: GoalRequestV2['requestKind'];
  lastQueryPurpose?: GoalRequestV2['queryPurpose'];
  repliedAt?: string;
};

type TurnContext = { turnId: string; text: string; kind: 'player' | 'continuation'; sessionId?: string };

/** 协议态的单一写入者；不读取世界，也不规划游戏动作。 */
export class InteractionSessionManager {
  private readonly sessions = new Map<string, MutableSession>();
  private readonly requestToSession = new Map<string, string>();
  private readonly requestMeta = new Map<string, GoalInteractionMetaV2>();
  private currentTurn: TurnContext | null = null;
  private awaitingPlayerSessionId: string | null = null;

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly ttlMs = 15 * 60_000,
  ) {}

  beginPlayerTurn(turnId: string, text: string): void {
    this.expireStale();
    const waiting = this.awaitingPlayerSessionId
      ? this.sessions.get(this.awaitingPlayerSessionId)
      : undefined;
    this.currentTurn = {
      turnId,
      text,
      kind: 'player',
      ...(waiting?.state === 'awaiting_player' ? { sessionId: waiting.sessionId } : {}),
    };
  }

  beginContinuation(turnId: string, sessionId: string): void {
    this.currentTurn = { turnId, text: '', kind: 'continuation', sessionId };
  }

  endPlayerTurn(turnId: string): void {
    if (this.currentTurn?.turnId === turnId) this.currentTurn = null;
  }

  createRequest(input: RequestInput): GoalRequestV2 {
    this.expireStale();
    let session = this.currentTurn?.sessionId
      ? this.sessions.get(this.currentTurn.sessionId)
      : undefined;

    if (!session) {
      const sessionId = `interaction-${randomUUID()}`;
      const isPlayer = this.currentTurn?.kind === 'player';
      const originalText = isPlayer && this.currentTurn?.text
        ? this.currentTurn.text.trim()
        : input.requestText.trim();
      const now = this.now();
      session = {
        sessionId,
        origin: isPlayer ? 'player' : 'mainbrain_self',
        originTurnId: this.currentTurn?.turnId ?? `self-${now}`,
        originalText,
        desiredOutcome: input.requestText.trim(),
        state: 'opened',
        replyObligation: isPlayer ? 'must_reply' : 'may_reply',
        childRequestIds: [],
        expiresAt: new Date(now + this.ttlMs).toISOString(),
        correlationId: `goal-correlation-${randomUUID()}`,
        conversationId: this.currentTurn?.turnId ?? `self-${now}`,
        sequence: 0,
      };
      this.sessions.set(sessionId, session);
    }

    if (!['opened', 'awaiting_player', 'ready_for_decision'].includes(session.state)) {
      throw new Error(`goal_session_not_submittable:${session.state}`);
    }

    const parentRequestId = session.state === 'ready_for_decision' || session.state === 'awaiting_player'
      ? session.activeRequestId
      : undefined;
    // originalText 已独立保留玩家原话；执行文本使用 MainBrain 在当前回合解析出的完整任务，
    // 避免把“含糊原句；玩家补充”机械拼接成 Planner 无法执行的自然语言。
    const requestText = input.requestText.trim();

    const messageId = `goal-message-${randomUUID()}`;
    const sequence = ++session.sequence;
    const emittedAt = new Date(this.now()).toISOString();
    const meta: GoalInteractionMetaV2 = {
      schemaVersion: GOAL_INTERACTION_SCHEMA_VERSION_V2,
      sessionId: session.sessionId,
      messageId,
      correlationId: session.correlationId,
      ...(parentRequestId ? { causationId: parentRequestId } : {}),
      conversationId: session.conversationId,
      sequence,
      emittedAt,
      expiresAt: session.expiresAt,
      idempotencyKey: `${session.correlationId}:request:${sequence}`,
    };
    const request: GoalRequestV2 = {
      meta,
      ...(parentRequestId ? { parentRequestId } : {}),
      origin: session.origin === 'player' ? 'player_message' : 'mainbrain_self',
      originalText: session.originalText,
      requestText,
      requestKind: input.requestKind,
      ...(input.requestKind === 'query' ? { queryPurpose: input.queryPurpose ?? 'answer_player' } : {}),
      constraints: input.constraints ?? [],
      ...(!isPlayerOrigin(session) && input.initiative
        ? { initiative: cloneInitiative(input.initiative) }
        : {}),
    };

    if (input.requestKind === 'task') session.desiredOutcome = requestText;
    session.activeRequestId = messageId;
    session.childRequestIds.push(messageId);
    session.lastRequestKind = input.requestKind;
    session.lastQueryPurpose = input.queryPurpose;
    session.state = 'awaiting_report';
    this.requestToSession.set(messageId, session.sessionId);
    this.requestMeta.set(messageId, meta);
    if (this.awaitingPlayerSessionId === session.sessionId) this.awaitingPlayerSessionId = null;
    return request;
  }

  cancelRequest(requestId: string, reason: string): GoalContinuationV2 | null {
    const sessionId = this.requestToSession.get(requestId);
    const session = sessionId ? this.sessions.get(sessionId) : undefined;
    if (!session || ['completed', 'failed', 'cancelled', 'expired'].includes(session.state)) return null;
    const continuation = this.cancelSession(session, requestId, reason);
    return continuation;
  }

  handleReport(input: Omit<GoalReportV2, 'meta'> & { meta?: GoalInteractionMetaV2 }): GoalContinuationV2 | null {
    return this.applyReport(input, false);
  }

  /** Watchdog 的非终态快照也要能唤醒 MainBrain 向玩家反馈，但不改变任务所有权。 */
  handleStatusReport(input: Omit<GoalReportV2, 'meta'> & { meta?: GoalInteractionMetaV2 }): GoalContinuationV2 | null {
    return this.applyReport(input, true);
  }

  private applyReport(input: Omit<GoalReportV2, 'meta'> & { meta?: GoalInteractionMetaV2 }, emitRunning: boolean): GoalContinuationV2 | null {
    this.expireStale();
    const sessionId = input.meta?.sessionId ?? this.requestToSession.get(input.requestId);
    const session = sessionId ? this.sessions.get(sessionId) : undefined;
    if (!session || ['completed', 'failed', 'cancelled', 'expired'].includes(session.state)) return null;
    if (session.activeRequestId !== input.requestId) return null;

    const baseMeta = input.meta ?? this.requestMeta.get(input.requestId);
    if (!baseMeta) return null;
    const meta: GoalInteractionMetaV2 = {
      ...baseMeta,
      messageId: `goal-report-${randomUUID()}`,
      causationId: input.requestId,
      sequence: ++session.sequence,
      emittedAt: new Date(this.now()).toISOString(),
      idempotencyKey: `${session.correlationId}:report:${session.sequence}`,
    };
    const report: GoalReportV2 = { ...input, meta };

    switch (report.status) {
      case 'running':
        session.state = report.progress?.milestone === 'resolving'
          ? 'resolving'
          : report.progress?.milestone === 'contract_validating'
            ? 'contract_validating'
            : report.progress?.milestone === 'planning'
              ? 'planning'
              : 'executing';
        if (!emitRunning) return null;
        break;
      case 'communication_delayed':
        return {
          session: {
            sessionId: session.sessionId,
            origin: session.origin,
            originalText: session.originalText,
            desiredOutcome: session.desiredOutcome,
            state: session.state,
            replyObligation: session.replyObligation,
          },
          triggeringReport: report,
          reason: 'communication_delayed',
          allowedDecisions: ['respond', 'wait'],
        };
      case 'need_clarification':
        session.state = 'awaiting_player';
        session.replyObligation = session.origin === 'player' ? 'must_reply' : 'may_reply';
        this.awaitingPlayerSessionId = session.sessionId;
        break;
      case 'answered':
        if (session.lastRequestKind === 'query' && session.lastQueryPurpose === 'prepare_task') {
          session.state = 'ready_for_decision';
        } else {
          session.state = 'completed';
        }
        break;
      case 'completed':
        session.state = 'completed';
        break;
      case 'failed':
        session.state = 'failed';
        break;
      case 'cancelled':
        session.state = 'cancelled';
        break;
    }

    return {
      session: {
        sessionId: session.sessionId,
        origin: session.origin,
        originalText: session.originalText,
        desiredOutcome: session.desiredOutcome,
        state: session.state,
        replyObligation: session.replyObligation,
      },
      triggeringReport: report,
      allowedDecisions: ['resolving', 'contract_validating', 'planning', 'executing'].includes(session.state)
        ? ['respond', 'wait']
        : session.state === 'awaiting_player'
        ? ['clarify']
        : session.state === 'ready_for_decision'
          ? ['respond', 'submit_followup']
          : ['respond'],
    };
  }

  markReplied(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) session.repliedAt = new Date(this.now()).toISOString();
  }

  cancelAll(reason: string): GoalContinuationV2[] {
    const out: GoalContinuationV2[] = [];
    for (const session of this.sessions.values()) {
      if (['completed', 'failed', 'cancelled', 'expired'].includes(session.state)) continue;
      out.push(this.cancelSession(session, session.activeRequestId ?? session.sessionId, reason));
    }
    return out;
  }

  nextMessageMeta(requestId: string, messageId: string, suffix: string): GoalInteractionMetaV2 | undefined {
    const sessionId = this.requestToSession.get(requestId);
    const session = sessionId ? this.sessions.get(sessionId) : undefined;
    const base = this.requestMeta.get(requestId);
    if (!session || !base) return undefined;
    const sequence = ++session.sequence;
    return {
      ...base,
      messageId,
      causationId: requestId,
      sequence,
      emittedAt: new Date(this.now()).toISOString(),
      idempotencyKey: `${session.correlationId}:${suffix}:${sequence}`,
    };
  }

  hasRequest(requestId?: string): boolean {
    return !!requestId && this.requestToSession.has(requestId);
  }

  /** FEAT-CROSS-21 · requestId → sessionId（完成确认闸取根判据用）。 */
  sessionIdForRequest(requestId: string): string | undefined {
    return this.requestToSession.get(requestId);
  }

  abandonSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || ['completed','failed','cancelled','expired'].includes(session.state)) return;
    session.state = 'cancelled';
    if (this.awaitingPlayerSessionId === sessionId) this.awaitingPlayerSessionId = null;
  }

  expireSession(sessionId: string): InteractionSessionV2 | undefined {
    const session = this.sessions.get(sessionId);
    if (!session || ['completed', 'failed', 'cancelled', 'expired'].includes(session.state)) {
      return session ? { ...session, childRequestIds: [...session.childRequestIds] } : undefined;
    }
    session.state = 'expired';
    if (this.awaitingPlayerSessionId === sessionId) this.awaitingPlayerSessionId = null;
    return { ...session, childRequestIds: [...session.childRequestIds] };
  }

  getSession(sessionId: string): InteractionSessionV2 | undefined {
    const session = this.sessions.get(sessionId);
    return session ? { ...session, childRequestIds: [...session.childRequestIds] } : undefined;
  }

  private expireStale(): void {
    const now = this.now();
    for (const session of this.sessions.values()) {
      if (Date.parse(session.expiresAt) > now || ['completed', 'failed', 'cancelled', 'expired'].includes(session.state)) continue;
      session.state = 'expired';
      if (this.awaitingPlayerSessionId === session.sessionId) this.awaitingPlayerSessionId = null;
    }
  }

  private cancelSession(session: MutableSession, requestId: string, reason: string): GoalContinuationV2 {
    const base = session.activeRequestId ? this.requestMeta.get(session.activeRequestId) : undefined;
    const sequence = ++session.sequence;
    const meta: GoalInteractionMetaV2 = base ? {
      ...base,
      messageId: `goal-report-${randomUUID()}`,
      causationId: requestId,
      sequence,
      emittedAt: new Date(this.now()).toISOString(),
      idempotencyKey: `${session.correlationId}:cancelled:${sequence}`,
    } : {
      schemaVersion: GOAL_INTERACTION_SCHEMA_VERSION_V2,
      sessionId: session.sessionId,
      messageId: `goal-report-${randomUUID()}`,
      correlationId: session.correlationId,
      conversationId: session.conversationId,
      sequence,
      emittedAt: new Date(this.now()).toISOString(),
      idempotencyKey: `${session.correlationId}:cancelled:${sequence}`,
    };
    session.state = 'cancelled';
    if (this.awaitingPlayerSessionId === session.sessionId) this.awaitingPlayerSessionId = null;
    return {
      session: {
        sessionId: session.sessionId,
        origin: session.origin,
        originalText: session.originalText,
        desiredOutcome: session.desiredOutcome,
        state: 'cancelled',
        replyObligation: session.replyObligation,
      },
      triggeringReport: {
        meta,
        requestId,
        status: 'cancelled',
        summary: '任务已停止。',
        evidence: [{
          type: 'action_result',
          ref: `cancel:${reason.slice(0, 80)}`,
          observedAt: new Date(this.now()).toISOString(),
        }],
      },
      allowedDecisions: ['respond'],
    };
  }
}

function isPlayerOrigin(session: MutableSession): boolean {
  return session.origin === 'player';
}

function cloneInitiative(value: GoalInitiativeProvenanceV2): GoalInitiativeProvenanceV2 {
  return { ...value, evidenceRefs: [...value.evidenceRefs] };
}
