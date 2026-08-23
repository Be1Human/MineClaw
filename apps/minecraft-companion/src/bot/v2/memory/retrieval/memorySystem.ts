import { randomUUID } from 'node:crypto';
import { canonicalMemoryId } from '../adapters.js';
import { MemoryCatalog } from '../catalog.js';
import type {
  EpisodeRecord,
  EvidenceRecord,
  MemoryKind,
  MemoryRecord,
  RecallRequest,
  RecallResult,
} from '../contracts.js';
import { EpisodeStore } from '../episode/episodeStore.js';
import { PlanningMemoryView, type PlanningMemoryContext } from '../planning/planningMemoryView.js';
import type { MemoryRecallProvider } from '../liveRecall.js';

export type MemoryPriority = 'P0' | 'P1' | 'P2' | 'P3' | 'P4';

export interface RankedMemory {
  record: MemoryRecord;
  priority: MemoryPriority;
  score: number;
  reasons: string[];
}

export interface RecallTrace {
  traceId: string;
  profileId: string;
  query: string;
  mode: RecallRequest['mode'];
  candidateCount: number;
  selected: Array<{ id: string; priority: MemoryPriority; score: number; reasons: string[] }>;
  dropped: Array<{ id: string; reason: string }>;
  gaps: string[];
  budget: number;
  used: number;
  durationMs: number;
}

export interface PreparedMemoryContext {
  text: string;
  result: RecallResult;
  trace: RecallTrace;
}

export interface MemorySystemOptions {
  onTrace?: (trace: RecallTrace) => void;
  liveProviders?: MemoryRecallProvider[];
}

export interface MemorySystemStats {
  recalls: number;
  gaps: number;
  totalDurationMs: number;
  byMode: Record<RecallRequest['mode'], number>;
}

/** Independent facade shared by MainBrain, tools and later Planner views. */
export class MemorySystem {
  private readonly traces = new Map<string, RecallTrace>();
  private readonly planningView = new PlanningMemoryView();
  private readonly metrics: MemorySystemStats = {
    recalls: 0,
    gaps: 0,
    totalDurationMs: 0,
    byMode: { auto: 0, deep: 0, planning: 0 },
  };

  constructor(
    private readonly profileId: string,
    private readonly catalog: MemoryCatalog,
    private readonly episodes: EpisodeStore,
    private readonly options: MemorySystemOptions = {},
  ) {}

  prepareContext(query: string, budget = 3_600): PreparedMemoryContext {
    const result = this.recall({ profileId: this.profileId, query, mode: 'auto', budget });
    const trace = this.trace(result.traceId)!;
    return { text: formatContext(result.records, result.episodes), result, trace };
  }

  deepRecall(input: {
    query: string;
    budget?: number;
    entities?: string[];
    locations?: string[];
    timeRange?: { from?: number; to?: number };
    includeEvidence?: boolean;
  }): RecallResult {
    return this.recall({
      profileId: this.profileId,
      query: input.query,
      mode: 'deep',
      budget: input.budget ?? 8_000,
      entities: input.entities,
      locations: input.locations,
      timeRange: input.timeRange,
      includeEvidence: input.includeEvidence ?? true,
    });
  }

  preparePlanningContext(goal: string, budget = 3_000): PlanningMemoryContext {
    const result = this.recall({
      profileId: this.profileId,
      query: goal,
      mode: 'planning',
      budget,
      includeEvidence: true,
    });
    return this.planningView.build(result);
  }

  recall(request: RecallRequest): RecallResult {
    const startedAt = Date.now();
    if (request.profileId !== this.profileId) throw new Error('[MemorySystem] profile mismatch');
    const query = request.query?.trim() ?? '';
    const catalog = this.catalog.search({
      profileId: request.profileId,
      status: 'active',
      query: query || undefined,
      from: request.timeRange?.from,
      to: request.timeRange?.to,
      entities: request.entities,
      locations: request.locations,
      limit: request.mode === 'deep' ? 500 : 250,
    });
    // P0/P1 是身份、边界和承诺，不能因为本轮关键词或预算被静默裁掉。
    const protectedRecords = (['boundary', 'identity', 'commitment'] as const).flatMap(kind =>
      this.catalog.query({ profileId: request.profileId, status: 'active', kind, limit: 32 }),
    );
    const episodeRecords = this.episodes.query({
      profileId: request.profileId,
      from: request.timeRange?.from,
      to: request.timeRange?.to,
      participantId: request.entities?.[0],
      locationRef: request.locations?.[0],
      limit: request.mode === 'deep' ? 100 : 30,
    });
    const liveRecords = (this.options.liveProviders ?? []).flatMap(provider => provider.recall({
      profileId: request.profileId,
      query,
      mode: request.mode,
      limit: request.mode === 'deep' ? 100 : 30,
    }));
    const episodeMemories = episodeRecords.map(episodeToMemoryRecord);
    const candidates = dedupe([...protectedRecords, ...liveRecords, ...catalog, ...episodeMemories])
      .filter(record => request.mode === 'deep' || !['bot', 'system'].includes(String(record.metadata.role ?? '')));
    const ranked = candidates
      .map(record => rank(record, query))
      .filter(item => request.mode === 'deep' || item.priority === 'P0' || item.priority === 'P1' || item.score > 0.18)
      .sort(compareRanked);
    const selected: RankedMemory[] = [];
    const dropped: RecallTrace['dropped'] = [];
    let used = 0;
    for (const item of ranked) {
      if (item.priority !== 'P0' && item.priority !== 'P1'
        && selected.some(existing => summarySimilarity(existing.record.summary, item.record.summary) >= 0.82)) {
        dropped.push({ id: item.record.id, reason: 'redundant' });
        continue;
      }
      const cost = item.record.summary.length + 42;
      if (used + cost > request.budget && item.priority !== 'P0' && item.priority !== 'P1') {
        dropped.push({ id: item.record.id, reason: 'budget' });
        continue;
      }
      selected.push(item);
      used += cost;
      if (request.mode === 'auto' && selected.length >= 18) break;
      if (request.mode === 'deep' && selected.length >= 60) break;
    }
    const selectedIds = new Set(selected.map(item => item.record.id));
    const selectedEpisodes = episodeRecords.filter(episode => selectedIds.has(episodeToMemoryRecord(episode).id));
    const records = selected.filter(item => item.record.kind !== 'episode').map(item => item.record);
    const evidence = request.includeEvidence
      ? selected.flatMap(item => item.record.sourceRefs.map(ref => ({ ref, occurredAt: item.record.occurredAt } as EvidenceRecord)))
      : [];
    const gaps = selected.length === 0 && query ? ['没有找到与当前问题匹配的可验证记忆'] : [];
    const traceId = `memory-trace-${randomUUID()}`;
    const result: RecallResult = { records, episodes: selectedEpisodes, evidence, gaps, traceId };
    const trace: RecallTrace = {
      traceId,
      profileId: request.profileId,
      query,
      mode: request.mode,
      candidateCount: candidates.length,
      selected: selected.map(item => ({ id: item.record.id, priority: item.priority, score: item.score, reasons: item.reasons })),
      dropped,
      gaps,
      budget: request.budget,
      used,
      durationMs: Date.now() - startedAt,
    };
    this.traces.set(traceId, trace);
    while (this.traces.size > 200) this.traces.delete(this.traces.keys().next().value!);
    this.metrics.recalls += 1;
    this.metrics.gaps += gaps.length > 0 ? 1 : 0;
    this.metrics.totalDurationMs += trace.durationMs;
    this.metrics.byMode[request.mode] += 1;
    this.options.onTrace?.(trace);
    return result;
  }

  trace(traceId: string): RecallTrace | null {
    return this.traces.get(traceId) ?? null;
  }

  stats(): MemorySystemStats {
    return { ...this.metrics, byMode: { ...this.metrics.byMode } };
  }
}

export function episodeToMemoryRecord(episode: EpisodeRecord): MemoryRecord {
  const summary = [
    `${episode.kind} 经历`,
    ...episode.keyEvents.slice(0, 4),
    episode.outcome ? `结果：${episode.outcome}` : '',
  ].filter(Boolean).join('；');
  const locationRefs = [
    episode.environmentStart.nearestLandmark,
    ...episode.keySnapshots.map(item => item.nearestLandmark),
  ].filter((value): value is string => Boolean(value));
  return {
    id: canonicalMemoryId(episode.profileId, 'episode-store', episode.episodeId),
    profileId: episode.profileId,
    kind: 'episode',
    status: episode.state === 'aborted' ? 'candidate' : 'active',
    summary,
    occurredAt: episode.startedAt,
    createdAt: episode.startedAt,
    updatedAt: episode.endedAt ?? episode.startedAt,
    importance: episode.kind === 'combat' || episode.kind === 'danger' ? 0.85 : 0.7,
    confidence: 1,
    entities: episode.participants.map(item => item.id),
    locationRefs: [...new Set(locationRefs)],
    sourceRefs: [{ store: 'episode-store', id: episode.episodeId }, ...episode.sourceRefs],
    evidenceRefs: episode.sourceRefs.map(ref => `${ref.store}:${ref.id}`),
    metadata: { sourceAdapterId: 'episode-store', state: episode.state, outcome: episode.outcome },
  };
}

function rank(record: MemoryRecord, query: string): RankedMemory {
  const priority = priorityOf(record.kind);
  const terms = queryTerms(query);
  const haystack = `${record.summary} ${record.entities.join(' ')} ${record.locationRefs.join(' ')}`.toLowerCase();
  const matches = terms.filter(term => haystack.includes(term));
  const lexical = terms.length === 0 ? 0 : matches.length / terms.length;
  const ageDays = Math.max(0, (Date.now() - (record.occurredAt ?? record.updatedAt)) / 86_400_000);
  const recency = 1 / (1 + ageDays / 30);
  const score = Math.min(1, lexical * 0.58 + record.importance * 0.2 + record.confidence * 0.14 + recency * 0.08);
  const reasons = [
    ...(matches.length ? [`query:${matches.slice(0, 4).join(',')}`] : []),
    `importance:${record.importance.toFixed(2)}`,
    `confidence:${record.confidence.toFixed(2)}`,
  ];
  return { record, priority, score, reasons };
}

function priorityOf(kind: MemoryKind): MemoryPriority {
  if (kind === 'boundary') return 'P0';
  if (kind === 'identity' || kind === 'commitment') return 'P1';
  if (kind === 'episode') return 'P3';
  return 'P2';
}

function compareRanked(a: RankedMemory, b: RankedMemory): number {
  const order: Record<MemoryPriority, number> = { P0: 0, P1: 1, P2: 2, P3: 3, P4: 4 };
  return order[a.priority] - order[b.priority] || b.score - a.score || a.record.id.localeCompare(b.record.id);
}

function queryTerms(query: string): string[] {
  const normalized = query.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const chunks = normalized.match(/[a-z0-9_]{2,}|[\p{Script=Han}]{2,}/gu) ?? [];
  const terms: string[] = [];
  for (const chunk of chunks) {
    if (/^[\p{Script=Han}]+$/u.test(chunk) && chunk.length > 2) {
      for (let index = 0; index < chunk.length - 1; index += 1) terms.push(chunk.slice(index, index + 2));
    } else terms.push(chunk);
  }
  return [...new Set(terms)].filter(term => !['什么', '那个', '这个', '怎么', '我们', '你们'].includes(term));
}

function dedupe(records: MemoryRecord[]): MemoryRecord[] {
  return [...new Map(records.map(record => [record.id, record])).values()];
}

function summarySimilarity(left: string, right: string): number {
  const a = new Set(queryTerms(left));
  const b = new Set(queryTerms(right));
  if (a.size === 0 || b.size === 0) return left.trim() === right.trim() ? 1 : 0;
  let intersection = 0;
  for (const term of a) if (b.has(term)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

function formatContext(records: MemoryRecord[], episodes: EpisodeRecord[]): string {
  if (records.length === 0 && episodes.length === 0) return '';
  const lines = ['── 统一记忆上下文（仅依据证据，自然使用，不要逐条复述）──'];
  for (const record of records) lines.push(`- [${record.kind}] ${record.summary}（证据 ${record.sourceRefs[0]?.store}:${record.sourceRefs[0]?.id}）`);
  for (const episode of episodes) {
    lines.push(`- [episode/${episode.kind}] ${episode.keyEvents.join('；')}${episode.outcome ? `；结果：${episode.outcome}` : ''}（episode ${episode.episodeId}）`);
  }
  return lines.join('\n');
}
