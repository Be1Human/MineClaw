import type { ChatMemoryService, FactKind, MemoryFact } from '../infra/chatMemory.js';
import {
  getMemorySlotDefinition,
  routeDeterministicMemorySlot,
  type MemorySlotValue,
} from './profileSlots/index.js';
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
    const slots = this.chatMemory.searchActiveMemorySlots(input.query, input.limit).map(slotRecord);
    const slotKeys = new Set(slots.map(record => String(record.metadata.slotKey)));
    const facts = this.chatMemory.getFacts({ status: 'active' })
      .filter(fact => {
        const route = routeDeterministicMemorySlot(fact.text);
        return !route || !slotKeys.has(route.slotKey);
      })
      .map(factRecord);
    if (input.mode === 'planning') return [...slots, ...facts];
    const messages = input.query
      ? this.chatMemory.searchMessagesMultiHop(input.query, Math.min(input.limit, input.mode === 'deep' ? 24 : 10))
      : [];
    return [
      ...slots,
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

function slotRecord(value: MemorySlotValue): MemoryRecord {
  const definition = getMemorySlotDefinition(value.slotKey);
  const title = definition?.title ?? value.slotKey;
  return {
    id: canonicalMemoryId(value.profileId, 'chat-memory', `slot:${value.id}`),
    profileId: value.profileId,
    kind: slotKind(value.slotKey),
    status: 'active',
    summary: `${title}：${formatValue(value.value)}`,
    occurredAt: value.createdAt,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    importance: value.importance,
    confidence: value.confidence,
    entities: [],
    locationRefs: [],
    sourceRefs: [{ store: 'chat-memory', id: `slot:${value.id}` }],
    evidenceRefs: value.sourceMessageIds.map(id => `chat-memory:message:${id}`),
    metadata: { authorityType: 'official_slot', slotKey: value.slotKey, catalogVersion: value.catalogVersion, live: true },
  };
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
    metadata: { authorityType: 'dynamic_memory_fact', scope: fact.scope, live: true },
  };
}

function slotKind(slotKey: string): MemoryKind {
  if (slotKey.startsWith('identity.')) return 'identity';
  if (slotKey.startsWith('boundary.') || slotKey.startsWith('care.')) return 'boundary';
  if (slotKey.startsWith('goal.') || slotKey.startsWith('commitment.') || slotKey.startsWith('reminder.')) return 'commitment';
  return 'preference';
}

function formatValue(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function factKind(kind: FactKind): MemoryKind {
  if (kind === 'project') return 'commitment';
  if (['preference', 'identity', 'commitment', 'boundary'].includes(kind)) return kind as MemoryKind;
  return 'event';
}
