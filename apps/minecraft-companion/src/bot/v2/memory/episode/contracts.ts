import type { EnvironmentSnapshot, EpisodeParticipant, EpisodeRecord, SourceRef } from '../contracts.js';

export type EpisodeKind = EpisodeRecord['kind'];

export interface EpisodeObservation {
  observationId: string;
  profileId: string;
  phase: 'started' | 'event' | 'snapshot' | 'terminal';
  kind: EpisodeKind;
  timestamp: number;
  correlationId?: string;
  taskId?: string;
  locationRef?: string;
  snapshot?: EnvironmentSnapshot;
  participants?: EpisodeParticipant[];
  eventSummary?: string;
  outcome?: string;
  emotionTags?: string[];
  lessonCandidates?: string[];
  sourceRefs: SourceRef[];
  /** Force retention when upstream already classified a change as significant. */
  keyFrame?: boolean;
}

export interface EpisodeEnvelope {
  episode: EpisodeRecord;
  correlationId?: string;
  taskId?: string;
  locationRef?: string;
  lastObservedAt: number;
}

export interface EpisodeApplyResult {
  episode: EpisodeRecord;
  created: boolean;
  finalizedNow: boolean;
  duplicate: boolean;
  snapshotAdded: boolean;
}

export interface EpisodeRule {
  kind: EpisodeKind;
  maxGapMs: number;
  healthDelta: number;
  positionDelta: number;
}
