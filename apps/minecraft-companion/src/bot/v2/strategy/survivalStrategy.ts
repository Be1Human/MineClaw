/**
 * Generic survival fallback.
 *
 * This strategy owns neither a task nor a body lease. It can only propose closed
 * atomic requests for the task that is already running, and Heartbeat rejects
 * every proposal without that normal task backing. A plugin Activity which
 * declares hostile-hazard handling is routed ahead of this fallback.
 */

import type { TuningConfig } from '../infra/tuning.js';
import { tuning } from '../infra/tuning.js';
import type { ActionRequest, EntityView } from '../types.js';
import type { IStrategy, StrategyContext, StrategyInspect } from './types.js';

export type SurvivalPolicy = TuningConfig['survival'];

const PASSIVE_UNLESS_PROVOKED = new Set(['enderman']);
const FOOD_NAMES = new Set([
  'bread', 'apple', 'golden_apple', 'enchanted_golden_apple',
  'cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton',
  'cooked_rabbit', 'cooked_cod', 'cooked_salmon',
  'baked_potato', 'carrot', 'golden_carrot', 'beetroot',
  'melon_slice', 'sweet_berries', 'glow_berries', 'dried_kelp',
  'mushroom_stew', 'rabbit_stew', 'beetroot_soup', 'pumpkin_pie',
  'cookie', 'honey_bottle',
]);
const EMERGENCY_FOOD_NAMES = new Set(['golden_apple', 'enchanted_golden_apple']);

export class SurvivalStrategy implements IStrategy {
  readonly id = 'survival_strategy';
  readonly kind = 'rule' as const;

  private seq = 0;
  private lastSayAt = 0;
  private lastMode = 'idle';
  private fleeStuckTicks = 0;
  private lastNearest = Infinity;

  constructor(
    private readonly getPolicy: () => Readonly<SurvivalPolicy> = () => tuning().survival,
  ) {}

  /** A fallback cannot manufacture work: it requires a current task to back it. */
  isActive(ctx: StrategyContext): boolean {
    return ctx.activeTaskId != null;
  }

  tick(ctx: StrategyContext): ActionRequest[] {
    if (!ctx.activeTaskId) {
      this.lastMode = 'unbacked';
      return [];
    }

    const policy = this.getPolicy();
    const dangerous = this.dangerousHostiles(ctx, policy);
    const nearest = dangerous[0] ?? null;
    const nearestDistance = nearest?.distance ?? Infinity;
    const health = ctx.world.self.health;
    const food = ctx.world.self.food;
    const hasEmergencyFood = this.hasEmergencyFood(ctx);
    const hasFood = this.hasFood(ctx);

    const inDanger = nearestDistance <= policy.dangerRange;
    if (inDanger && nearestDistance >= this.lastNearest - policy.corneredNoGain) {
      this.fleeStuckTicks += 1;
    } else if (!inDanger) {
      this.fleeStuckTicks = 0;
    }
    this.lastNearest = nearestDistance;
    const cornered = nearest != null && this.fleeStuckTicks >= policy.corneredTicks;

    // Golden apples are a real recovery item even when hunger is full. Prefer one
    // first whenever health is critical, rather than falsely claiming a normal
    // food consumption will immediately restore hearts.
    if (health <= policy.criticalHealth && hasEmergencyFood) {
      this.lastMode = 'eat_emergency';
      this.maybeNarrate(ctx, 'low_health', 95, policy, { health: Math.round(health) });
      return [this.eat(ctx, true, policy)];
    }

    // Normal food replenishes hunger for natural regeneration. It is only safe to
    // start while no hostile is at the configured close range.
    const canEatNormally = hasFood && nearestDistance > policy.safeEatDistance;
    if (
      canEatNormally && (
        (health < policy.eatHealth && food < 20) ||
        food <= policy.hungerEatFood
      )
    ) {
      this.lastMode = health < policy.eatHealth ? 'eat_recovery' : 'eat_hunger';
      return [this.eat(ctx, false, policy)];
    }

    if (!nearest || !inDanger) {
      this.lastMode = 'idle';
      return [];
    }

    // A lone close threat may be handled with one closed atomic attack. If escape
    // is no longer making progress, the same bounded response avoids an infinite
    // move loop while still preserving the active task's execution authority.
    if (
      (health > policy.fightHealth || cornered) &&
      nearestDistance <= policy.fightRange &&
      this.hasSword(ctx) &&
      this.crowdCount(dangerous, policy.fightCrowdRange) <= 1
    ) {
      this.lastMode = cornered ? 'attack_cornered' : 'attack';
      this.maybeNarrate(ctx, 'danger_fight', 90, policy, { mob: describeMob(nearest.name) });
      return [this.attack(ctx, nearest.id, policy)];
    }

    this.lastMode = health <= policy.criticalHealth ? 'retreat_critical' : 'retreat';
    this.maybeNarrate(
      ctx,
      health <= policy.criticalHealth ? 'low_health' : 'danger_flee',
      health <= policy.criticalHealth ? 95 : 90,
      policy,
      { mob: describeMob(nearest.name), health: Math.round(health) },
    );
    return [this.retreat(ctx, nearest, policy)];
  }

  reset(): void {
    this.seq = 0;
    this.lastSayAt = 0;
    this.lastMode = 'idle';
    this.fleeStuckTicks = 0;
    this.lastNearest = Infinity;
  }

  /** No task exists to cancel—this only drops in-memory fallback observations. */
  suspend(): void {
    this.reset();
  }

  inspect(): StrategyInspect {
    return { kind: 'rule', view: { mode: this.lastMode, ownsTask: false } };
  }

  private dangerousHostiles(ctx: StrategyContext, policy: Readonly<SurvivalPolicy>): EntityView[] {
    return ctx.world.entities
      .filter(entity => entity.category === 'hostile')
      .filter(entity => !PASSIVE_UNLESS_PROVOKED.has(normalizeMob(entity.name)))
      .filter(entity => entity.distance <= policy.dangerRange)
      .sort((left, right) => left.distance - right.distance);
  }

  private crowdCount(hostiles: readonly EntityView[], range: number): number {
    return hostiles.filter(hostile => hostile.distance <= range).length;
  }

  private hasFood(ctx: StrategyContext): boolean {
    return ctx.world.inventory.items.some(item => FOOD_NAMES.has(item.name) && item.count > 0);
  }

  private hasEmergencyFood(ctx: StrategyContext): boolean {
    return ctx.world.inventory.items.some(item => EMERGENCY_FOOD_NAMES.has(item.name) && item.count > 0);
  }

  private hasSword(ctx: StrategyContext): boolean {
    return ctx.world.inventory.items.some(item => item.name.endsWith('_sword') && item.count > 0);
  }

  private eat(ctx: StrategyContext, emergency: boolean, policy: Readonly<SurvivalPolicy>): ActionRequest {
    return {
      id: `${this.id}-eat-${ctx.tick}-${++this.seq}`,
      source: emergency ? `${this.id}.emergency_eat` : `${this.id}.eat`,
      type: 'eat',
      priority: emergency ? 96 : 88,
      interrupt_level: emergency ? 'hard' : 'soft',
      resource: ['inventory'],
      target: { emergency },
      preconditions: [],
      expected_effect: emergency ? ['health_recovery_started'] : ['hunger_restored'],
      timeout_ms: policy.eatTimeoutMs,
    };
  }

  private attack(ctx: StrategyContext, entityId: number, policy: Readonly<SurvivalPolicy>): ActionRequest {
    return {
      id: `${this.id}-attack-${ctx.tick}-${++this.seq}`,
      source: `${this.id}.attack`,
      type: 'attack',
      priority: 94,
      interrupt_level: 'hard',
      resource: ['movement', 'vision'],
      target: { entityId },
      preconditions: [],
      expected_effect: ['hostile_damaged'],
      timeout_ms: policy.attackTimeoutMs,
    };
  }

  private retreat(ctx: StrategyContext, hostile: EntityView, policy: Readonly<SurvivalPolicy>): ActionRequest {
    const self = ctx.world.self.position;
    const dx = self.x - hostile.position.x;
    const dz = self.z - hostile.position.z;
    const horizontal = Math.hypot(dx, dz);
    const unitX = horizontal > 0 ? dx / horizontal : Math.cos(ctx.world.self.yaw);
    const unitZ = horizontal > 0 ? dz / horizontal : Math.sin(ctx.world.self.yaw);
    return {
      id: `${this.id}-retreat-${ctx.tick}-${++this.seq}`,
      source: `${this.id}.retreat`,
      type: 'move_to',
      priority: 92,
      interrupt_level: 'hard',
      resource: ['movement'],
      target: {
        position: {
          x: self.x + unitX * policy.fleeDistance,
          y: self.y,
          z: self.z + unitZ * policy.fleeDistance,
        },
      },
      preconditions: [],
      expected_effect: ['safe_distance'],
      timeout_ms: policy.fleeTimeoutMs,
    };
  }

  private maybeNarrate(
    ctx: StrategyContext,
    topic: string,
    urgency: number,
    policy: Readonly<SurvivalPolicy>,
    data?: Record<string, unknown>,
  ): void {
    const now = Date.now();
    if (now - this.lastSayAt < policy.sayCooldownMs) return;
    this.lastSayAt = now;
    ctx.narrate?.({ source: 'survival', topic, urgency, data });
  }
}

function normalizeMob(name: string): string {
  return name.toLowerCase();
}

function describeMob(name: string): string {
  const normalized = normalizeMob(name);
  if (normalized.includes('creeper')) return '苦力怕';
  if (normalized.includes('zombie')) return '僵尸';
  if (normalized.includes('skeleton')) return '骷髅';
  if (normalized.includes('spider')) return '蜘蛛';
  if (normalized.includes('witch')) return '女巫';
  if (normalized.includes('enderman')) return '末影人';
  return '怪';
}
