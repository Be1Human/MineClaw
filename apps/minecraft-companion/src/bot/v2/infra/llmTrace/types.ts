export const LLM_TRACE_EVENT_SCHEMA_V1 = 'mineclaw.llm-trace-event/v1' as const;

export type LlmTraceAgent = 'mainbrain' | 'goalagent' | 'system' | 'unknown';

export type LlmTraceEventType =
  | 'interaction.received'
  | 'llm.request.recorded'
  | 'llm.response.recorded'
  | 'llm.call.failed'
  | 'llm.call.cancelled'
  | 'trace.persistence_gap'
  | 'delegation.submitted'
  | 'delegation.accepted'
  | 'agent.node.entered'
  | 'agent.node.exited'
  | 'context.source.selected'
  | 'context.source.omitted'
  | 'tool.call'
  | 'tool.result'
  | 'world.observed'
  | 'verdict.recorded'
  | 'session.terminal';

export type LlmTraceJsonPrimitive = string | number | boolean | null;
export type LlmTraceJsonValue =
  | LlmTraceJsonPrimitive
  | LlmTraceJsonValue[]
  | { [key: string]: LlmTraceJsonValue };

export interface TraceContextSourceRef {
  kind: string;
  ref: string;
  version?: string;
  contentHash?: string;
  characters?: number;
  estimatedTokens?: number;
  messageIndexes?: number[];
}

export interface TraceContextOmission extends TraceContextSourceRef {
  reason: string;
}

export interface LlmRequestEnvelopeV1 {
  provider: string;
  baseUrlOrigin?: string;
  model: string;
  messages: LlmTraceJsonValue[];
  tools: LlmTraceJsonValue[];
  toolChoice?: LlmTraceJsonValue;
  temperature?: number;
  maxTokens?: number;
  timeoutMs: number;
  context: {
    selected: TraceContextSourceRef[];
    omitted: TraceContextOmission[];
  };
}

export interface LlmTraceEventV1 {
  schema: typeof LLM_TRACE_EVENT_SCHEMA_V1;
  eventId: string;
  profileId: string;
  seq: number;
  occurredAt: string;
  type: LlmTraceEventType;
  callId?: string;
  parentCallId?: string;
  correlationId?: string;
  interactionSessionId?: string;
  goalSessionId?: string;
  taskId?: string;
  agent: LlmTraceAgent;
  node?: string;
  turn?: number;
  modelCallIndex?: number;
  stateRevision?: number;
  epoch?: number;
  payload: Record<string, LlmTraceJsonValue>;
}

export type LlmTraceEventInputV1 = Omit<
  LlmTraceEventV1,
  'schema' | 'eventId' | 'profileId' | 'seq'
> & {
  eventId?: string;
};

export interface LlmTraceOpenCall {
  callId: string;
  requestSeq: number;
  occurredAt: string;
  agent: LlmTraceAgent;
  node?: string;
  interactionSessionId?: string;
  goalSessionId?: string;
  taskId?: string;
}

export interface LlmTraceEventPage {
  events: LlmTraceEventV1[];
  hasMore: boolean;
}

export interface LlmTraceEventQuery {
  afterSeq?: number;
  beforeSeq?: number;
  limit?: number;
  callId?: string;
  interactionSessionId?: string;
  goalSessionId?: string;
  taskId?: string;
  agent?: LlmTraceAgent;
  types?: LlmTraceEventType[];
  includeArchived?: boolean;
}

export interface LlmTraceCallContext {
  callId?: string;
  parentCallId?: string;
  correlationId?: string;
  interactionSessionId?: string;
  goalSessionId?: string;
  taskId?: string;
  agent?: LlmTraceAgent;
  node?: string;
  turn?: number;
  modelCallIndex?: number;
  stateRevision?: number;
  epoch?: number;
  contextSources?: {
    selected: TraceContextSourceRef[];
    omitted: TraceContextOmission[];
  };
  abortReason?: string;
}

export interface LlmTraceRecorderPort {
  append(input: LlmTraceEventInputV1): LlmTraceEventV1 | Promise<LlmTraceEventV1>;
}

export function isLlmTraceEventType(value: unknown): value is LlmTraceEventType {
  return typeof value === 'string' && LLM_TRACE_EVENT_TYPES.has(value as LlmTraceEventType);
}

const LLM_TRACE_EVENT_TYPES = new Set<LlmTraceEventType>([
  'interaction.received',
  'llm.request.recorded',
  'llm.response.recorded',
  'llm.call.failed',
  'llm.call.cancelled',
  'trace.persistence_gap',
  'delegation.submitted',
  'delegation.accepted',
  'agent.node.entered',
  'agent.node.exited',
  'context.source.selected',
  'context.source.omitted',
  'tool.call',
  'tool.result',
  'world.observed',
  'verdict.recorded',
  'session.terminal',
]);
