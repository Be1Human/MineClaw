import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EpisodeAssembler,
  EpisodeStore,
  type EnvironmentSnapshot,
  type EpisodeObservation,
} from '../../../../../../apps/minecraft-companion/src/bot/v2/memory/index.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('EpisodeAssembler', () => {
  test('zombie combat preserves start, significant change, terminal evidence and outcome', () => {
    const store = new EpisodeStore(':memory:');
    const assembler = new EpisodeAssembler(store);
    const start = assembler.accept(observation('start', 1_000, 'started', {
      eventSummary: '夜晚在村庄遭遇僵尸',
      snapshot: snapshot(1_000, { health: 20, nearbyHostiles: ['zombie-1'] }),
    }));
    assert.equal(start.created, true);
    assert.equal(start.episode.state, 'open');

    const noise = assembler.accept(observation('noise', 2_000, 'snapshot', {
      snapshot: snapshot(2_000, { health: 19, nearbyHostiles: ['zombie-1'] }),
    }));
    assert.equal(noise.snapshotAdded, false);

    const key = assembler.accept(observation('hurt', 3_000, 'event', {
      eventSummary: '被僵尸围攻，生命下降',
      snapshot: snapshot(3_000, { health: 14, nearbyHostiles: ['zombie-1', 'zombie-2'], hazards: ['surrounded'] }),
      emotionTags: ['惊险'],
    }));
    assert.equal(key.snapshotAdded, true);

    const terminal = assembler.accept(observation('terminal', 5_000, 'terminal', {
      eventSummary: '击败僵尸并脱险',
      outcome: 'survived',
      snapshot: snapshot(5_000, { health: 12, nearbyHostiles: [] }),
      lessonCandidates: ['夜间进村庄前准备盾牌'],
    }));
    assert.equal(terminal.finalizedNow, true);
    assert.equal(terminal.episode.state, 'finalized');
    assert.equal(terminal.episode.outcome, 'survived');
    assert.equal(terminal.episode.keySnapshots.length, 2);
    assert.deepEqual(terminal.episode.participants.map(item => item.id).sort(), ['LanYi', 'owner', 'zombie-1']);
    assert.deepEqual(terminal.episode.emotionTags, ['惊险']);
    assert.equal(terminal.episode.sourceRefs.length, 4);
    assert.equal(store.query({ profileId: 'profile-a', participantId: 'zombie-1' }).length, 1);
    assert.equal(store.query({ profileId: 'profile-a', locationRef: 'village' }).length, 1);
    store.close();
  });

  test('restart restores open episode and duplicate observations stay idempotent', () => {
    const path = join(tempDir(), 'episodes.db');
    const firstStore = new EpisodeStore(path);
    const first = new EpisodeAssembler(firstStore).accept(observation('start', 1_000, 'started'));
    const episodeId = first.episode.episodeId;
    firstStore.close();

    const reopened = new EpisodeStore(path);
    const assembler = new EpisodeAssembler(reopened);
    const event = assembler.accept(observation('event', 2_000, 'event', { eventSummary: '战斗持续' }));
    assert.equal(event.episode.episodeId, episodeId);
    const duplicate = assembler.accept(observation('event', 2_000, 'event', { eventSummary: '不同文本也不能覆盖同 observation' }));
    assert.equal(duplicate.duplicate, true);
    assert.deepEqual(duplicate.episode.keyEvents, ['战斗持续']);
    const terminal = assembler.accept(observation('terminal', 3_000, 'terminal', { outcome: 'escaped' }));
    assert.equal(terminal.episode.episodeId, episodeId);
    assert.equal(terminal.episode.state, 'finalized');
    reopened.close();
  });

  test('profile, correlation, task, location and time boundaries prevent false merging', () => {
    const store = new EpisodeStore(':memory:');
    const assembler = new EpisodeAssembler(store);
    const a = assembler.accept(observation('a', 1_000, 'started')).episode.episodeId;
    const profile = assembler.accept(observation('b', 2_000, 'event', { profileId: 'profile-b' })).episode.episodeId;
    const correlation = assembler.accept(observation('c', 2_000, 'event', { correlationId: 'corr-2' })).episode.episodeId;
    const task = assembler.accept(observation('d', 2_000, 'event', { taskId: 'task-2' })).episode.episodeId;
    const location = assembler.accept(observation('e', 2_000, 'event', { locationRef: 'stronghold' })).episode.episodeId;
    const timeout = assembler.accept(observation('f', 200_000, 'event')).episode.episodeId;
    assert.equal(new Set([a, profile, correlation, task, location, timeout]).size, 6);
    assert.equal(store.count('profile-a'), 5);
    assert.equal(store.count('profile-b'), 1);
    assert.equal(store.query({ profileId: 'profile-b' }).every(item => item.profileId === 'profile-b'), true);
    store.close();
  });
});

function observation(
  id: string,
  timestamp: number,
  phase: EpisodeObservation['phase'],
  overrides: Partial<EpisodeObservation> = {},
): EpisodeObservation {
  return {
    observationId: id,
    profileId: 'profile-a',
    phase,
    kind: 'combat',
    timestamp,
    correlationId: 'corr-1',
    taskId: 'task-1',
    locationRef: 'village',
    participants: [
      { id: 'owner', kind: 'owner' },
      { id: 'LanYi', kind: 'agent' },
      { id: 'zombie-1', kind: 'mob' },
    ],
    sourceRefs: [{ store: 'event-bus', id }],
    ...overrides,
  };
}

function snapshot(timestamp: number, overrides: Partial<EnvironmentSnapshot> = {}): EnvironmentSnapshot {
  return {
    timestamp,
    dimension: 'overworld',
    position: { x: 10, y: 64, z: 20 },
    nearestLandmark: 'village',
    nearbyHostiles: [],
    hazards: [],
    health: 20,
    food: 20,
    taskId: 'task-1',
    correlationId: 'corr-1',
    sourceEventIds: [`event-${timestamp}`],
    ...overrides,
  };
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'episode-memory-'));
  tempDirs.push(dir);
  return dir;
}
