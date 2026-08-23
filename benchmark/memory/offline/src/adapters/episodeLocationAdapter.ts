import { join } from 'node:path';
import { MemoryCatalog } from '../../../../../apps/minecraft-companion/src/bot/v2/memory/catalog.js';
import type { EnvironmentSnapshot, EpisodeParticipant } from '../../../../../apps/minecraft-companion/src/bot/v2/memory/contracts.js';
import { EpisodeAssembler } from '../../../../../apps/minecraft-companion/src/bot/v2/memory/episode/episodeAssembler.js';
import { EpisodeStore } from '../../../../../apps/minecraft-companion/src/bot/v2/memory/episode/episodeStore.js';
import type { EpisodeObservation } from '../../../../../apps/minecraft-companion/src/bot/v2/memory/episode/contracts.js';
import { MemorySystem } from '../../../../../apps/minecraft-companion/src/bot/v2/memory/retrieval/memorySystem.js';
import { check } from '../checks.js';
import type { BenchmarkAdapter, CaseContext, CaseExecution, EpisodeLocationCase } from '../types.js';

export class EpisodeLocationBenchmarkAdapter implements BenchmarkAdapter<EpisodeLocationCase> {
  readonly domain = 'episode_location' as const;

  execute(testCase: EpisodeLocationCase, context: CaseContext): CaseExecution {
    const started = Date.now();
    const dbPath = join(context.workDir, `${testCase.id}.episodes.db`);
    const store = new EpisodeStore(dbPath);
    const assembler = new EpisodeAssembler(store);
    let lastEpisodeId = '';
    for (const fixture of testCase.input.observations) {
      const applied = assembler.accept(toObservation(testCase, fixture));
      lastEpisodeId = applied.episode.episodeId;
    }
    store.close();

    const reopened = new EpisodeStore(dbPath);
    const byLocation = reopened.query({ profileId: testCase.input.profileId, locationRef: testCase.expected.locationRef });
    const episode = byLocation.find(item => item.episodeId === lastEpisodeId);
    const catalog = new MemoryCatalog(join(context.workDir, `${testCase.id}.catalog.db`));
    const recall = new MemorySystem(testCase.input.profileId, catalog, reopened).deepRecall({
      query: testCase.input.query,
      locations: [testCase.expected.locationRef],
      includeEvidence: true,
    });
    const deepRecalled = recall.episodes.some(item => item.episodeId === lastEpisodeId);
    const foreignCount = reopened.query({ profileId: 'profile-foreign', locationRef: testCase.expected.locationRef }).length;
    const participantIds = episode?.participants.map(item => item.id) ?? [];
    const snapshots = episode ? [episode.environmentStart, ...episode.keySnapshots] : [];
    const minHealth = snapshots.reduce((min, item) => Math.min(min, item.health ?? Number.POSITIVE_INFINITY), Number.POSITIVE_INFINITY);
    const recordedWeather = episode ? (episode.environmentStart as EnvironmentSnapshot & { isRaining?: boolean }).isRaining : undefined;
    catalog.close();
    reopened.close();

    return {
      caseId: testCase.id,
      domain: this.domain,
      split: testCase.split,
      tags: testCase.tags,
      durationMs: Date.now() - started,
      checks: [
        check({ id: 'episode_finalized', passed: episode?.state === testCase.expected.state && episode?.outcome === testCase.expected.outcome, expected: { state: testCase.expected.state, outcome: testCase.expected.outcome }, actual: episode ? { state: episode.state, outcome: episode.outcome } : null, weight: 15, critical: true, evidence: `episodeId=${lastEpisodeId}` }),
        check({ id: 'location_index', passed: Boolean(episode), expected: testCase.expected.locationRef, actual: byLocation.length, weight: 10, critical: true, evidence: `locationQueryRows=${byLocation.length}` }),
        check({ id: 'participants', passed: testCase.expected.participants.every(id => participantIds.includes(id)), expected: testCase.expected.participants, actual: participantIds, weight: 10, critical: true, evidence: `participants=${participantIds.join(',')}` }),
        check({ id: 'environment_snapshots', passed: (episode?.keySnapshots.length ?? 0) >= testCase.expected.minimumSnapshots && minHealth === testCase.expected.minimumHealth, expected: { minimumSnapshots: testCase.expected.minimumSnapshots, minimumHealth: testCase.expected.minimumHealth }, actual: { snapshots: episode?.keySnapshots.length ?? 0, minimumHealth: minHealth }, weight: 15, critical: true, evidence: `snapshotCount=${episode?.keySnapshots.length ?? 0}` }),
        check({ id: 'environment_weather', passed: recordedWeather === testCase.expected.isRaining, expected: testCase.expected.isRaining, actual: recordedWeather ?? null, weight: 10, critical: true, evidence: 'EnvironmentSnapshot.isRaining field audit' }),
        check({ id: 'source_evidence', passed: (episode?.sourceRefs.length ?? 0) >= testCase.expected.minimumSourceRefs && recall.evidence.length > 0, expected: { sourceRefs: testCase.expected.minimumSourceRefs, recallEvidence: '>0' }, actual: { sourceRefs: episode?.sourceRefs.length ?? 0, recallEvidence: recall.evidence.length }, weight: 10, critical: true, evidence: `sourceRefs=${episode?.sourceRefs.map(ref => `${ref.store}:${ref.id}`).join(',') ?? ''}`, kind: 'evidence' }),
        check({ id: 'restart_durability', passed: Boolean(episode), expected: true, actual: Boolean(episode), weight: 10, critical: true, evidence: `reopenedEpisode=${episode?.episodeId ?? 'none'}`, kind: 'restart' }),
        check({ id: 'deep_recall', passed: deepRecalled, expected: lastEpisodeId, actual: recall.episodes.map(item => item.episodeId), weight: 15, critical: true, evidence: `traceId=${recall.traceId}`, kind: 'unified_recall' }),
        check({ id: 'profile_isolation', passed: foreignCount === 0, expected: 0, actual: foreignCount, weight: 5, critical: true, evidence: `foreignRows=${foreignCount}`, kind: 'profile_isolation' }),
      ],
      trace: {
        productionPath: 'EpisodeAssembler -> EpisodeStore -> reopen -> MemorySystem.deepRecall',
        episodeId: lastEpisodeId,
        locationRows: byLocation.length,
        recallTraceId: recall.traceId,
        weatherContractPresent: recordedWeather !== undefined,
      },
    };
  }
}

function toObservation(testCase: EpisodeLocationCase, fixture: EpisodeLocationCase['input']['observations'][number]): EpisodeObservation {
  const participants: EpisodeParticipant[] = [
    { id: 'owner', kind: 'owner' },
    { id: 'LanYi', kind: 'agent' },
    ...fixture.hostiles.map(id => ({ id, kind: 'mob' as const })),
  ];
  const snapshot: EnvironmentSnapshot = {
    timestamp: fixture.timestamp,
    dimension: 'overworld',
    position: { x: 10, y: 64, z: 20 },
    nearestLandmark: testCase.input.locationRef,
    nearbyHostiles: fixture.hostiles,
    hazards: fixture.hazards ?? [],
    health: fixture.health,
    food: 20,
    taskId: `task-${testCase.id}`,
    correlationId: `corr-${testCase.id}`,
    sourceEventIds: [`event-${testCase.id}-${fixture.id}`],
  };
  return {
    observationId: `${testCase.id}-${fixture.id}`,
    profileId: testCase.input.profileId,
    phase: fixture.phase,
    kind: testCase.input.kind,
    timestamp: fixture.timestamp,
    correlationId: `corr-${testCase.id}`,
    taskId: `task-${testCase.id}`,
    locationRef: testCase.input.locationRef,
    snapshot,
    participants,
    eventSummary: fixture.eventSummary,
    ...(fixture.outcome ? { outcome: fixture.outcome } : {}),
    ...(fixture.emotionTags ? { emotionTags: fixture.emotionTags } : {}),
    keyFrame: fixture.keyFrame,
    sourceRefs: [{ store: 'benchmark-event-bus', id: `${testCase.id}-${fixture.id}` }],
  };
}
