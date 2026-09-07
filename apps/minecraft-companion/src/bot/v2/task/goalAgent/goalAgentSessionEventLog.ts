import { randomUUID } from 'node:crypto';
import type { LLMChatMessage } from '../../cognitive/llm/types.js';
import type { GoalAgentEventSource, GoalAgentStateV1 } from './goalAgentState.js';
import {
  GOAL_AGENT_COMPACTION_SCHEMA_V2,
  renderGoalAgentCompactionSummary,
  type GoalAgentCompactionProposalV2,
} from './goalAgentContextReducer.js';

export const GOAL_AGENT_SESSION_EVENT_SCHEMA_V1 = 'mineclaw.goal-agent-session-event/v1' as const;

export type GoalAgentSessionEventType =
  | 'input.accepted'
  | 'node.entered'
  | 'model.requested'
  | 'model.responded'
  | 'model.failed'
  | 'message.appended'
  | 'tool.called'
  | 'tool.result'
  | 'observation.recorded'
  | 'action.received'
  | 'verification.recorded'
  | 'terminal.recorded'
  | 'reflection.proposed'
  | 'reflection.skipped'
  | 'reflection.failed'
  | 'compaction.checkpoint'
  | 'state.checkpoint';

export interface GoalAgentSessionEventV1 {
  schema: typeof GOAL_AGENT_SESSION_EVENT_SCHEMA_V1;
  eventId: string;
  sessionId: string;
  seq: number;
  occurredAt: string;
  type: GoalAgentSessionEventType;
  node?: GoalAgentEventSource;
  stateRevision: number;
  epoch: number;
  payload: Record<string, unknown>;
}

export type GoalAgentSessionEventInput = Omit<GoalAgentSessionEventV1,
  'schema' | 'eventId' | 'seq'> & { eventId?: string };

export interface GoalAgentMessageAppendInput {
  sessionId: string;
  node: GoalAgentEventSource;
  stateRevision: number;
  epoch: number;
  message: LLMChatMessage;
  occurredAt?: string;
  /** Stable ordinal makes checkpoint retries idempotent. */
  messageIndex?: number;
}

export interface GoalAgentCompactionCheckpointInput extends GoalAgentCompactionProposalV2 {
  sessionId: string;
  node: GoalAgentEventSource;
  stateRevision: number;
  epoch: number;
  occurredAt?: string;
}

export interface GoalAgentProjectedCompaction {
  schema: 'mineclaw.goalagent-compaction/v1' | typeof GOAL_AGENT_COMPACTION_SCHEMA_V2;
  summarySurface: string;
  throughMessageIndex: number;
  coveredEventSeq?: { from: number; through: number };
}

export interface GoalAgentMessageProjection {
  /** Raw committed messages after the latest compaction boundary. */
  messages: LLMChatMessage[];
  messageRefs: Array<{ messageIndex: number; eventSeq: number }>;
  compactionSummary?: string;
  compaction?: GoalAgentProjectedCompaction;
  compactedThroughMessageIndex: number;
  rawMessageCount: number;
}

/**
 * Durable session facts used by context projection, resume, replay and trajectory.
 * Node/revision/epoch are event metadata only; none of them partitions visibility.
 */
export interface GoalAgentSessionEventLogPort {
  appendSessionEvent(input: GoalAgentSessionEventInput): GoalAgentSessionEventV1;
  appendMessage(input: GoalAgentMessageAppendInput): GoalAgentSessionEventV1;
  syncMessages(input: {
    sessionId: string;
    node: GoalAgentEventSource;
    stateRevision: number;
    epoch: number;
    messages: readonly LLMChatMessage[];
    afterMessageIndex: number;
    occurredAt?: string;
  }): number;
  deriveMessages(sessionId: string): LLMChatMessage[];
  projectMessages(sessionId: string): GoalAgentMessageProjection;
  messageCount(sessionId: string): number;
  recordCompaction(input: GoalAgentCompactionCheckpointInput): GoalAgentSessionEventV1 | null;
  listSessionEvents(sessionId: string): GoalAgentSessionEventV1[];
}

export class InMemoryGoalAgentSessionEventLog implements GoalAgentSessionEventLogPort {
  private readonly events = new Map<string, GoalAgentSessionEventV1[]>();

  appendSessionEvent(input: GoalAgentSessionEventInput): GoalAgentSessionEventV1 {
    const list = this.events.get(input.sessionId) ?? [];
    const eventId = input.eventId?.trim() || randomUUID();
    const existing = list.find(event => event.eventId === eventId);
    if (existing) return structuredClone(existing);
    const event: GoalAgentSessionEventV1 = {
      schema: GOAL_AGENT_SESSION_EVENT_SCHEMA_V1,
      eventId,
      sessionId: input.sessionId,
      seq: list.length + 1,
      occurredAt: input.occurredAt,
      type: input.type,
      node: input.node,
      stateRevision: input.stateRevision,
      epoch: input.epoch,
      payload: structuredClone(input.payload),
    };
    list.push(event);
    this.events.set(input.sessionId, list);
    return structuredClone(event);
  }

  appendMessage(input: GoalAgentMessageAppendInput): GoalAgentSessionEventV1 {
    const messageIndex = input.messageIndex ?? this.messageCount(input.sessionId);
    const appended = this.appendSessionEvent({
      eventId: messageEventId(input.sessionId, messageIndex),
      sessionId: input.sessionId,
      occurredAt: input.occurredAt ?? new Date().toISOString(),
      type: 'message.appended',
      node: input.node,
      stateRevision: input.stateRevision,
      epoch: input.epoch,
      payload: { message: structuredClone(input.message), messageIndex },
    });
    for (const call of input.message.tool_calls ?? []) {
      this.appendSessionEvent({
        eventId: `${input.sessionId}:tool-call:${call.id}`,
        sessionId: input.sessionId,
        occurredAt: input.occurredAt ?? new Date().toISOString(),
        type: 'tool.called',
        node: input.node,
        stateRevision: input.stateRevision,
        epoch: input.epoch,
        payload: {
          callId: call.id,
          name: call.function.name,
          arguments: call.function.arguments,
        },
      });
    }
    if (input.message.role === 'tool' && input.message.tool_call_id) {
      this.appendSessionEvent({
        eventId: `${input.sessionId}:tool-result:${input.message.tool_call_id}`,
        sessionId: input.sessionId,
        occurredAt: input.occurredAt ?? new Date().toISOString(),
        type: 'tool.result',
        node: input.node,
        stateRevision: input.stateRevision,
        epoch: input.epoch,
        payload: { callId: input.message.tool_call_id, content: input.message.content },
      });
    }
    return appended;
  }

  syncMessages(input: Parameters<GoalAgentSessionEventLogPort['syncMessages']>[0]): number {
    let index = Math.max(0, input.afterMessageIndex);
    for (const message of input.messages.slice(index)) {
      this.appendMessage({ ...input, message, messageIndex: index });
      index += 1;
    }
    return this.messageCount(input.sessionId);
  }

  deriveMessages(sessionId: string): LLMChatMessage[] {
    return deriveGoalAgentMessages(this.listSessionEvents(sessionId));
  }

  projectMessages(sessionId: string): GoalAgentMessageProjection {
    return projectGoalAgentMessages(this.listSessionEvents(sessionId));
  }

  messageCount(sessionId: string): number {
    return this.listSessionEvents(sessionId).filter(event => event.type === 'message.appended').length;
  }

  recordCompaction(input: GoalAgentCompactionCheckpointInput): GoalAgentSessionEventV1 | null {
    assertGoalAgentCompactionCheckpointV2(input, this.messageCount(input.sessionId), this.listSessionEvents(input.sessionId).at(-1)?.seq ?? 0);
    const latest = [...this.listSessionEvents(input.sessionId)].reverse()
      .find(event => event.type === 'compaction.checkpoint');
    if (latest?.payload.schema === input.schema
      && latest.payload.sourceDigest === input.sourceDigest
      && latest.payload.throughMessageIndex === input.throughMessageIndex) return null;
    if (!Number.isInteger(input.throughMessageIndex) || input.throughMessageIndex < 1
      || input.throughMessageIndex > this.messageCount(input.sessionId)) {
      throw new Error('GoalAgent compaction boundary must reference committed raw messages');
    }
    return this.appendSessionEvent({
      sessionId: input.sessionId,
      occurredAt: input.occurredAt ?? new Date().toISOString(),
      type: 'compaction.checkpoint',
      node: input.node,
      stateRevision: input.stateRevision,
      epoch: input.epoch,
      payload: {
        schema: input.schema,
        summary: structuredClone(input.summary),
        omittedMessages: input.omittedMessages,
        throughMessageIndex: input.throughMessageIndex,
        coveredEventSeq: structuredClone(input.coveredEventSeq),
        profileRef: input.profileRef,
        policyRevision: input.policyRevision,
        tokensBefore: input.tokensBefore,
        tokensAfter: input.tokensAfter,
        sourceDigest: input.sourceDigest,
        rawMessagesRetained: this.messageCount(input.sessionId),
      },
    });
  }

  listSessionEvents(sessionId: string): GoalAgentSessionEventV1[] {
    return structuredClone(this.events.get(sessionId) ?? []);
  }
}

export function deriveGoalAgentMessages(events: readonly GoalAgentSessionEventV1[]): LLMChatMessage[] {
  return events
    .filter(event => event.type === 'message.appended')
    .sort((left, right) => left.seq - right.seq)
    .map(event => structuredClone(event.payload.message as LLMChatMessage));
}

/** Applies the latest compaction checkpoint without deleting any raw event. */
export function projectGoalAgentMessages(events: readonly GoalAgentSessionEventV1[]): GoalAgentMessageProjection {
  const messageEvents = events
    .filter(event => event.type === 'message.appended')
    .sort((left, right) => left.seq - right.seq);
  const messages = messageEvents.map(event => structuredClone(event.payload.message as LLMChatMessage));
  const checkpoint = [...events]
    .filter(event => event.type === 'compaction.checkpoint')
    .sort((left, right) => right.seq - left.seq)[0];
  const through = checkpoint && Number.isInteger(checkpoint.payload.throughMessageIndex)
    ? Math.min(messages.length, Math.max(0, Number(checkpoint.payload.throughMessageIndex)))
    : 0;
  const isV2 = checkpoint?.payload.schema === GOAL_AGENT_COMPACTION_SCHEMA_V2
    && checkpoint.payload.summary && typeof checkpoint.payload.summary === 'object';
  const summary = isV2
    ? renderGoalAgentCompactionSummary(checkpoint.payload.summary as never)
    : checkpoint && typeof checkpoint.payload.summary === 'string' ? checkpoint.payload.summary : undefined;
  const coveredEventSeq = isV2 && isEventRange(checkpoint.payload.coveredEventSeq)
    ? structuredClone(checkpoint.payload.coveredEventSeq) : undefined;
  return {
    messages: messages.slice(through).map(message => structuredClone(message)),
    messageRefs: messageEvents.slice(through).map((event, offset) => ({ messageIndex: through + offset, eventSeq: event.seq })),
    ...(summary && through > 0 ? { compactionSummary: summary } : {}),
    ...(summary && through > 0 ? { compaction: {
      schema: isV2 ? GOAL_AGENT_COMPACTION_SCHEMA_V2 : 'mineclaw.goalagent-compaction/v1',
      summarySurface: summary,
      throughMessageIndex: through,
      ...(coveredEventSeq ? { coveredEventSeq } : {}),
    } } : {}),
    compactedThroughMessageIndex: through,
    rawMessageCount: messages.length,
  };
}

export function assertGoalAgentCompactionCheckpointV2(
  input: GoalAgentCompactionCheckpointInput,
  rawMessageCount: number,
  lastEventSeq: number,
): void {
  if (input.schema !== GOAL_AGENT_COMPACTION_SCHEMA_V2) throw new Error('GoalAgent only writes Compaction V2 checkpoints');
  if (!input.profileRef.trim() || !input.policyRevision.trim() || !input.sourceDigest.trim()) {
    throw new Error('GoalAgent Compaction V2 requires profile, policy and source digest');
  }
  if (!input.summary || typeof input.summary !== 'object') throw new Error('GoalAgent Compaction V2 requires structured summary');
  if (!Number.isInteger(input.throughMessageIndex) || input.throughMessageIndex < 1 || input.throughMessageIndex > rawMessageCount) {
    throw new Error('GoalAgent compaction boundary must reference committed raw messages');
  }
  if (!Number.isInteger(input.coveredEventSeq.from) || !Number.isInteger(input.coveredEventSeq.through)
    || input.coveredEventSeq.from < 1 || input.coveredEventSeq.from > input.coveredEventSeq.through
    || input.coveredEventSeq.through > lastEventSeq) {
    throw new Error('GoalAgent Compaction V2 event range must reference committed events');
  }
  if (![input.tokensBefore, input.tokensAfter].every(value => Number.isSafeInteger(value) && value >= 0)
    || input.tokensAfter > input.tokensBefore) {
    throw new Error('GoalAgent Compaction V2 token counts are invalid');
  }
}

function isEventRange(value: unknown): value is { from: number; through: number } {
  if (!value || typeof value !== 'object') return false;
  const range = value as Record<string, unknown>;
  return Number.isInteger(range.from) && Number.isInteger(range.through);
}

export function latestGoalAgentCheckpoint(
  events: readonly GoalAgentSessionEventV1[],
): GoalAgentStateV1 | null {
  const checkpoint = [...events].reverse().find(event => event.type === 'state.checkpoint');
  return checkpoint ? structuredClone(checkpoint.payload.state as GoalAgentStateV1) : null;
}

export function messageEventId(sessionId: string, messageIndex: number): string {
  return `${sessionId}:message:${messageIndex}`;
}
