import type {
  LlmTraceAgent,
  LlmTraceEventType,
  LlmTraceEventV1,
  LlmTraceJsonValue,
} from './types.js';
import { LlmTraceEventStore } from './llmTraceEventStore.js';

const MAX_SESSION_LIMIT = 100;
const MAX_EVENT_LIMIT = 500;
const DEFAULT_EXPORT_BYTES = 10 * 1024 * 1024;

export type LlmTraceCacheMetricStatus = 'reported' | 'unsupported' | 'unavailable' | 'bypass';

export interface LlmTraceUsageProjection {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  cacheMissInputTokens?: number;
  cacheEligibleInputTokens?: number;
  cacheStatus: LlmTraceCacheMetricStatus;
  source: string;
}

export interface LlmTraceCallCacheProjection {
  cacheStatus: LlmTraceCacheMetricStatus;
  cacheHitRate: number | null;
  usage: LlmTraceUsageProjection;
}

export interface LlmTraceCacheBreakdown {
  cacheStatus: LlmTraceCacheMetricStatus;
  cacheHitRate: number | null;
  cachedInputTokens: number;
  cacheMissInputTokens: number;
  cacheEligibleInputTokens: number;
  reportedCalls: number;
  totalCalls: number;
  unsupportedCalls: number;
  unavailableCalls: number;
  bypassCalls: number;
}

export interface LlmTraceCacheAggregate extends LlmTraceCacheBreakdown {
  unattributedCalls: number;
  byAgent: Partial<Record<LlmTraceAgent, LlmTraceCacheBreakdown>>;
}

export interface LlmTraceTurnSummary {
  key: string;
  turnId: string;
  interactionSessionId: string;
  turn: number;
  title: string;
  startedAt: string;
  updatedAt: string;
  eventCount: number;
  callCount: number;
  agents: LlmTraceAgent[];
  cache: LlmTraceCacheAggregate;
}

export interface LlmTraceSessionSummary {
  sessionId: string;
  conversationSessionId: string;
  interactionSessionId?: string;
  goalSessionId?: string;
  taskId?: string;
  title: string;
  status: 'active' | 'in_flight' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  firstSeq: number;
  lastSeq: number;
  startedAt: string;
  updatedAt: string;
  eventCount: number;
  turnCount: number;
  callCount: number;
  agents: LlmTraceAgent[];
  nodes: string[];
  cache: LlmTraceCacheAggregate;
  turns: LlmTraceTurnSummary[];
}

export interface LlmTraceSessionPage {
  sessions: LlmTraceSessionSummary[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface LlmTraceEventSummary {
  eventId: string;
  seq: number;
  occurredAt: string;
  type: LlmTraceEventType;
  callId?: string;
  parentCallId?: string;
  correlationId?: string;
  conversationSessionId: string;
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
  payloadTruncated: boolean;
  cache?: LlmTraceCallCacheProjection;
  turnCache?: LlmTraceCacheAggregate;
}

export interface LlmTraceEventSummaryPage {
  events: LlmTraceEventSummary[];
  hasMore: boolean;
  latestSeq: number;
  cache?: LlmTraceCacheAggregate;
  turns?: LlmTraceTurnSummary[];
}

export interface LlmTraceCallDetail {
  callId: string;
  status: 'in_flight' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
  requestEvent: LlmTraceEventV1;
  terminalEvent: LlmTraceEventV1 | null;
  events: LlmTraceEventV1[];
  request: Record<string, unknown>;
  response: Record<string, unknown> | null;
  context: Record<string, unknown>;
  tools: unknown[];
  usage: LlmTraceUsageProjection;
  cacheStatus: LlmTraceCacheMetricStatus;
  cacheHitRate: number | null;
  timing: {
    requestedAt: string;
    finishedAt: string | null;
    durationMs: number | null;
  };
}

export class LlmTraceQueryError extends Error {
  constructor(
    readonly code: 'invalid_query' | 'not_found' | 'export_too_large',
    message: string,
  ) {
    super(message);
    this.name = 'LlmTraceQueryError';
  }
}

export class LlmTraceQueryService {
  constructor(
    private readonly store: LlmTraceEventStore,
    private readonly maxExportBytes = DEFAULT_EXPORT_BYTES,
  ) {}

  listSessions(input: {
    cursor?: string;
    limit?: number;
    taskId?: string;
    q?: string;
  } = {}): LlmTraceSessionPage {
    const limit = boundedLimit(input.limit, 50, MAX_SESSION_LIMIT, 'limit');
    const beforeSeq = input.cursor ? decodeCursor(input.cursor) : Number.POSITIVE_INFINITY;
    const query = input.q?.trim().toLocaleLowerCase();
    const grouped = new Map<string, LlmTraceEventV1[]>();
    for (const event of this.readAllEvents()) {
      if (input.taskId && event.taskId !== input.taskId) continue;
      // 一个 Profile 对应玩家与该角色的持续对话；turn / goal session 都只是其下级运行边界。
      // Query Service 本身由 Profile 隔离的 Store 驱动，因此该键跨进程重启仍然稳定。
      const sessionId = conversationSessionId(event);
      const events = grouped.get(sessionId) ?? [];
      events.push(event);
      grouped.set(sessionId, events);
    }
    const summaries = [...grouped.entries()]
      .map(([sessionId, events]) => sessionSummary(sessionId, events))
      .filter(session => session.lastSeq < beforeSeq)
      .filter(session => !query || sessionSearchText(session).includes(query))
      .sort((left, right) => right.lastSeq - left.lastSeq);
    const page = summaries.slice(0, limit);
    return {
      sessions: page,
      hasMore: summaries.length > limit,
      nextCursor: summaries.length > limit && page.length > 0
        ? encodeCursor(page.at(-1)!.lastSeq)
        : null,
    };
  }

  listEvents(input: {
    sessionId?: string;
    interactionSessionId?: string;
    afterSeq?: number;
    beforeSeq?: number;
    limit?: number;
    taskId?: string;
    agent?: LlmTraceAgent;
    node?: string;
    status?: string;
    q?: string;
  } = {}): LlmTraceEventSummaryPage {
    const limit = boundedLimit(input.limit, 200, MAX_EVENT_LIMIT, 'limit');
    optionalSeq(input.afterSeq, 'afterSeq');
    optionalSeq(input.beforeSeq, 'beforeSeq');
    const query = input.q?.trim().toLocaleLowerCase();
    const allEvents = this.readAllEvents();
    const projections = cacheProjections(allEvents);
    const sessionProjections = input.sessionId
      ? cacheProjections(allEvents.filter(event => eventMatchesSession(event, input.sessionId!)))
      : null;
    const matching = allEvents.filter(event => {
      if (input.sessionId && !eventMatchesSession(event, input.sessionId)) return false;
      if (input.interactionSessionId && event.interactionSessionId !== input.interactionSessionId) return false;
      if (input.afterSeq !== undefined && event.seq <= input.afterSeq) return false;
      if (input.beforeSeq !== undefined && event.seq >= input.beforeSeq) return false;
      if (input.taskId && event.taskId !== input.taskId) return false;
      if (input.agent && event.agent !== input.agent) return false;
      if (input.node && event.node !== input.node) return false;
      if (input.status && eventStatus(event) !== input.status) return false;
      if (query && !eventSearchText(event).includes(query)) return false;
      return true;
    });
    // 首次读取和 beforeSeq 都返回“最靠近边界”的最近一页；afterSeq 则正向追尾。
    // 这样 UI 无需把整个历史挂进 DOM，也能从最新事件向前分页。
    const page = input.afterSeq !== undefined
      ? matching.slice(0, limit)
      : matching.slice(Math.max(0, matching.length - limit));
    return {
      events: page.map(event => summarizeEvent(event, projections)),
      hasMore: matching.length > limit,
      latestSeq: matching.at(-1)?.seq ?? input.afterSeq ?? 0,
      ...(sessionProjections ? { cache: sessionProjections.session, turns: sessionProjections.turns } : {}),
    };
  }

  getCall(callId: string): LlmTraceCallDetail | null {
    const normalized = callId.trim();
    if (!normalized) throw new LlmTraceQueryError('invalid_query', 'callId is required');
    const events = this.store.listEvents({ callId: normalized, limit: 1_000 }).events;
    const requestEvent = events.find(event => event.type === 'llm.request.recorded');
    if (!requestEvent) return null;
    const terminalEvent = events.find(event => [
      'llm.response.recorded',
      'llm.call.failed',
      'llm.call.cancelled',
      'trace.persistence_gap',
    ].includes(event.type)) ?? null;
    const request = objectValue(requestEvent.payload.request);
    const response = terminalEvent ? objectValue(terminalEvent.payload) : null;
    const cache = callCacheProjection(terminalEvent);
    return {
      callId: normalized,
      status: callStatus(terminalEvent),
      requestEvent,
      terminalEvent,
      events,
      request,
      response,
      context: objectValue(request.context),
      tools: Array.isArray(request.tools) ? request.tools : [],
      usage: cache.usage,
      cacheStatus: cache.cacheStatus,
      cacheHitRate: cache.cacheHitRate,
      timing: {
        requestedAt: requestEvent.occurredAt,
        finishedAt: terminalEvent?.occurredAt ?? null,
        durationMs: typeof terminalEvent?.payload.durationMs === 'number'
          ? terminalEvent.payload.durationMs
          : terminalEvent
            ? Math.max(0, Date.parse(terminalEvent.occurredAt) - Date.parse(requestEvent.occurredAt))
            : null,
      },
    };
  }

  exportSession(sessionId: string): string {
    const normalized = sessionId.trim();
    if (!normalized) throw new LlmTraceQueryError('invalid_query', 'sessionId is required');
    const events = this.readAllEvents().filter(event => eventMatchesSession(event, normalized));
    if (events.length === 0) throw new LlmTraceQueryError('not_found', 'trace session not found');
    const jsonl = `${events.map(event => JSON.stringify(event)).join('\n')}\n`;
    if (Buffer.byteLength(jsonl, 'utf8') > this.maxExportBytes) {
      throw new LlmTraceQueryError('export_too_large', 'trace export exceeds size limit');
    }
    return jsonl;
  }

  private readAllEvents(): LlmTraceEventV1[] {
    const events: LlmTraceEventV1[] = [];
    let afterSeq = 0;
    for (;;) {
      const page = this.store.listEvents({ afterSeq, limit: 1_000 });
      events.push(...page.events);
      if (!page.hasMore || page.events.length === 0) return events;
      afterSeq = page.events.at(-1)!.seq;
    }
  }
}

function sessionSummary(sessionId: string, events: LlmTraceEventV1[]): LlmTraceSessionSummary {
  const first = events[0]!;
  const last = events.at(-1)!;
  const requestCount = events.filter(event => event.type === 'llm.request.recorded').length;
  const terminalCallCount = events.filter(event => [
    'llm.response.recorded', 'llm.call.failed', 'llm.call.cancelled', 'trace.persistence_gap',
  ].includes(event.type)).length;
  const projections = cacheProjections(events);
  return {
    sessionId,
    conversationSessionId: sessionId,
    interactionSessionId: events.find(event => event.interactionSessionId)?.interactionSessionId,
    goalSessionId: events.find(event => event.goalSessionId)?.goalSessionId,
    taskId: events.find(event => event.taskId)?.taskId,
    title: '持续对话',
    status: requestCount > terminalCallCount ? 'in_flight' : 'active',
    firstSeq: first.seq,
    lastSeq: last.seq,
    startedAt: first.occurredAt,
    updatedAt: last.occurredAt,
    eventCount: events.length,
    turnCount: projections.turns.length,
    callCount: new Set(events.flatMap(event => event.callId ? [event.callId] : [])).size,
    agents: [...new Set(events.map(event => event.agent))],
    nodes: [...new Set(events.flatMap(event => event.node ? [event.node] : []))],
    cache: projections.session,
    turns: projections.turns,
  };
}

function turnTitle(events: LlmTraceEventV1[]): string {
  const interaction = events.find(event => event.type === 'interaction.received');
  if (typeof interaction?.payload.message === 'string' && interaction.payload.message.trim()) {
    return interaction.payload.message.trim().slice(0, 160);
  }
  const requestEvent = events.find(event => event.type === 'llm.request.recorded');
  const request = objectValue(requestEvent?.payload.request);
  const messages = Array.isArray(request.messages) ? request.messages : [];
  const user = [...messages].reverse().find(message => objectValue(message).role === 'user');
  const content = objectValue(user).content;
  return typeof content === 'string' && content.trim()
    ? content.trim().slice(0, 160)
    : '内部续接回合';
}

function summarizeEvent(event: LlmTraceEventV1, projections: CacheProjections): LlmTraceEventSummary {
  let payload = event.payload;
  let payloadTruncated = false;
  if (event.type === 'llm.request.recorded') {
    const request = objectValue(event.payload.request);
    payload = {
      model: typeof request.model === 'string' ? request.model : 'unknown',
      provider: typeof request.provider === 'string' ? request.provider : 'unknown',
      messageCount: Array.isArray(request.messages) ? request.messages.length : 0,
      toolCount: Array.isArray(request.tools) ? request.tools.length : 0,
      inputHash: typeof event.payload.inputHash === 'string' ? event.payload.inputHash : '',
    };
    payloadTruncated = true;
  } else if (JSON.stringify(payload).length > 4_000) {
    payload = { preview: JSON.stringify(payload).slice(0, 2_000), originalBytes: JSON.stringify(payload).length };
    payloadTruncated = true;
  }
  const cache = event.callId ? projections.calls.get(event.callId) : undefined;
  const turnKey = resolvedTurnKey(event, projections.turnByInteraction);
  return {
    eventId: event.eventId,
    seq: event.seq,
    occurredAt: event.occurredAt,
    type: event.type,
    callId: event.callId,
    parentCallId: event.parentCallId,
    correlationId: event.correlationId,
    conversationSessionId: conversationSessionId(event),
    interactionSessionId: event.interactionSessionId,
    goalSessionId: event.goalSessionId,
    taskId: event.taskId,
    agent: event.agent,
    node: event.node,
    turn: event.turn,
    modelCallIndex: event.modelCallIndex,
    stateRevision: event.stateRevision,
    epoch: event.epoch,
    payload,
    payloadTruncated,
    ...(cache ? { cache } : {}),
    ...(event.type === 'interaction.received' && turnKey
      ? { turnCache: projections.turnsByKey.get(turnKey)?.cache }
      : {}),
  };
}

interface ProjectedCall {
  request: LlmTraceEventV1;
  terminal: LlmTraceEventV1 | null;
  cache: LlmTraceCallCacheProjection;
  turnKey: string | null;
}

interface CacheProjections {
  calls: Map<string, LlmTraceCallCacheProjection>;
  session: LlmTraceCacheAggregate;
  turns: LlmTraceTurnSummary[];
  turnsByKey: Map<string, LlmTraceTurnSummary>;
  turnByInteraction: Map<string, number>;
}

function cacheProjections(events: LlmTraceEventV1[]): CacheProjections {
  const turnByInteraction = new Map<string, number>();
  for (const event of events) {
    if (event.interactionSessionId && Number.isSafeInteger(event.turn) && event.turn! >= 0) {
      turnByInteraction.set(event.interactionSessionId, event.turn!);
    }
  }

  const terminalByCall = new Map<string, LlmTraceEventV1>();
  for (const event of events) {
    if (event.callId && isCallTerminal(event)) terminalByCall.set(event.callId, event);
  }
  const projectedCalls: ProjectedCall[] = [];
  const calls = new Map<string, LlmTraceCallCacheProjection>();
  for (const request of events) {
    if (request.type !== 'llm.request.recorded' || !request.callId) continue;
    const terminal = terminalByCall.get(request.callId) ?? null;
    const cache = callCacheProjection(terminal);
    calls.set(request.callId, cache);
    projectedCalls.push({
      request,
      terminal,
      cache,
      turnKey: resolvedTurnKey(request, turnByInteraction),
    });
  }

  const grouped = new Map<string, ProjectedCall[]>();
  for (const call of projectedCalls) {
    if (!call.turnKey) continue;
    const group = grouped.get(call.turnKey) ?? [];
    group.push(call);
    grouped.set(call.turnKey, group);
  }
  const eventsByTurn = new Map<string, LlmTraceEventV1[]>();
  for (const event of events) {
    const key = resolvedTurnKey(event, turnByInteraction);
    if (!key) continue;
    const values = eventsByTurn.get(key) ?? [];
    values.push(event);
    eventsByTurn.set(key, values);
  }
  const turnKeys = new Set([...grouped.keys(), ...eventsByTurn.keys()]);
  const turns = [...turnKeys].map(key => {
    const turnCalls = grouped.get(key) ?? [];
    const [interactionSessionId, turnText] = splitTurnKey(key);
    const turnEvents = eventsByTurn.get(key)
      ?? turnCalls.flatMap(call => call.terminal ? [call.request, call.terminal] : [call.request]);
    const firstEvent = turnEvents[0]!;
    return {
      key,
      turnId: interactionSessionId,
      interactionSessionId,
      turn: Number(turnText),
      title: turnTitle(turnEvents),
      startedAt: turnEvents.reduce((value, event) => value < event.occurredAt ? value : event.occurredAt, firstEvent.occurredAt),
      updatedAt: turnEvents.reduce((value, event) => value > event.occurredAt ? value : event.occurredAt, firstEvent.occurredAt),
      eventCount: turnEvents.length,
      callCount: turnCalls.length,
      agents: [...new Set(turnEvents.map(event => event.agent))],
      cache: aggregateCache(turnCalls, 0),
    } satisfies LlmTraceTurnSummary;
  }).sort((left, right) => left.startedAt.localeCompare(right.startedAt));
  const turnsByKey = new Map(turns.map(turn => [turn.key, turn]));
  return {
    calls,
    session: aggregateCache(projectedCalls, projectedCalls.filter(call => !call.turnKey).length),
    turns,
    turnsByKey,
    turnByInteraction,
  };
}

function callCacheProjection(terminal: LlmTraceEventV1 | null): LlmTraceCallCacheProjection {
  const usage = terminal?.type === 'llm.response.recorded'
    ? usageProjection(terminal.payload.usage)
    : terminal
      ? unavailableTraceUsage(`call_${terminal.type}`)
      : unavailableTraceUsage('call_in_flight');
  const eligible = usage.cacheEligibleInputTokens;
  return {
    cacheStatus: usage.cacheStatus,
    cacheHitRate: usage.cacheStatus === 'reported' && eligible !== undefined && eligible > 0
      ? usage.cachedInputTokens! / eligible
      : null,
    usage,
  };
}

function usageProjection(value: unknown): LlmTraceUsageProjection {
  const usage = objectValue(value);
  const status = usage.cacheStatus;
  const source = typeof usage.source === 'string' && usage.source ? usage.source : 'trace_usage_missing_source';
  if (!isCacheMetricStatus(status)) return unsupportedTraceUsage('usage_not_recorded');

  const numericFields = [
    'inputTokens', 'outputTokens', 'totalTokens', 'cachedInputTokens',
    'cacheMissInputTokens', 'cacheEligibleInputTokens',
  ] as const;
  const projected: LlmTraceUsageProjection = { cacheStatus: status, source };
  for (const field of numericFields) {
    const fieldValue = usage[field];
    if (fieldValue === undefined) continue;
    if (!Number.isSafeInteger(fieldValue) || fieldValue < 0) return unavailableTraceUsage('invalid_trace_usage');
    projected[field] = fieldValue;
  }
  if (status === 'reported') {
    if (projected.cachedInputTokens === undefined
      || projected.cacheEligibleInputTokens === undefined
      || projected.cachedInputTokens > projected.cacheEligibleInputTokens) {
      return unavailableTraceUsage('invalid_trace_cache_tokens');
    }
    if (projected.cacheMissInputTokens !== undefined
      && projected.cachedInputTokens + projected.cacheMissInputTokens !== projected.cacheEligibleInputTokens) {
      return unavailableTraceUsage('inconsistent_trace_cache_tokens');
    }
  }
  return projected;
}

function aggregateCache(calls: ProjectedCall[], unattributedCalls: number): LlmTraceCacheAggregate {
  const byAgentCalls = new Map<LlmTraceAgent, ProjectedCall[]>();
  for (const call of calls) {
    const values = byAgentCalls.get(call.request.agent) ?? [];
    values.push(call);
    byAgentCalls.set(call.request.agent, values);
  }
  return {
    ...cacheBreakdown(calls),
    unattributedCalls,
    byAgent: Object.fromEntries([...byAgentCalls.entries()].map(([agent, values]) => [agent, cacheBreakdown(values)])),
  };
}

function cacheBreakdown(calls: ProjectedCall[]): LlmTraceCacheBreakdown {
  const reported = calls.filter(call => call.cache.cacheStatus === 'reported');
  const cachedInputTokens = sumUsage(reported, 'cachedInputTokens');
  const cacheEligibleInputTokens = sumUsage(reported, 'cacheEligibleInputTokens');
  return {
    cacheStatus: aggregateStatus(calls),
    cacheHitRate: cacheEligibleInputTokens > 0 ? cachedInputTokens / cacheEligibleInputTokens : null,
    cachedInputTokens,
    cacheMissInputTokens: sumUsage(reported, 'cacheMissInputTokens'),
    cacheEligibleInputTokens,
    reportedCalls: reported.length,
    totalCalls: calls.length,
    unsupportedCalls: calls.filter(call => call.cache.cacheStatus === 'unsupported').length,
    unavailableCalls: calls.filter(call => call.cache.cacheStatus === 'unavailable').length,
    bypassCalls: calls.filter(call => call.cache.cacheStatus === 'bypass').length,
  };
}

function aggregateStatus(calls: ProjectedCall[]): LlmTraceCacheMetricStatus {
  if (calls.some(call => call.cache.cacheStatus === 'reported')) return 'reported';
  if (calls.some(call => call.cache.cacheStatus === 'unavailable')) return 'unavailable';
  if (calls.some(call => call.cache.cacheStatus === 'bypass')) return 'bypass';
  return 'unsupported';
}

function sumUsage(
  calls: ProjectedCall[],
  field: 'cachedInputTokens' | 'cacheMissInputTokens' | 'cacheEligibleInputTokens',
): number {
  return calls.reduce((sum, call) => sum + (call.cache.usage[field] ?? 0), 0);
}

function resolvedTurnKey(event: LlmTraceEventV1, turnByInteraction: Map<string, number>): string | null {
  if (!event.interactionSessionId) return null;
  const turn = Number.isSafeInteger(event.turn) && event.turn! >= 0
    ? event.turn!
    : turnByInteraction.get(event.interactionSessionId);
  return turn === undefined ? null : `${event.interactionSessionId}\u0000${turn}`;
}

function splitTurnKey(key: string): [string, string] {
  const separator = key.lastIndexOf('\u0000');
  return [key.slice(0, separator), key.slice(separator + 1)];
}

function isCallTerminal(event: LlmTraceEventV1): boolean {
  return ['llm.response.recorded', 'llm.call.failed', 'llm.call.cancelled', 'trace.persistence_gap'].includes(event.type);
}

function isCacheMetricStatus(value: unknown): value is LlmTraceCacheMetricStatus {
  return value === 'reported' || value === 'unsupported' || value === 'unavailable' || value === 'bypass';
}

function unsupportedTraceUsage(source: string): LlmTraceUsageProjection {
  return { cacheStatus: 'unsupported', source };
}

function unavailableTraceUsage(source: string): LlmTraceUsageProjection {
  return { cacheStatus: 'unavailable', source };
}

function eventMatchesSession(event: LlmTraceEventV1, sessionId: string): boolean {
  return conversationSessionId(event) === sessionId
    || event.goalSessionId === sessionId
    || event.interactionSessionId === sessionId
    || `call:${event.callId ?? event.eventId}` === sessionId;
}

function conversationSessionId(event: Pick<LlmTraceEventV1, 'profileId'>): string {
  return `conversation:${event.profileId}`;
}

function eventStatus(event: LlmTraceEventV1): string {
  if (event.type === 'llm.response.recorded' || event.type === 'session.terminal') return 'succeeded';
  if (event.type === 'llm.call.failed' || event.type === 'trace.persistence_gap') return 'failed';
  if (event.type === 'llm.call.cancelled') return 'cancelled';
  return 'in_flight';
}

function callStatus(event: LlmTraceEventV1 | null): LlmTraceCallDetail['status'] {
  if (!event) return 'interrupted';
  if (event.type === 'llm.response.recorded') return 'succeeded';
  if (event.type === 'llm.call.cancelled') return 'cancelled';
  if (event.type === 'trace.persistence_gap') return 'interrupted';
  return 'failed';
}

function eventSearchText(event: LlmTraceEventV1): string {
  return `${event.type} ${event.agent} ${event.node ?? ''} ${JSON.stringify(event.payload)}`.toLocaleLowerCase();
}

function sessionSearchText(session: LlmTraceSessionSummary): string {
  return `${session.sessionId} ${session.title} ${session.taskId ?? ''} ${session.agents.join(' ')} ${session.nodes.join(' ')} ${session.turns.map(turn => turn.title).join(' ')}`.toLocaleLowerCase();
}

function objectValue(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, any>
    : {};
}

function boundedLimit(value: number | undefined, fallback: number, max: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > max) {
    throw new LlmTraceQueryError('invalid_query', `${name} must be an integer between 1 and ${max}`);
  }
  return resolved;
}

function optionalSeq(value: number | undefined, name: string): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
    throw new LlmTraceQueryError('invalid_query', `${name} must be a non-negative integer`);
  }
}

function encodeCursor(seq: number): string {
  return Buffer.from(JSON.stringify({ v: 1, beforeSeq: seq })).toString('base64url');
}

function decodeCursor(cursor: string): number {
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { v?: unknown; beforeSeq?: unknown };
    if (value.v !== 1 || !Number.isSafeInteger(value.beforeSeq) || Number(value.beforeSeq) < 1) throw new Error('invalid');
    return Number(value.beforeSeq);
  } catch {
    throw new LlmTraceQueryError('invalid_query', 'invalid session cursor');
  }
}
