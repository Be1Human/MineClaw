import { randomUUID } from 'node:crypto';
import type { WorldStateView } from '../../types.js';
import {
  GOAL_INTERACTION_SCHEMA_V1,
  type GoalInteractionMetaV1,
  type GoalNotificationV1,
} from './contracts.js';

export interface PerceptionAttentionGateConfig {
  episodeQuietMs?: number;
  updateIntervalMs?: number;
  maxNormalNotificationsPerWindow?: number;
  windowMs?: number;
  now?: () => number;
}

interface DangerEpisode {
  key: string;
  openedAt: number;
  lastObservedAt: number;
  lastEmittedAt: number;
  sequence: number;
  startHealth: number;
  currentHealth: number;
  damage: number;
}

/**
 * GoalAgent-owned admission gate. It is the only component allowed to turn raw
 * perception events into MainBrain-visible game experience.
 */
export class PerceptionAttentionGate {
  private readonly now: () => number;
  private readonly episodeQuietMs: number;
  private readonly updateIntervalMs: number;
  private readonly maxNormalNotificationsPerWindow: number;
  private readonly windowMs: number;
  private danger: DangerEpisode | null = null;
  private normalWindowStartedAt = 0;
  private normalWindowCount = 0;

  constructor(config: PerceptionAttentionGateConfig = {}) {
    this.now = config.now ?? Date.now;
    this.episodeQuietMs = config.episodeQuietMs ?? 8_000;
    this.updateIntervalMs = config.updateIntervalMs ?? 3_000;
    this.maxNormalNotificationsPerWindow = config.maxNormalNotificationsPerWindow ?? 3;
    this.windowMs = config.windowMs ?? 30_000;
  }

  onUnderAttack(
    payload: { prevHealth?: number; currHealth?: number; damage?: number },
    world: WorldStateView | null,
    evidenceRef: string,
  ): GoalNotificationV1 | null {
    const now = this.now();
    const currentHealth = finite(payload.currHealth) ?? world?.self.health ?? 0;
    const previousHealth = finite(payload.prevHealth) ?? currentHealth;
    const damage = Math.max(0, finite(payload.damage) ?? previousHealth - currentHealth);
    const startsNewEpisode = !this.danger || now - this.danger.lastObservedAt > this.episodeQuietMs;

    if (startsNewEpisode) {
      this.danger = {
        key: `danger-${randomUUID()}`,
        openedAt: now,
        lastObservedAt: now,
        lastEmittedAt: now,
        sequence: 1,
        startHealth: previousHealth,
        currentHealth,
        damage,
      };
      return this.dangerNotification('opened', world, evidenceRef);
    }

    const episode = this.danger!;
    episode.lastObservedAt = now;
    episode.currentHealth = Math.min(episode.currentHealth, currentHealth);
    episode.damage += damage;
    const criticalChange = currentHealth <= 6 || episode.startHealth - currentHealth >= 6;
    if (!criticalChange && now - episode.lastEmittedAt < this.updateIntervalMs) return null;
    episode.lastEmittedAt = now;
    episode.sequence += 1;
    return this.dangerNotification('updated', world, evidenceRef);
  }

  onDangerCleared(evidenceRef: string): GoalNotificationV1 | null {
    if (!this.danger) return null;
    const now = this.now();
    const episode = this.danger;
    episode.sequence += 1;
    const notification: GoalNotificationV1 = {
      meta: this.meta(episode.key, episode.sequence, now),
      eventType: 'danger',
      urgency: 'normal',
      attentionClass: 'critical',
      episodeKey: episode.key,
      state: 'resolved',
      summary: '威胁已经解除',
      delta: { durationMs: now - episode.openedAt, totalDamage: episode.damage },
      evidence: [{ type: 'world_snapshot', ref: evidenceRef, observedAt: new Date(now).toISOString() }],
    };
    this.danger = null;
    return notification;
  }

  /** Normal/low-value notifications share a bounded admission budget. */
  admitNormal(): boolean {
    const now = this.now();
    if (now - this.normalWindowStartedAt >= this.windowMs) {
      this.normalWindowStartedAt = now;
      this.normalWindowCount = 0;
    }
    if (this.normalWindowCount >= this.maxNormalNotificationsPerWindow) return false;
    this.normalWindowCount += 1;
    return true;
  }

  private dangerNotification(
    state: 'opened' | 'updated',
    world: WorldStateView | null,
    evidenceRef: string,
  ): GoalNotificationV1 {
    const episode = this.danger!;
    const hostiles = (world?.entities ?? [])
      .filter(entity => entity.category === 'hostile')
      .sort((left, right) => left.distance - right.distance);
    const nearest = hostiles[0];
    const threatTypes = [...new Set(hostiles.map(entity => entity.name))].slice(0, 3).join(',') || 'unknown';
    const now = this.now();
    return {
      meta: this.meta(episode.key, episode.sequence, now),
      eventType: 'danger',
      urgency: episode.currentHealth <= 6 || episode.damage >= 6 ? 'critical' : 'high',
      attentionClass: 'critical',
      episodeKey: episode.key,
      state,
      summary: `正在受到攻击：${threatTypes} × ${Math.max(1, hostiles.length)}`,
      delta: {
        threatTypes,
        threatCount: hostiles.length,
        nearestDistance: nearest ? Math.round(nearest.distance * 10) / 10 : -1,
        health: episode.currentHealth,
        healthDelta: episode.currentHealth - episode.startHealth,
      },
      evidence: [{ type: 'world_snapshot', ref: evidenceRef, observedAt: new Date(now).toISOString() }],
    };
  }

  private meta(correlationId: string, sequence: number, now: number): GoalInteractionMetaV1 {
    const messageId = `goal-notification-${randomUUID()}`;
    return {
      schema: GOAL_INTERACTION_SCHEMA_V1,
      messageId,
      correlationId,
      idempotencyKey: `${correlationId}:${sequence}`,
      sequence,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.episodeQuietMs * 2).toISOString(),
    };
  }
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
