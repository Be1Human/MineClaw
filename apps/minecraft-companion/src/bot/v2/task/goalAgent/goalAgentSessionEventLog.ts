import { randomUUID } from 'node:crypto';
import type { LLMChatMessage } from '../../cognitive/llm/types.js';
import type { GoalAgentEventSource, GoalAgentStateV1 } from './goalAgentState.js';

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

export interface GoalAgentCompactionCheckpointInput {
  sessionId: string;
  node: GoalAgentEventSource;
  stateRevision: number;
  epoch: number;
  summary: string;
  omittedMessages: number;
  /** Exclusive raw message index replaced by this summary. */
  throughMessageIndex: number;
  occurredAt?: string;
}

export interface GoalAgentMessageProjection {
  /** Raw committed messages after the latest compaction boundary. */
  messages: LLMChatMessage[];
  compactionSummary?: string;
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
    const latest = [...this.listSessionEvents(input.sessionId)].reverse()
      .find(event => event.type === 'compaction.checkpoint');
    if (latest?.payload.summary === input.summary
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
        summary: input.summary,
        omittedMessages: input.omittedMessages,
        throughMessageIndex: input.throughMessageIndex,
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
  const messages = deriveGoalAgentMessages(events);
  const checkpoint = [...events]
    .filter(event => event.type === 'compaction.checkpoint')
    .sort((left, right) => right.seq - left.seq)[0];
  const through = checkpoint && Number.isInteger(checkpoint.payload.throughMessageIndex)
    ? Math.min(messages.length, Math.max(0, Number(checkpoint.payload.throughMessageIndex)))
    : 0;
  const summary = checkpoint && typeof checkpoint.payload.summary === 'string'
    ? checkpoint.payload.summary
    : undefined;
  return {
    messages: messages.slice(through).map(message => structuredClone(message)),
    ...(summary && through > 0 ? { compactionSummary: summary } : {}),
    compactedThroughMessageIndex: through,
    rawMessageCount: messages.length,
  };
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
