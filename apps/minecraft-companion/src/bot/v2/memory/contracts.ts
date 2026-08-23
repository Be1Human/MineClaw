/** FEAT-CROSS-13: unified, source-agnostic memory contracts. */

export type MemoryKind =
  | 'identity'
  | 'boundary'
  | 'preference'
  | 'commitment'
  | 'conversation'
  | 'episode'
  | 'spatial'
  | 'event'
  | 'task_experience'
  | 'planning_policy';

export type MemoryStatus = 'candidate' | 'active' | 'superseded' | 'deleted' | 'expired';

export interface SourceRef {
  store: string;
  id: string;
}

export interface MemoryInput {
  profileId: string;
  kind: MemoryKind;
  summary: string;
  sourceRefs: SourceRef[];
  status?: MemoryStatus;
  occurredAt?: number;
  createdAt?: number;
  updatedAt?: number;
  importance?: number;
  confidence?: number;
  entities?: string[];
  locationRefs?: string[];
  evidenceRefs?: string[];
  metadata?: Record<string, unknown>;
}

export interface MemoryRecord {
  id: string;
  profileId: string;
  kind: MemoryKind;
  status: MemoryStatus;
  summary: string;
  occurredAt?: number;
  createdAt: number;
  updatedAt: number;
  importance: number;
  confidence: number;
  entities: string[];
  locationRefs: string[];
  sourceRefs: SourceRef[];
  evidenceRefs: string[];
  metadata: Record<string, unknown>;
}

export interface EnvironmentSnapshot {
  timestamp: number;
  dimension?: string;
  position?: { x: number; y: number; z: number };
  nearestLandmark?: string;
  nearbyHostiles: string[];
  ownerDistance?: number;
  hazards: string[];
  health?: number;
  food?: number;
  taskId?: string;
  goal?: string;
  planRunId?: string;
  nodeId?: string;
  currentAction?: string;
  turnId?: string;
  correlationId?: string;
  sourceEventIds: string[];
}

export interface EpisodeParticipant {
  id: string;
  kind: 'owner' | 'agent' | 'player' | 'mob' | 'unknown';
  role?: string;
}

export interface EpisodeRecord {
  episodeId: string;
  profileId: string;
  kind: 'combat' | 'danger' | 'task' | 'social' | 'exploration';
  state: 'open' | 'finalizing' | 'finalized' | 'aborted';
  startedAt: number;
  endedAt?: number;
  environmentStart: EnvironmentSnapshot;
  keySnapshots: EnvironmentSnapshot[];
  participants: EpisodeParticipant[];
  keyEvents: string[];
  outcome?: string;
  emotionTags: string[];
  lessonCandidates: string[];
  sourceRefs: SourceRef[];
}

export interface RecallRequest {
  profileId: string;
  query?: string;
  timeRange?: { from?: number; to?: number };
  entities?: string[];
  locations?: string[];
  mode: 'auto' | 'deep' | 'planning';
  budget: number;
  includeEvidence?: boolean;
}

export interface EvidenceRecord {
  ref: SourceRef;
  excerpt?: string;
  occurredAt?: number;
  metadata?: Record<string, unknown>;
}

export interface RecallResult {
  records: MemoryRecord[];
  episodes: EpisodeRecord[];
  evidence: EvidenceRecord[];
  gaps: string[];
  traceId: string;
}

export interface MemorySourceBatch {
  records: MemoryRecord[];
  nextCursor: string | null;
  exhausted: boolean;
  /** Exact authority-row count when known after a complete scan. */
  sourceCount?: number;
}

export interface MemorySourceAdapter {
  readonly id: string;
  scan(profileId: string, cursor: string | null, limit: number): Promise<MemorySourceBatch>;
}

export interface MemoryViewBuilder<TView = unknown> {
  readonly id: string;
  build(request: RecallRequest, records: readonly MemoryRecord[]): Promise<TView> | TView;
}
