import type { ChatMemoryService, FactKind, MemoryFact } from '../infra/chatMemory.js';
import { canonicalMemoryId } from './adapters.js';
import type { MemoryKind, MemoryRecord } from './contracts.js';

export interface MemoryRecallProvider {
  readonly id: string;
  recall(input: { profileId: string; query: string; mode: 'auto' | 'deep' | 'planning'; limit: number }): MemoryRecord[];
}

/** Query-aware bridge for records written after the last catalog backfill. */
export class ChatMemoryRecallProvider implements MemoryRecallProvider {
  readonly id = 'chat-memory-live';

  constructor(
    private readonly profileId: string,
    private readonly chatMemory: ChatMemoryService,
  ) {}

  recall(input: { profileId: string; query: string; mode: 'auto' | 'deep' | 'planning'; limit: number }): MemoryRecord[] {
    if (input.profileId !== this.profileId) throw new Error('[ChatMemoryRecallProvider] profile mismatch');
    const facts = this.chatMemory.getFacts({ status: 'active' }).map(factRecord);
    if (input.mode === 'planning') return facts;
    const messages = input.query
      ? this.chatMemory.searchMessagesMultiHop(input.query, Math.min(input.limit, input.mode === 'deep' ? 24 : 10))
      : [];
    return [
      ...facts,
      ...messages.filter(message => message.role === 'owner').map(message => ({
        id: canonicalMemoryId(input.profileId, 'chat-memory', `message:${message.id}`),
        profileId: input.profileId,
        kind: 'conversation' as const,
        status: 'active' as const,
        summary: message.content.trim().slice(0, 500),
        occurredAt: message.timestamp,
        createdAt: message.timestamp,
        updatedAt: message.timestamp,
        importance: 0.6,
        confidence: 1,
        entities: [],
        locationRefs: [],
        sourceRefs: [{ store: 'chat-memory', id: `message:${message.id}` }],
        evidenceRefs: [],
        metadata: { authorityType: 'chat_message', role: message.role, live: true },
      })),
    ];
  }
}

function factRecord(fact: MemoryFact): MemoryRecord {
  const kind = factKind(fact.kind);
  return {
    id: canonicalMemoryId(fact.profileId, 'chat-memory', `fact:${fact.id}`),
    profileId: fact.profileId,
    kind,
    status: 'active',
    summary: fact.text,
    occurredAt: fact.createdAt,
    createdAt: fact.createdAt,
    updatedAt: fact.updatedAt,
    importance: fact.importance,
    confidence: fact.confidence,
    entities: [],
    locationRefs: [],
    sourceRefs: [{ store: 'chat-memory', id: `fact:${fact.id}` }],
    evidenceRefs: fact.sourceMessageIds.map(id => `chat-memory:message:${id}`),
    metadata: { authorityType: 'memory_fact', scope: fact.scope, live: true },
  };
}

function factKind(kind: FactKind): MemoryKind {
  if (kind === 'project') return 'commitment';
  if (['preference', 'identity', 'commitment', 'boundary'].includes(kind)) return kind as MemoryKind;
  return 'event';
}
