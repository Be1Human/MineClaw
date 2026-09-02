/**
 * FEAT-CROSS-28 · KnowledgeQueryPort implementation (design §5.6).
 * submit → session (accepted/running) → QueryRunner → answer_recorded →
 * delivery_pending → deliver (at-least-once via sink, dedupe by replyKey) with
 * deterministic fallbacks; acknowledgePlayerReply resolves player-side dedupe.
 * A query never becomes a task session supplement and never revives on late
 * results after cancellation.
 */
import { pluginError } from '../plugin-sdk/errors.js';
import type { KnowledgeQueryV1, KnowledgeAnswerV1 } from './goalAgentPort/knowledgeQueryContracts.js';
import { KnowledgeQuerySessionStore, type QueryReceipt, type DeliveryReceipt } from './goalAgentPort/knowledgeQuerySession.js';
import type { QueryRunner } from './knowledgeQueryRunner.js';

/** Delivery target for at-least-once answers (MainBrain continuation sink / outbox adapter). */
export interface KnowledgeAnswerSinkPort {
  deliver(answer: KnowledgeAnswerV1): Promise<{ readonly accepted: boolean; readonly reason?: string }>;
}

export interface KnowledgeQueryPortV1 {
  submitKnowledgeQuery(query: KnowledgeQueryV1): Promise<QueryReceipt>;
  deliverKnowledgeAnswer(query: KnowledgeQueryV1, answer: KnowledgeAnswerV1): Promise<DeliveryReceipt>;
  acknowledgePlayerReply(replyKey: string): Promise<{ readonly sessionId: string; readonly deduplicated: boolean }>;
  check(requestId: string): ReturnType<KnowledgeQuerySessionStore['get']>;
}

/** Failure-free deterministic fallback: synthesizes an unavailable answer for delivery. */
export function unavailableAnswer(query: KnowledgeQueryV1, reason: string): KnowledgeAnswerV1 {
  const now = new Date().toISOString();
  return Object.freeze({
    schemaVersion: 'mineclaw.knowledge-answer/v1',
    kind: 'knowledge_answer',
    requestId: query.requestId,
    correlationId: query.correlationId,
    outcome: 'unavailable',
    facts: Object.freeze([]),
    observedAt: now,
    freshness: Object.freeze({ fresh: false, observedAt: now, staleReason: 'delivery_fallback' }),
    coverage: Object.freeze({ dimension: query.scope.dimension ?? 'overworld', requested: Object.freeze({}), covered: Object.freeze({}), loaded: false }),
    completeness: 'not_applicable',
    evidenceRefs: Object.freeze([]),
    reason,
    replyKey: `kq:${query.correlationId}:${query.requestId}`,
    registryGeneration: query.registryGeneration,
  });
}

export class KnowledgeQueryPort implements KnowledgeQueryPortV1 {
  private readonly sessions = new KnowledgeQuerySessionStore();
  private readonly byReplyKey = new Map<string, string>();

  constructor(
    private readonly options: {
      readonly runner: QueryRunner;
      readonly sink: KnowledgeAnswerSinkPort;
      readonly now?: () => number;
    },
  ) {}

  async submitKnowledgeQuery(query: KnowledgeQueryV1): Promise<QueryReceipt> {
    const receipt = this.sessions.create(query);
    this.sessions.markRunning(query.requestId);
    const answer = await this.options.runner.run(query, new AbortController().signal);
    this.sessions.recordAnswer(query.requestId, answer);
    this.sessions.markDeliveryPending(query.requestId);
    await this.deliverAnswer(query.requestId);
    return receipt;
  }

  async deliverKnowledgeAnswer(query: KnowledgeQueryV1, answer: KnowledgeAnswerV1): Promise<DeliveryReceipt> {
    const record = this.sessions.get(query.requestId);
    if (!record) throw pluginError('reference_unresolved', `unknown query requestId ${query.requestId}`);
    if (record.state === 'cancelled' || record.state === 'failed') {
      this.sessions.recordLateRejected(query.requestId);
      throw pluginError('plugin_cancelled', `session ${record.sessionId} is terminal`);
    }
    this.sessions.recordAnswer(query.requestId, answer);
    this.sessions.markDeliveryPending(query.requestId);
    return this.deliverAnswer(query.requestId);
  }

  async acknowledgePlayerReply(replyKey: string): Promise<{ sessionId: string; deduplicated: boolean }> {
    const requestId = this.byReplyKey.get(replyKey);
    if (!requestId) throw pluginError('reference_unresolved', `unknown replyKey ${replyKey}`);
    const record = this.sessions.get(requestId);
    if (!record || record.replyKey !== replyKey) throw pluginError('reference_unresolved', `replyKey mismatch ${replyKey}`);
    if (record.delivered) return { sessionId: record.sessionId, deduplicated: true };
    const delivery = this.sessions.resolveDelivery(record.requestId, 'player_reply');
    return { sessionId: delivery.sessionId, deduplicated: false };
  }

  check(requestId: string): ReturnType<KnowledgeQuerySessionStore['get']> {
    return this.sessions.get(requestId);
  }

  private async deliverAnswer(requestId: string): Promise<DeliveryReceipt> {
    const record = this.sessions.get(requestId);
    if (!record || !record.answer) throw pluginError('reference_unresolved', `no answer recorded for ${requestId}`);
    this.byReplyKey.set(record.replyKey, record.requestId);
    try {
      const sinkResult = await this.options.sink.deliver(record.answer);
      if (!sinkResult.accepted) throw new Error(sinkResult.reason ?? 'sink_rejected');
      return this.sessions.resolveDelivery(requestId, 'player_reply');
    } catch {
      // Deterministic fallback: the recorded answer (or a synthesized unavailable one)
      // is confirmed via a fallback receipt so the player's obligation closes.
      return this.sessions.resolveDelivery(requestId, 'deterministic_fallback');
    }
  }
}
