/**
 * FEAT-CROSS-28 · Typed cross-agent request/answer contracts (design §5.2).
 * The composition root accepts only this discriminated union; the legacy
 * GoalRequestV2(requestKind: 'query') write path is migrated and removed by the
 * completion of FEAT-CROSS-28-001.
 */
import type { FactKind } from '../../plugin-sdk/contracts/observation.js';
import type { RegistrySnapshotRef } from '../../plugin-sdk/identity.js';

export interface KnowledgeQueryMetaV1 {
  readonly schemaVersion: 'mineclaw.knowledge-query/v1';
  readonly requestId: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly emittedAt: string;
  readonly causationId?: string;
}

export type KnowledgeQuerySource = 'player' | 'mainbrain_self' | 'task_prepare';
export type KnowledgeReplyMode = 'answer_player' | 'prepare_task';

export interface QueryAnchor {
  readonly kind: 'bot_self' | 'owner' | 'coordinate' | 'entity';
  readonly value?: Readonly<Record<string, unknown>>;
}

export interface QueryScope {
  readonly radius?: number;
  readonly maxResults?: number;
  readonly maxBlocks?: number;
  readonly dimension?: string;
  /** All query budgets/ranges come from the runtime tuning namespace (F06), never hardcoded. */
  readonly budgetRef?: string;
}

export interface FreshnessRequirement {
  readonly maxAgeMs: number;
  readonly observedAfter?: string;
}

export interface KnowledgeQueryV1 extends KnowledgeQueryMetaV1 {
  readonly kind: 'knowledge_query';
  readonly source: KnowledgeQuerySource;
  readonly replyMode: KnowledgeReplyMode;
  readonly originalText: string;
  readonly factKinds: readonly FactKind[];
  readonly anchor: QueryAnchor;
  readonly scope: QueryScope;
  readonly freshness: FreshnessRequirement;
  readonly registryGeneration: RegistrySnapshotRef;
}

export interface TaskRequestV1 extends KnowledgeQueryMetaV1 {
  readonly kind: 'task';
  readonly source: 'player' | 'mainbrain_self';
  readonly originalText: string;
  readonly requestText: string;
  readonly constraints: readonly string[];
  readonly prepareEvidenceRefs?: readonly string[];
}

export interface CancelRequestV1 extends KnowledgeQueryMetaV1 {
  readonly kind: 'cancel';
  readonly targetRequestId: string;
  readonly source: 'player' | 'mainbrain_self';
  readonly reason?: string;
}

export type AgentRequestV1 = TaskRequestV1 | KnowledgeQueryV1 | CancelRequestV1;

export type KnowledgeAnswerOutcome =
  | 'answered'
  | 'not_found'
  | 'unsupported'
  | 'ambiguous'
  | 'unavailable'
  | 'cancelled';

export interface KnowledgeEvidenceRef {
  readonly ref: string;
  readonly source: string;
  readonly at: string;
}

export interface KnowledgeFact {
  readonly factKind: FactKind;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly observedAt: string;
  readonly requestedBounds: Readonly<Record<string, unknown>>;
  readonly observedBounds: Readonly<Record<string, unknown>>;
  readonly complete: boolean;
  readonly truncated: boolean;
  readonly evidenceRefs: readonly KnowledgeEvidenceRef[];
}

export interface FreshnessAssessment {
  readonly fresh: boolean;
  readonly observedAt: string;
  readonly staleReason?: string;
}

export interface Coverage {
  readonly dimension: string;
  readonly requested: Readonly<Record<string, unknown>>;
  readonly covered: Readonly<Record<string, unknown>>;
  readonly loaded: boolean;
}

export interface ClarificationRequest {
  readonly questionKind: string;
  readonly options: readonly string[];
  readonly question: string;
}

export interface KnowledgeAnswerV1 {
  readonly schemaVersion: 'mineclaw.knowledge-answer/v1';
  readonly kind: 'knowledge_answer';
  readonly requestId: string;
  readonly correlationId: string;
  readonly outcome: KnowledgeAnswerOutcome;
  readonly facts: readonly KnowledgeFact[];
  readonly observedAt: string;
  readonly freshness: FreshnessAssessment;
  readonly coverage: Coverage;
  readonly completeness: 'complete' | 'partial' | 'not_applicable';
  readonly evidenceRefs: readonly KnowledgeEvidenceRef[];
  readonly reason?: string;
  readonly clarification?: ClarificationRequest;
  readonly replyKey: string;
  readonly registryGeneration: RegistrySnapshotRef;
}

/** Must be unique per query; at-least-once delivery deduplicates on the player side. */
export function replyKeyFor(query: KnowledgeQueryV1): string {
  return `kq:${query.correlationId}:${query.requestId}`;
}

export function isKnowledgeQuery(request: AgentRequestV1): request is KnowledgeQueryV1 {
  return request.kind === 'knowledge_query';
}

export function isTaskRequest(request: AgentRequestV1): request is TaskRequestV1 {
  return request.kind === 'task';
}

export function isCancelRequest(request: AgentRequestV1): request is CancelRequestV1 {
  return request.kind === 'cancel';
}
