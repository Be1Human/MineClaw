/**
 * FEAT-CROSS-28 · Knowledge query session (design §5.6).
 * One query = one logical terminal answer; delivery is at-least-once and the
 * player side deduplicates by replyKey. A query never becomes a task session
 * supplement, and late results after cancellation never revive the session.
 */
import { pluginError } from '../../plugin-sdk/errors.js';
import type {
  KnowledgeQueryV1,
  KnowledgeAnswerV1,
  KnowledgeAnswerOutcome,
} from './knowledgeQueryContracts.js';
import { replyKeyFor } from './knowledgeQueryContracts.js';

export type KnowledgeQuerySessionState =
  | 'accepted'
  | 'running'
  | 'answer_recorded'
  | 'delivery_pending'
  | 'delivered'
  | 'cancelled'
  | 'failed';

export interface KnowledgeQuerySessionRecord {
  sessionId: string;
  readonly query: KnowledgeQueryV1;
  requestId: string;
  correlationId: string;
  idempotencyKey: string;
  replyKey: string;
  state: KnowledgeQuerySessionState;
  answer: KnowledgeAnswerV1 | null;
  delivered: boolean;
  deliveryAttempts: number;
  createdAt: string;
  updatedAt: string;
}

export interface QueryReceipt {
  readonly sessionId: string;
  readonly requestId: string;
  readonly acceptedAt: string;
}

export interface DeliveryReceipt {
  readonly sessionId: string;
  readonly replyKey: string;
  readonly resolvedBy: 'player_reply' | 'deterministic_fallback' | 'timeout_fallback';
  readonly at: string;
}

/**
 * Deterministic session store behaviour (the caller supplies persistence for a
 * durable outbox; this class is the state machine around it).
 */
export class KnowledgeQuerySessionStore {
  private readonly sessions = new Map<string, KnowledgeQuerySessionRecord>();
  private readonly byRequest = new Map<string, string>();
  private readonly byIdempotency = new Map<string, string>();

  create(query: KnowledgeQueryV1): QueryReceipt {
    const existingByRequest = this.byRequest.get(query.requestId);
    if (existingByRequest) {
      const record = this.sessions.get(existingByRequest)!;
      if (record.query.idempotencyKey !== query.idempotencyKey) {
        throw pluginError('id_conflict', `requestId ${query.requestId} reused with a different idempotency key`);
      }
      if (record.state === 'delivered' || record.state === 'cancelled' || record.state === 'failed') {
        throw pluginError('id_conflict', `requestId ${query.requestId} already finished`);
      }
      return { sessionId: record.sessionId, requestId: record.requestId, acceptedAt: record.createdAt };
    }
    const existingByIdempotency = this.byIdempotency.get(query.idempotencyKey);
    if (existingByIdempotency) {
      const record = this.sessions.get(existingByIdempotency)!;
      if (record.state === 'delivered' || record.state === 'cancelled' || record.state === 'failed') {
        throw pluginError('id_conflict', `idempotency key ${query.idempotencyKey} already finished`);
      }
      return { sessionId: record.sessionId, requestId: record.requestId, acceptedAt: record.createdAt };
    }
    const now = new Date().toISOString();
    const sessionId = `kq:${query.requestId}`;
    const record: KnowledgeQuerySessionRecord = {
      sessionId,
      query: Object.freeze({ ...query }),
      requestId: query.requestId,
      correlationId: query.correlationId,
      idempotencyKey: query.idempotencyKey,
      replyKey: replyKeyFor(query),
      state: 'accepted',
      answer: null,
      delivered: false,
      deliveryAttempts: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.set(sessionId, record);
    this.byRequest.set(query.requestId, sessionId);
    this.byIdempotency.set(query.idempotencyKey, sessionId);
    return { sessionId, requestId: query.requestId, acceptedAt: now };
  }

  markRunning(requestId: string): void {
    const record = this.require(requestId);
    if (record.state !== 'accepted') throw pluginError('plugin_cancelled', `session ${record.sessionId} is ${record.state}, not accepted`);
    record.state = 'running';
    record.updatedAt = new Date().toISOString();
  }

  /**
   * Record the single logical terminal answer. A second logical terminal is a
   * contract violation; the session stays immutable once terminal.
   */
  recordAnswer(requestId: string, answer: KnowledgeAnswerV1): KnowledgeQuerySessionRecord {
    const record = this.require(requestId);
    if (record.state === 'delivered' || record.state === 'cancelled' || record.state === 'failed') {
      throw pluginError('plugin_cancelled', `session ${record.sessionId} is terminal (${record.state})`);
    }
    if (record.answer !== null) {
      throw pluginError('id_conflict', `session ${record.sessionId} already has a logical terminal answer`);
    }
    if (answer.outcome === 'cancelled') {
      record.state = 'cancelled';
      record.answer = answer;
      record.updatedAt = new Date().toISOString();
      return record;
    }
    record.state = 'answer_recorded';
    record.answer = Object.freeze({ ...answer });
    record.updatedAt = new Date().toISOString();
    return record;
  }

  markDeliveryPending(requestId: string): void {
    const record = this.require(requestId);
    if (record.answer === null) throw pluginError('plugin_cancelled', `session ${record.sessionId} has no recorded answer`);
    if (record.state !== 'answer_recorded' && record.state !== 'delivery_pending') {
      throw pluginError('plugin_cancelled', `session ${record.sessionId} is ${record.state}`);
    }
    record.state = 'delivery_pending';
    record.deliveryAttempts += 1;
    record.updatedAt = new Date().toISOString();
  }

  resolveDelivery(requestId: string, resolvedBy: DeliveryReceipt['resolvedBy']): DeliveryReceipt {
    const record = this.require(requestId);
    if (record.delivered) throw pluginError('id_conflict', `session ${record.sessionId} already delivered`);
    record.delivered = true;
    record.state = 'delivered';
    record.updatedAt = new Date().toISOString();
    return { sessionId: record.sessionId, replyKey: record.replyKey, resolvedBy, at: record.updatedAt };
  }

  /** A late result after cancellation stays audit-only: the session cannot revive. */
  recordLateRejected(requestId: string): void {
    const record = this.require(requestId);
    if (record.state !== 'cancelled' && record.state !== 'delivered' && record.state !== 'failed') return;
    record.updatedAt = new Date().toISOString();
  }

  /** Deterministic timeout/fallback terminal for a query that never got an answer. */
  fail(requestId: string, reason: string): KnowledgeQuerySessionRecord {
    const record = this.require(requestId);
    if (record.answer !== null) return record;
    record.state = 'failed';
    record.updatedAt = new Date().toISOString();
    void reason;
    return record;
  }

  get(requestId: string): KnowledgeQuerySessionRecord | null {
    const sessionId = this.byRequest.get(requestId);
    return sessionId ? this.sessions.get(sessionId) ?? null : null;
  }

  listByState(state: KnowledgeQuerySessionState): readonly KnowledgeQuerySessionRecord[] {
    return [...this.sessions.values()].filter(record => record.state === state);
  }

  private require(requestId: string): KnowledgeQuerySessionRecord {
    const record = this.get(requestId);
    if (!record) throw pluginError('reference_unresolved', `unknown query requestId ${requestId}`);
    return record;
  }
}

/**
 * Outcome map: which logical terminal the session produces for each answer
 * outcome — the single source of truth for "one query, one terminal answer".
 */
export function logicalTerminalOutcome(outcome: KnowledgeAnswerOutcome): 'answered' | 'not_answered' {
  switch (outcome) {
    case 'answered': return 'answered';
    case 'not_found':
    case 'unsupported':
    case 'ambiguous':
    case 'unavailable':
    case 'cancelled':
      return 'not_answered';
  }
}
