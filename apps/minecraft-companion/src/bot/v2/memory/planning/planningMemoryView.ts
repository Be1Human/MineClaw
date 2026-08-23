import type { EpisodeRecord, MemoryRecord, RecallResult, SourceRef } from '../contracts.js';

export interface EvidenceBound<T> {
  value: T;
  evidence: SourceRef[];
  confidence: number;
  status: 'candidate' | 'trusted';
}

export interface ResourceHint {
  description: string;
  locations: string[];
}

export interface RiskHint {
  description: string;
  locations: string[];
  outcome?: string;
}

export interface PlanningLesson {
  description: string;
  source: 'record' | 'episode';
}

export interface PolicyRef {
  id: string;
  description: string;
}

export interface PlanningMemoryContext {
  constraints: Array<EvidenceBound<string>>;
  knownResources: Array<EvidenceBound<ResourceHint>>;
  knownRisks: Array<EvidenceBound<RiskHint>>;
  relevantLessons: Array<EvidenceBound<PlanningLesson>>;
  trustedPolicies: Array<EvidenceBound<PolicyRef>>;
  unknowns: string[];
  traceId: string;
}

/** Planner-only projection. Conversation/preference/identity payloads are intentionally excluded. */
export class PlanningMemoryView {
  build(result: RecallResult): PlanningMemoryContext {
    const constraints = result.records
      .filter(record => record.kind === 'boundary' || record.kind === 'commitment')
      .map(record => bound(record.summary, record, 'trusted'));
    const knownResources = result.records
      .filter(record => record.kind === 'spatial')
      .map(record => bound<ResourceHint>({ description: record.summary, locations: record.locationRefs }, record, 'trusted'));
    const knownRisks = result.episodes
      .filter(episode => episode.kind === 'combat' || episode.kind === 'danger')
      .map(episode => episodeBound<RiskHint>({
        description: episode.keyEvents.slice(0, 4).join('；') || `${episode.kind} 经历`,
        locations: episodeLocations(episode),
        ...(episode.outcome ? { outcome: episode.outcome } : {}),
      }, episode));
    const recordLessons = result.records
      .filter(record => record.kind === 'task_experience' && isLesson(record))
      .map(record => bound<PlanningLesson>(
        { description: record.summary, source: 'record' },
        record,
        record.confidence >= 0.85 && record.metadata.trusted === true ? 'trusted' : 'candidate',
      ));
    const episodeLessons = result.episodes.flatMap(episode => episode.lessonCandidates.map(description =>
      episodeBound<PlanningLesson>({ description, source: 'episode' }, episode),
    ));
    const trustedPolicies = result.records
      .filter(record => record.kind === 'planning_policy' && record.confidence >= 0.8 && record.metadata.trusted === true)
      .map(record => bound<PolicyRef>({ id: record.id, description: record.summary }, record, 'trusted'));
    const unknowns = [...result.gaps];
    if (knownRisks.length === 0) unknowns.push('没有与当前目标匹配的已验证风险经历');
    if (knownResources.length === 0) unknowns.push('没有与当前目标匹配的已知资源位置');
    return {
      constraints,
      knownResources,
      knownRisks,
      relevantLessons: [...recordLessons, ...episodeLessons],
      trustedPolicies,
      unknowns: [...new Set(unknowns)],
      traceId: result.traceId,
    };
  }
}

export function formatPlanningMemoryContext(context: PlanningMemoryContext): string {
  const lines = ['── 规划记忆视图（只读、证据约束）──'];
  append(lines, '必须遵守的约束', context.constraints.map(item => item.value));
  append(lines, '已知资源', context.knownResources.map(item => `${item.value.description}${formatLocations(item.value.locations)}`));
  append(lines, '已知风险', context.knownRisks.map(item => `${item.value.description}${formatLocations(item.value.locations)}${item.value.outcome ? `；历史结果：${item.value.outcome}` : ''}`));
  append(lines, '相关经验', context.relevantLessons.map(item => `${item.value.description}（${item.status === 'trusted' ? '可信' : '候选，不得当硬规则'}）`));
  append(lines, '可信策略', context.trustedPolicies.map(item => item.value.description));
  append(lines, '未知项', context.unknowns);
  lines.push(`trace: ${context.traceId}`);
  return lines.join('\n');
}

function bound<T>(value: T, record: MemoryRecord, status: EvidenceBound<T>['status']): EvidenceBound<T> {
  return { value, evidence: record.sourceRefs, confidence: record.confidence, status };
}

function episodeBound<T>(value: T, episode: EpisodeRecord): EvidenceBound<T> {
  return { value, evidence: episode.sourceRefs, confidence: 1, status: 'candidate' };
}

function episodeLocations(episode: EpisodeRecord): string[] {
  return [...new Set([
    episode.environmentStart.nearestLandmark,
    ...episode.keySnapshots.map(snapshot => snapshot.nearestLandmark),
  ].filter((value): value is string => Boolean(value)))];
}

function isLesson(record: MemoryRecord): boolean {
  return record.metadata.lesson === true || record.metadata.authorityType === 'planner_episode';
}

function append(lines: string[], title: string, values: string[]): void {
  if (values.length === 0) return;
  lines.push(`${title}：`);
  for (const value of values.slice(0, 8)) lines.push(`- ${value}`);
}

function formatLocations(locations: string[]): string {
  return locations.length > 0 ? `；地点：${locations.join('、')}` : '';
}
