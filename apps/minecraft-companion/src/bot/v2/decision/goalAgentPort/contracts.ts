export const GOAL_INTERACTION_SCHEMA_V1 = 'mineclaw.goal-interaction/v1' as const;
export const GOAL_INTERACTION_SCHEMA_VERSION_V2 = 2 as const;

export interface GoalInteractionMetaV2 {
  schemaVersion: typeof GOAL_INTERACTION_SCHEMA_VERSION_V2;
  sessionId: string;
  messageId: string;
  correlationId: string;
  causationId?: string;
  conversationId: string;
  sequence: number;
  emittedAt: string;
  expiresAt?: string;
  idempotencyKey: string;
}

/** FEAT-CROSS-25 · MainBrain 主动能力的可审计来源。 */
export interface GoalInitiativeProvenanceV2 {
  capabilityId: string;
  activationId: string;
  evidenceRefs: string[];
  idempotencyKey: string;
  preemptible: boolean;
}

export interface GoalRequestV2 {
  meta: GoalInteractionMetaV2;
  parentRequestId?: string;
  origin: 'player_message' | 'mainbrain_self';
  /** 玩家原话（自主任务等于 requestText），用于歧义和审计，MainBrain 不得覆盖。 */
  originalText: string;
  /** MainBrain 当前委托意图；可直接任务，也可先查询。 */
  requestText: string;
  requestKind: 'task' | 'query' | 'cancel';
  queryPurpose?: 'answer_player' | 'prepare_task';
  constraints: string[];
  /** 仅 mainbrain_self 主动能力携带；玩家请求不得伪造。 */
  initiative?: GoalInitiativeProvenanceV2;
}

export type GoalIntentKindV2 = 'query' | 'action' | 'cancel';

export interface ClassifiedGoalRequestV2 extends GoalRequestV2 {
  intentKind: GoalIntentKindV2;
}

export interface GoalEvidenceV2 {
  type: 'world_snapshot' | 'inventory_delta' | 'action_result' | 'root_verdict';
  ref: string;
  observedAt: string;
}

export type GoalProgressUpdateKindV2 = 'milestone' | 'obstacle' | 'decision' | 'recovery' | 'resolved';

/** A committed non-terminal fact. MainBrain may phrase it, but must not reinterpret it as a new request. */
export interface GoalProgressUpdateV2 {
  kind: GoalProgressUpdateKindV2;
  importance: 'low' | 'medium' | 'high' | 'critical';
  episodeKey: string;
  dedupeKey: string;
  ownerActionable: boolean;
  nextAction?: string;
}

export interface GoalReportV2 {
  meta: GoalInteractionMetaV2;
  requestId: string;
  status: 'answered' | 'running' | 'completed' | 'failed' | 'need_clarification' | 'cancelled' |
    'communication_delayed';
  summary: string;
  progress?: { current: number; total?: number; milestone?: string };
  evidence: GoalEvidenceV2[];
  /** FEAT-CROSS-18: typed semantics for a meaningful running-state update. */
  update?: GoalProgressUpdateV2;
}

export interface GoalStatusProbeV2 {
  meta: GoalInteractionMetaV2;
  sessionId: string;
  requestId: string;
  reason: 'first_report_due' | 'silence_due' | 'user_requested';
}

export interface GoalStatusSnapshotV2 {
  sessionId: string;
  requestId: string;
  state: 'queued' | 'resolving' | 'planning' | 'executing' | 'blocked' | 'recovering' |
    'completed' | 'failed' | 'unknown';
  stage?: string;
  lastProgressAt?: string;
  blocker?: string;
  nextAction?: string;
  runtimeRef?: string;
  evidence: GoalEvidenceV2[];
  observedAt: string;
}

export interface GoalMessageReceiptV2 {
  meta: GoalInteractionMetaV2;
  sourceMessageId: string;
  outcome: 'received' | 'consumed' | 'ignored' | 'failed';
  reason?: string;
}

export interface InteractionSessionV2 {
  sessionId: string;
  origin: 'player' | 'mainbrain_self';
  originTurnId: string;
  originalText: string;
  desiredOutcome: string;
  state: 'opened' | 'awaiting_report' | 'resolving' | 'contract_validating' | 'awaiting_player' |
    'ready_for_decision' | 'planning' | 'executing' | 'completed' | 'failed' | 'cancelled' | 'expired';
  replyObligation: 'must_reply' | 'may_reply' | 'silent_allowed';
  activeRequestId?: string;
  childRequestIds: string[];
  expiresAt: string;
}

export interface GoalContinuationV2 {
  session: Pick<InteractionSessionV2,
    'sessionId' | 'origin' | 'originalText' | 'desiredOutcome' | 'state' | 'replyObligation'>;
  triggeringReport: GoalReportV2;
  reason?: 'receipt_timeout' | 'session_expired' | 'first_report_due' | 'silence_due' | 'user_requested' |
    'communication_delayed';
  statusSnapshot?: GoalStatusSnapshotV2;
  allowedDecisions: Array<'respond' | 'clarify' | 'submit_followup' | 'wait'>;
}

export interface GoalInteractionMetaV1 {
  schema: typeof GOAL_INTERACTION_SCHEMA_V1;
  messageId: string;
  correlationId: string;
  idempotencyKey: string;
  sequence: number;
  createdAt: string;
  expiresAt?: string;
}

export interface GoalRequestV1 {
  meta: GoalInteractionMetaV1;
  origin: 'player' | 'mainbrain_self';
  intentKind: 'query' | 'action' | 'cancel';
  requestText: string;
  constraints?: string[];
}

export interface GoalEvidenceV1 {
  type: 'world_snapshot' | 'inventory_delta' | 'action_result' | 'root_verdict';
  ref: string;
  observedAt: string;
}

export interface GoalReportV1 {
  meta: GoalInteractionMetaV1;
  requestId: string;
  status: 'answered' | 'running' | 'completed' | 'failed' | 'need_clarification';
  summary: string;
  evidence: GoalEvidenceV1[];
}

export interface GoalNotificationV1 {
  meta: GoalInteractionMetaV1;
  eventType: 'danger' | 'discovery' | 'blocked' | 'progress_due' | 'autonomous_completed';
  urgency: 'critical' | 'high' | 'normal' | 'low';
  attentionClass: 'critical' | 'goal_relevant' | 'experience_worthy';
  episodeKey: string;
  state: 'opened' | 'updated' | 'resolved';
  summary: string;
  delta: Record<string, string | number | boolean>;
  evidence: GoalEvidenceV1[];
}

export interface GoalMessageReceiptV1 {
  meta: GoalInteractionMetaV1;
  sourceMessageId: string;
  outcome: 'received' | 'consumed' | 'ignored' | 'failed';
  reason?: string;
}
