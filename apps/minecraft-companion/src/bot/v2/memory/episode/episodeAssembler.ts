import { createHash } from 'node:crypto';
import type { EnvironmentSnapshot, EpisodeParticipant, EpisodeRecord, SourceRef } from '../contracts.js';
import type { EpisodeApplyResult, EpisodeEnvelope, EpisodeObservation } from './contracts.js';
import { EpisodeRuleRegistry } from './rules.js';
import { EpisodeStore } from './episodeStore.js';

export class EpisodeAssembler {
  private readonly open = new Map<string, EpisodeEnvelope>();

  constructor(
    private readonly store: EpisodeStore,
    private readonly rules = new EpisodeRuleRegistry(),
  ) {
    for (const envelope of store.listOpen()) this.open.set(envelope.episode.episodeId, envelope);
  }

  accept(observation: EpisodeObservation): EpisodeApplyResult {
    validateObservation(observation);
    const duplicateEpisodeId = this.store.observationEpisode(observation.observationId);
    if (duplicateEpisodeId) {
      const duplicate = this.store.get(duplicateEpisodeId);
      if (!duplicate) throw new Error(`[EpisodeAssembler] missing duplicate episode: ${duplicateEpisodeId}`);
      return { episode: duplicate.episode, created: false, finalizedNow: false, duplicate: true, snapshotAdded: false };
    }

    const matched = this.findMatch(observation);
    const created = !matched;
    const envelope = matched ?? createEnvelope(observation);
    const beforeState = envelope.episode.state;
    const snapshotAdded = applyObservation(envelope, observation, this.rules);
    this.store.saveObservation(envelope, observation);
    if (envelope.episode.state === 'open' || envelope.episode.state === 'finalizing') {
      this.open.set(envelope.episode.episodeId, envelope);
    } else {
      this.open.delete(envelope.episode.episodeId);
    }
    return {
      episode: envelope.episode,
      created,
      finalizedNow: !['finalized', 'aborted'].includes(beforeState)
        && ['finalized', 'aborted'].includes(envelope.episode.state),
      duplicate: false,
      snapshotAdded,
    };
  }

  private findMatch(observation: EpisodeObservation): EpisodeEnvelope | null {
    const candidates = [...this.open.values()]
      .filter(item => item.episode.profileId === observation.profileId && item.episode.kind === observation.kind)
      .filter(item => compatible(item, observation, this.rules))
      .sort((a, b) => b.lastObservedAt - a.lastObservedAt);
    return candidates[0] ?? null;
  }
}

function createEnvelope(observation: EpisodeObservation): EpisodeEnvelope {
  const environmentStart = observation.snapshot ?? emptySnapshot(observation.timestamp, observation);
  const episode: EpisodeRecord = {
    episodeId: episodeId(observation),
    profileId: observation.profileId,
    kind: observation.kind,
    state: 'open',
    startedAt: observation.timestamp,
    environmentStart,
    keySnapshots: [],
    participants: uniqueParticipants(observation.participants ?? []),
    keyEvents: observation.eventSummary ? [observation.eventSummary] : [],
    emotionTags: unique(observation.emotionTags ?? []),
    lessonCandidates: unique(observation.lessonCandidates ?? []),
    sourceRefs: uniqueRefs(observation.sourceRefs),
  };
  return {
    episode,
    ...(observation.correlationId ? { correlationId: observation.correlationId } : {}),
    ...(observation.taskId ? { taskId: observation.taskId } : {}),
    ...(observation.locationRef ? { locationRef: observation.locationRef } : {}),
    lastObservedAt: observation.timestamp,
  };
}

function applyObservation(
  envelope: EpisodeEnvelope,
  observation: EpisodeObservation,
  rules: EpisodeRuleRegistry,
): boolean {
  const episode = envelope.episode;
  episode.participants = uniqueParticipants([...episode.participants, ...(observation.participants ?? [])]);
  episode.sourceRefs = uniqueRefs([...episode.sourceRefs, ...observation.sourceRefs]);
  episode.emotionTags = unique([...episode.emotionTags, ...(observation.emotionTags ?? [])]);
  episode.lessonCandidates = unique([...episode.lessonCandidates, ...(observation.lessonCandidates ?? [])]);
  if (observation.eventSummary && !episode.keyEvents.includes(observation.eventSummary)) {
    episode.keyEvents.push(observation.eventSummary);
  }
  let snapshotAdded = false;
  if (observation.snapshot && observation.snapshot.timestamp !== episode.environmentStart.timestamp) {
    const previous = episode.keySnapshots.at(-1) ?? episode.environmentStart;
    if (observation.keyFrame || significantSnapshot(previous, observation.snapshot, rules.get(episode.kind))) {
      if (!episode.keySnapshots.some(item => sameSnapshot(item, observation.snapshot!))) {
        episode.keySnapshots.push(observation.snapshot);
        snapshotAdded = true;
      }
    }
  }
  if (observation.phase === 'terminal') {
    episode.state = observation.outcome === 'aborted' ? 'aborted' : 'finalized';
    episode.endedAt = observation.timestamp;
    if (observation.outcome) episode.outcome = observation.outcome;
  }
  if (observation.correlationId) envelope.correlationId = observation.correlationId;
  if (observation.taskId) envelope.taskId = observation.taskId;
  if (observation.locationRef) envelope.locationRef = observation.locationRef;
  envelope.lastObservedAt = Math.max(envelope.lastObservedAt, observation.timestamp);
  return snapshotAdded;
}

function compatible(envelope: EpisodeEnvelope, observation: EpisodeObservation, rules: EpisodeRuleRegistry): boolean {
  if (observation.timestamp < envelope.episode.startedAt) return false;
  if (observation.timestamp - envelope.lastObservedAt > rules.get(observation.kind).maxGapMs) return false;
  if (envelope.correlationId && observation.correlationId && envelope.correlationId !== observation.correlationId) return false;
  if (envelope.taskId && observation.taskId && envelope.taskId !== observation.taskId) return false;
  if (envelope.locationRef && observation.locationRef && envelope.locationRef !== observation.locationRef) return false;
  return Boolean(
    (envelope.correlationId && observation.correlationId)
    || (envelope.taskId && observation.taskId)
    || (envelope.locationRef && observation.locationRef)
    || (!envelope.correlationId && !observation.correlationId && !envelope.taskId && !observation.taskId),
  );
}

function significantSnapshot(a: EnvironmentSnapshot, b: EnvironmentSnapshot, rule: { healthDelta: number; positionDelta: number }): boolean {
  if (a.dimension !== b.dimension || a.nearestLandmark !== b.nearestLandmark) return true;
  if (Math.abs((a.health ?? 0) - (b.health ?? 0)) >= rule.healthDelta) return true;
  if (!sameSet(a.nearbyHostiles, b.nearbyHostiles) || !sameSet(a.hazards, b.hazards)) return true;
  if (a.position && b.position) {
    const distance = Math.hypot(a.position.x - b.position.x, a.position.y - b.position.y, a.position.z - b.position.z);
    if (distance >= rule.positionDelta) return true;
  }
  return a.currentAction !== b.currentAction || a.nodeId !== b.nodeId;
}

function sameSnapshot(a: EnvironmentSnapshot, b: EnvironmentSnapshot): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && [...a].sort().every((value, index) => value === [...b].sort()[index]);
}

function emptySnapshot(timestamp: number, observation: EpisodeObservation): EnvironmentSnapshot {
  return {
    timestamp,
    nearbyHostiles: [],
    hazards: [],
    sourceEventIds: observation.sourceRefs.map(ref => `${ref.store}:${ref.id}`),
    ...(observation.taskId ? { taskId: observation.taskId } : {}),
    ...(observation.correlationId ? { correlationId: observation.correlationId } : {}),
  };
}

function episodeId(observation: EpisodeObservation): string {
  const digest = createHash('sha256')
    .update(`${observation.profileId}\0${observation.kind}\0${observation.observationId}`)
    .digest('hex').slice(0, 24);
  return `episode-${digest}`;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))];
}

function uniqueRefs(refs: readonly SourceRef[]): SourceRef[] {
  const seen = new Set<string>();
  return refs.filter(ref => {
    const key = `${ref.store}\0${ref.id}`;
    if (!ref.store || !ref.id || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function uniqueParticipants(items: readonly EpisodeParticipant[]): EpisodeParticipant[] {
  const byId = new Map<string, EpisodeParticipant>();
  for (const item of items) if (item.id) byId.set(item.id, item);
  return [...byId.values()];
}

function validateObservation(observation: EpisodeObservation): void {
  if (!observation.observationId || !observation.profileId) throw new Error('[EpisodeAssembler] observationId/profileId required');
  if (!Number.isFinite(observation.timestamp) || observation.timestamp < 0) throw new Error('[EpisodeAssembler] invalid timestamp');
  if (observation.sourceRefs.length === 0) throw new Error('[EpisodeAssembler] sourceRefs required');
  if (observation.phase === 'terminal' && !observation.outcome) throw new Error('[EpisodeAssembler] terminal outcome required');
}
