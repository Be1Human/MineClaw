import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { openSqliteDatabase, type SqliteDatabase } from '../../infra/sqliteDatabase.js';
import type { EpisodeRecord } from '../contracts.js';
import type { EpisodeEnvelope, EpisodeObservation } from './contracts.js';

export interface EpisodeQuery {
  profileId: string;
  kind?: EpisodeRecord['kind'];
  state?: EpisodeRecord['state'];
  participantId?: string;
  locationRef?: string;
  from?: number;
  to?: number;
  limit?: number;
}

interface EpisodeRow {
  episode_id: string;
  profile_id: string;
  kind: EpisodeRecord['kind'];
  state: EpisodeRecord['state'];
  started_at: number;
  ended_at: number | null;
  correlation_id: string | null;
  task_id: string | null;
  location_ref: string | null;
  last_observed_at: number;
  episode_json: string;
}

export class EpisodeStore {
  private readonly db: SqliteDatabase;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.db = openSqliteDatabase(dbPath);
    this.initSchema();
  }

  get(episodeId: string): EpisodeEnvelope | null {
    const row = this.db.prepare('SELECT * FROM memory_episodes WHERE episode_id=?').get(episodeId) as EpisodeRow | undefined;
    return row ? rowToEnvelope(row) : null;
  }

  observationEpisode(observationId: string): string | null {
    const row = this.db.prepare('SELECT episode_id FROM memory_episode_observations WHERE observation_id=?')
      .get(observationId) as { episode_id: string } | undefined;
    return row?.episode_id ?? null;
  }

  saveObservation(envelope: EpisodeEnvelope, observation: EpisodeObservation): void {
    this.db.transaction(() => {
      this.upsert(envelope);
      this.db.prepare(`
        INSERT INTO memory_episode_observations(observation_id,episode_id,profile_id,observed_at)
        VALUES(?,?,?,?) ON CONFLICT(observation_id) DO NOTHING
      `).run(observation.observationId, envelope.episode.episodeId, observation.profileId, observation.timestamp);
    })();
  }

  listOpen(profileId?: string): EpisodeEnvelope[] {
    const rows = profileId
      ? this.db.prepare("SELECT * FROM memory_episodes WHERE profile_id=? AND state IN ('open','finalizing') ORDER BY started_at")
        .all(profileId) as EpisodeRow[]
      : this.db.prepare("SELECT * FROM memory_episodes WHERE state IN ('open','finalizing') ORDER BY started_at")
        .all() as EpisodeRow[];
    return rows.map(rowToEnvelope);
  }

  query(input: EpisodeQuery): EpisodeRecord[] {
    const clauses = ['e.profile_id=?'];
    const params: unknown[] = [input.profileId];
    if (input.kind) { clauses.push('e.kind=?'); params.push(input.kind); }
    if (input.state) { clauses.push('e.state=?'); params.push(input.state); }
    if (input.from != null) { clauses.push('COALESCE(e.ended_at,e.started_at)>=?'); params.push(input.from); }
    if (input.to != null) { clauses.push('e.started_at<=?'); params.push(input.to); }
    if (input.participantId) {
      clauses.push('EXISTS(SELECT 1 FROM memory_episode_participants p WHERE p.episode_id=e.episode_id AND p.participant_id=?)');
      params.push(input.participantId);
    }
    if (input.locationRef) {
      clauses.push('EXISTS(SELECT 1 FROM memory_episode_locations l WHERE l.episode_id=e.episode_id AND l.location_ref=?)');
      params.push(input.locationRef);
    }
    const rows = this.db.prepare(`
      SELECT e.* FROM memory_episodes e WHERE ${clauses.join(' AND ')}
      ORDER BY COALESCE(e.ended_at,e.started_at) DESC LIMIT ?
    `).all(...params, input.limit ?? 100) as EpisodeRow[];
    return rows.map(row => rowToEnvelope(row).episode);
  }

  count(profileId: string): number {
    return (this.db.prepare('SELECT COUNT(*) AS count FROM memory_episodes WHERE profile_id=?')
      .get(profileId) as { count: number }).count;
  }

  close(): void {
    this.db.close();
  }

  private upsert(envelope: EpisodeEnvelope): void {
    const episode = envelope.episode;
    this.db.prepare(`
      INSERT INTO memory_episodes
        (episode_id,profile_id,kind,state,started_at,ended_at,correlation_id,task_id,location_ref,last_observed_at,episode_json)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(episode_id) DO UPDATE SET
        state=excluded.state,ended_at=excluded.ended_at,correlation_id=excluded.correlation_id,
        task_id=excluded.task_id,location_ref=excluded.location_ref,
        last_observed_at=excluded.last_observed_at,episode_json=excluded.episode_json
    `).run(
      episode.episodeId, episode.profileId, episode.kind, episode.state, episode.startedAt,
      episode.endedAt ?? null, envelope.correlationId ?? null, envelope.taskId ?? null,
      envelope.locationRef ?? null, envelope.lastObservedAt, JSON.stringify(episode),
    );
    this.db.prepare('DELETE FROM memory_episode_participants WHERE episode_id=?').run(episode.episodeId);
    this.db.prepare('DELETE FROM memory_episode_locations WHERE episode_id=?').run(episode.episodeId);
    const participant = this.db.prepare('INSERT INTO memory_episode_participants(episode_id,profile_id,participant_id,kind) VALUES(?,?,?,?)');
    for (const item of episode.participants) participant.run(episode.episodeId, episode.profileId, item.id, item.kind);
    const location = this.db.prepare('INSERT INTO memory_episode_locations(episode_id,profile_id,location_ref) VALUES(?,?,?)');
    const refs = new Set<string>();
    if (envelope.locationRef) refs.add(envelope.locationRef);
    if (episode.environmentStart.nearestLandmark) refs.add(episode.environmentStart.nearestLandmark);
    for (const snapshot of episode.keySnapshots) if (snapshot.nearestLandmark) refs.add(snapshot.nearestLandmark);
    for (const ref of refs) location.run(episode.episodeId, episode.profileId, ref);
  }

  private initSchema(): void {
    this.db.exec(`
      PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS memory_episodes (
        episode_id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        state TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        correlation_id TEXT,
        task_id TEXT,
        location_ref TEXT,
        last_observed_at INTEGER NOT NULL,
        episode_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memory_episodes_profile_time
        ON memory_episodes(profile_id,started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_episodes_profile_kind_state
        ON memory_episodes(profile_id,kind,state);
      CREATE TABLE IF NOT EXISTS memory_episode_observations (
        observation_id TEXT PRIMARY KEY,
        episode_id TEXT NOT NULL REFERENCES memory_episodes(episode_id) ON DELETE CASCADE,
        profile_id TEXT NOT NULL,
        observed_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memory_episode_participants (
        episode_id TEXT NOT NULL REFERENCES memory_episodes(episode_id) ON DELETE CASCADE,
        profile_id TEXT NOT NULL,
        participant_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        PRIMARY KEY(episode_id,participant_id)
      );
      CREATE INDEX IF NOT EXISTS idx_episode_participant_lookup
        ON memory_episode_participants(profile_id,participant_id);
      CREATE TABLE IF NOT EXISTS memory_episode_locations (
        episode_id TEXT NOT NULL REFERENCES memory_episodes(episode_id) ON DELETE CASCADE,
        profile_id TEXT NOT NULL,
        location_ref TEXT NOT NULL,
        PRIMARY KEY(episode_id,location_ref)
      );
      CREATE INDEX IF NOT EXISTS idx_episode_location_lookup
        ON memory_episode_locations(profile_id,location_ref);
    `);
  }
}

function rowToEnvelope(row: EpisodeRow): EpisodeEnvelope {
  const episode = JSON.parse(row.episode_json) as EpisodeRecord;
  return {
    episode,
    ...(row.correlation_id ? { correlationId: row.correlation_id } : {}),
    ...(row.task_id ? { taskId: row.task_id } : {}),
    ...(row.location_ref ? { locationRef: row.location_ref } : {}),
    lastObservedAt: row.last_observed_at,
  };
}
