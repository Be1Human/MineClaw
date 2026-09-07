import type { WorldStateView } from '../types.js';

export interface HeartbeatCadenceConfig {
  idleIntervalMs: number;
  ownerVisibleIntervalMs: number;
  ownerThreatIntervalMs: number;
  ownerThreatRadius: number;
}

export interface HeartbeatCadenceInput {
  embodied: boolean;
  world: WorldStateView | null;
}

/** Pure policy: selects only the next observation delay, never starts work. */
export interface HeartbeatCadencePolicy {
  nextDelayMs(input: HeartbeatCadenceInput): number;
}

/**
 * The scheduler sees only generic owner observation and hostile entity contracts
 * already present in WorldStateView. It has no plugin or body dependency.
 */
export class OwnerThreatHeartbeatCadencePolicy implements HeartbeatCadencePolicy {
  constructor(private readonly readConfig: () => HeartbeatCadenceConfig) {}

  nextDelayMs(input: HeartbeatCadenceInput): number {
    const config = this.readConfig();
    if (!input.embodied || !input.world?.owner?.isVisible) {
      return positiveDelay(config.idleIntervalMs, 250);
    }

    const owner = input.world.owner.position;
    if (!owner) return positiveDelay(config.ownerVisibleIntervalMs, 100);
    const radius = positiveDelay(config.ownerThreatRadius, 12);
    const threatNearby = input.world.entities.some(entity => (
      entity.category === 'hostile'
      && distance3(entity.position, owner) <= radius
    ));

    return threatNearby
      ? positiveDelay(config.ownerThreatIntervalMs, 50)
      : positiveDelay(config.ownerVisibleIntervalMs, 100);
  }
}

function distance3(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function positiveDelay(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? Math.max(1, Math.round(value)) : fallback;
}
