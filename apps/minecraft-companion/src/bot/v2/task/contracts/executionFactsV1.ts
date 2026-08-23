export const EXECUTION_FACT_SCHEMA_V1 = 'mineclaw.execution-fact/v1' as const;

export const EXECUTION_FACT_TYPES_V1 = [
  'execution.session.started',
  'execution.plan.bound',
  'execution.state.changed',
  'execution.action.proposed',
  'execution.action.prepared',
  'execution.action.completed',
  'execution.progress.observed',
  'execution.recovery.decided',
  'execution.session.paused_owner',
  'execution.session.resumed',
  'execution.session.terminal',
  'execution.late_result_ignored',
] as const;

export type ExecutionFactTypeV1 = typeof EXECUTION_FACT_TYPES_V1[number];
export type LeafOutcomeV1 = 'succeeded' | 'failed' | 'cancelled';
export type LeafHandoffV1 = 'none' | 'graph_replan_required';

export interface GoalVerdictV1 {
  ok: boolean;
  detail: string;
  evidenceRefs?: string[];
}

export interface FailureEnvelopeV1 {
  code: string;
  origin: 'decision' | 'contract' | 'atomic' | 'behavior' | 'navigation'
    | 'perception' | 'environment' | 'infra' | 'safety';
  stage: 'deciding' | 'preparing' | 'executing' | 'observing' | 'verifying';
  category: 'contract' | 'precondition' | 'resource' | 'navigation'
    | 'environment' | 'transient' | 'timeout' | 'cancelled' | 'fatal';
  retryable: boolean;
  ownerActionable: boolean;
  evidenceRefs: string[];
  detail?: string;
}

export interface LeafTerminalPayloadV1 {
  outcome: LeafOutcomeV1;
  handoff: LeafHandoffV1;
  verdict: GoalVerdictV1;
  failure?: FailureEnvelopeV1;
}

export interface ExecutionFactEnvelopeV1 {
  schema: typeof EXECUTION_FACT_SCHEMA_V1;
  eventId: string;
  eventType: string;
  sessionId: string;
  runId: string;
  planRunId: string;
  planRevision: number;
  nodeId: string;
  sequence: number;
  occurredAt: string;
  codeRevision: string;
  configRevision: string;
  causationId?: string;
  correlationId: string;
  payload: Record<string, unknown>;
}

export interface ExecutionFactContextV1 {
  sessionId: string;
  runId: string;
  planRunId: string;
  planRevision: number;
  nodeId: string;
  correlationId: string;
}

export interface ExecutionFactPageV1 {
  facts: ExecutionFactEnvelopeV1[];
  nextCursor: string | null;
}

export type ExecutionFactParseResult =
  | { kind: 'valid'; fact: ExecutionFactEnvelopeV1; knownEventType: boolean }
  | { kind: 'unsupported_schema'; schema: string }
  | { kind: 'invalid'; reason: string };

const KNOWN_TYPES = new Set<string>(EXECUTION_FACT_TYPES_V1);

export function parseExecutionFactV1(input: unknown): ExecutionFactParseResult {
  if (!isRecord(input)) return { kind: 'invalid', reason: 'envelope_not_object' };
  const schema = stringField(input, 'schema');
  if (!schema) return { kind: 'invalid', reason: 'schema_missing' };
  if (schema !== EXECUTION_FACT_SCHEMA_V1) return { kind: 'unsupported_schema', schema };
  for (const field of [
    'eventId', 'eventType', 'sessionId', 'runId', 'planRunId', 'nodeId',
    'occurredAt', 'codeRevision', 'configRevision', 'correlationId',
  ] as const) {
    if (!stringField(input, field)) return { kind: 'invalid', reason: `${field}_missing` };
  }
  if (!Number.isInteger(input.planRevision) || Number(input.planRevision) < 1) {
    return { kind: 'invalid', reason: 'planRevision_invalid' };
  }
  if (!Number.isInteger(input.sequence) || Number(input.sequence) < 1) {
    return { kind: 'invalid', reason: 'sequence_invalid' };
  }
  if (Number.isNaN(Date.parse(String(input.occurredAt)))) return { kind: 'invalid', reason: 'occurredAt_invalid' };
  if (!isRecord(input.payload)) return { kind: 'invalid', reason: 'payload_not_object' };
  if (input.causationId != null && !stringField(input, 'causationId')) {
    return { kind: 'invalid', reason: 'causationId_invalid' };
  }
  const fact: ExecutionFactEnvelopeV1 = {
    schema: EXECUTION_FACT_SCHEMA_V1,
    eventId: String(input.eventId), eventType: String(input.eventType),
    sessionId: String(input.sessionId), runId: String(input.runId),
    planRunId: String(input.planRunId), planRevision: Number(input.planRevision),
    nodeId: String(input.nodeId), sequence: Number(input.sequence), occurredAt: String(input.occurredAt),
    codeRevision: String(input.codeRevision), configRevision: String(input.configRevision),
    correlationId: String(input.correlationId), payload: { ...input.payload },
    ...(input.causationId ? { causationId: String(input.causationId) } : {}),
  };
  if (fact.eventType === 'execution.session.terminal') {
    const invalid = validateTerminalPayload(fact.payload);
    if (invalid) return { kind: 'invalid', reason: invalid };
  }
  return { kind: 'valid', fact, knownEventType: KNOWN_TYPES.has(fact.eventType) };
}

export function isKnownExecutionFactTypeV1(type: string): type is ExecutionFactTypeV1 {
  return KNOWN_TYPES.has(type);
}

export function terminalPayloadV1(fact: ExecutionFactEnvelopeV1): LeafTerminalPayloadV1 | null {
  return fact.eventType === 'execution.session.terminal'
    ? fact.payload as unknown as LeafTerminalPayloadV1
    : null;
}

function validateTerminalPayload(payload: Record<string, unknown>): string | null {
  if (!['succeeded', 'failed', 'cancelled'].includes(String(payload.outcome ?? ''))) return 'terminal_outcome_invalid';
  if (!['none', 'graph_replan_required'].includes(String(payload.handoff ?? ''))) return 'terminal_handoff_invalid';
  if (!isRecord(payload.verdict) || typeof payload.verdict.ok !== 'boolean' || !stringField(payload.verdict, 'detail')) {
    return 'terminal_verdict_invalid';
  }
  if (payload.failure != null && !isRecord(payload.failure)) return 'terminal_failure_invalid';
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, field: string): string | null {
  const value = record[field];
  return typeof value === 'string' && value.trim() ? value : null;
}
