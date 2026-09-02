/**
 * L4 CombatBehavior · 近战打怪技能
 *
 * id: 'combat'
 *
 * 每个短动作后重读世界；等待和子动作均由所属操作控制取消。
 *
 * params:
 *   targetEntityId: number         — 要攻击的实体 id
 *   retreatHealthThreshold?: number — 撤退血量阈值（默认 4，暂由调用方检查）
 *
 * 武器优先级（高 → 低）：剑优先，其次斧；没有武器时允许空手。
 */

import type {
  AdaptiveBehavior,
  AdaptiveBehaviorContext,
  AdaptiveBehaviorResult,
} from './types.js';
import type { ActionRequest, EntityView, WorldStateView } from '../types.js';

const SOURCE = 'combat_skill';

/** 武器优先级列表（下标越小越好） */
const WEAPON_PRIORITY = [
  'netherite_sword',
  'diamond_sword',
  'iron_sword',
  'stone_sword',
  'golden_sword',
  'wooden_sword',
  'netherite_axe',
  'diamond_axe',
  'iron_axe',
  'stone_axe',
  'golden_axe',
  'wooden_axe',
] as const;

const FOODS = new Set([
  'bread', 'apple', 'golden_apple', 'enchanted_golden_apple',
  'cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton',
  'cooked_rabbit', 'cooked_cod', 'cooked_salmon', 'baked_potato',
  'carrot', 'golden_carrot', 'beetroot', 'melon_slice', 'sweet_berries',
  'glow_berries', 'dried_kelp', 'mushroom_stew', 'rabbit_stew',
  'beetroot_soup', 'pumpkin_pie', 'cookie', 'honey_bottle',
]);

const MAX_DURATION_MS = 30_000;
const MAX_ITERATIONS = 80;
const LOW_HEALTH = 8;
const CRITICAL_HEALTH = 4;
const SAFE_EAT_DISTANCE = 6;
const APPROACH_DISTANCE = 3.4;
const KITE_DISTANCE = 2.2;
const ATTACK_COOLDOWN_MS = 650;

/** 从背包找最优武器名；找不到返回 null */
function pickBestWeapon(items: { name: string }[]): string | null {
  let best: string | null = null;
  let bestRank = Infinity;
  for (const item of items) {
    const rank = WEAPON_PRIORITY.indexOf(item.name as (typeof WEAPON_PRIORITY)[number]);
    if (rank !== -1 && rank < bestRank) {
      bestRank = rank;
      best = item.name;
    }
  }
  return best;
}

export class CombatBehavior implements AdaptiveBehavior {
  readonly kind = 'adaptive' as const;
  readonly id = 'combat';

  async run(ctx: AdaptiveBehaviorContext): Promise<AdaptiveBehaviorResult> {
    const startedAt = Date.now();
    const requestedId = asPositiveInteger(ctx.taskParams?.targetEntityId);
    const requestedName = normalizeEntityName(
      ctx.taskParams?.targetEntityName
        ?? ctx.taskParams?.entityName
        ?? ctx.taskParams?.targetName,
    );
    const clearArea = ctx.taskParams?.clearArea === true || requestedId == null;
    let inferredName = requestedName;
    let emptySnapshots = 0;
    let attacks = 0;
    let moves = 0;
    let eats = 0;
    let equipped: string | null = null;

    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
      if (Date.now() - startedAt >= MAX_DURATION_MS) {
        return {
          ok: false,
          error: 'combat_timeout: threats remain after execution budget',
          details: { attacks, moves, eats, iteration },
        };
      }

      const world = ctx.getWorld();
      if (!inferredName && requestedId != null) {
        inferredName = normalizeEntityName(world.entities.find(entity => entity.id === requestedId)?.name);
      }
      const targets = selectTargets(world, {
        requestedId,
        requestedName: inferredName,
        clearArea,
      });
      const target = targets[0];
      if (!target) {
        emptySnapshots++;
        if (emptySnapshots >= 2) {
          return {
            ok: true,
            details: { cleared: true, attacks, moves, eats, emptySnapshots },
          };
        }
        await ctx.wait(150);
        continue;
      }
      emptySnapshots = 0;

      const food = pickFood(world);
      if (world.self.health <= LOW_HEALTH) {
        if (target.distance > SAFE_EAT_DISTANCE && food && world.self.food < 20) {
          const result = await ctx.execute(this.request('eat', {
            itemName: food,
          }, ['inventory'], 74, 3500));
          if (!result.ok) return failedAction(result.error, 'eat', { attacks, moves, eats });
          eats++;
          ctx.publish('behavior.combat.recover', 'info', {
            health: world.self.health,
            food: world.self.food,
            item: food,
          });
          continue;
        }
        // A full hunger bar is already the recovery resource Minecraft uses for
        // natural regeneration. Keep the target at a safe distance and let the
        // next world snapshot observe health recovery instead of retrying eat.
        if (target.distance > SAFE_EAT_DISTANCE && world.self.food >= 20) {
          await ctx.wait(750);
          continue;
        }
        if (target.distance <= SAFE_EAT_DISTANCE) {
          const retreat = retreatPosition(world, target, 8);
          const result = await ctx.execute(this.request('move_to', {
            position: retreat,
          }, ['movement'], 78, 6000));
          if (!result.ok) return failedAction(result.error, 'retreat', { attacks, moves, eats });
          moves++;
          continue;
        }
        if (world.self.health <= CRITICAL_HEALTH && !food) {
          return {
            ok: false,
            error: 'bot_critical_no_recovery: no food available at safe distance',
            details: { attacks, moves, eats, health: world.self.health },
          };
        }
      }

      const bestWeapon = pickBestWeapon(world.inventory.items);
      const heldWeapon = world.inventory.held?.name ?? null;
      if (bestWeapon && heldWeapon !== bestWeapon && equipped !== bestWeapon) {
        const result = await ctx.execute(this.request('equip', {
          itemName: bestWeapon,
        }, ['inventory'], 68, 2000));
        if (!result.ok) return failedAction(result.error, 'equip', { attacks, moves, eats });
        equipped = bestWeapon;
        continue;
      }

      if (target.distance > APPROACH_DISTANCE) {
        const result = await ctx.execute(this.request('move_to', {
          entityId: target.id,
        }, ['movement'], 70, 8000));
        if (!result.ok) return failedAction(result.error, 'approach', { attacks, moves, eats });
        moves++;
        continue;
      }

      const attackType = target.distance < KITE_DISTANCE ? 'kite' : 'attack';
      const result = await ctx.execute(this.request(attackType, {
        entityId: target.id,
        ...(attackType === 'kite' ? { backDurationMs: 650 } : {}),
      }, ['movement', 'vision'], 72, 1600));
      if (!result.ok) {
        // Entity disappearance after target selection is a normal kill/despawn race.
        if (result.error?.includes('target not found') || result.error?.includes('target_not_found')) {
          continue;
        }
        // Automatic defense may kill the target while this combat action is being
        // cancelled or preempted. Re-read the world before propagating a stale
        // motor/iteration error, otherwise the root goal is reported as failed
        // even though its entity-dead criterion is already satisfied.
        const refreshedTargets = selectTargets(ctx.getWorld(), {
          requestedId,
          requestedName: inferredName,
          clearArea,
        });
        if (refreshedTargets.length === 0) {
          return {
            ok: true,
            details: { cleared: true, attacks, moves, eats, recoveredAfterFailure: true },
          };
        }
        return failedAction(result.error, attackType, { attacks, moves, eats });
      }
      attacks++;
      ctx.publish('behavior.combat.attack', 'info', {
        entityId: target.id,
        entityName: target.name,
        action: attackType,
        attacks,
      });
      if (attackType === 'attack') await ctx.wait(ATTACK_COOLDOWN_MS);
    }

    return {
      ok: false,
      error: 'combat_iteration_budget_exhausted',
      details: { attacks, moves, eats, maxIterations: MAX_ITERATIONS },
    };
  }

  private request(
    type: ActionRequest['type'],
    target: NonNullable<ActionRequest['target']>,
    resource: ActionRequest['resource'],
    priority: number,
    timeoutMs: number,
  ): ActionRequest {
    return {
      id: `${SOURCE}-${type}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      source: SOURCE,
      type,
      priority,
      interrupt_level: 'hard',
      resource,
      target,
      preconditions: [],
      timeout_ms: timeoutMs,
    };
  }
}

function selectTargets(
  world: WorldStateView,
  selector: { requestedId: number | null; requestedName: string | null; clearArea: boolean },
): EntityView[] {
  return world.entities
    .filter(entity => entity.category === 'hostile')
    .filter(entity => {
      if (!selector.clearArea && selector.requestedId != null) return entity.id === selector.requestedId;
      if (selector.requestedName) return normalizeEntityName(entity.name) === selector.requestedName;
      return true;
    })
    .sort((left, right) => left.distance - right.distance);
}

function normalizeEntityName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase().replace(/^minecraft:/, '');
  return normalized || null;
}

function asPositiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

function pickFood(world: WorldStateView): string | null {
  return world.inventory.items.find(item => item.count > 0 && FOODS.has(item.name))?.name ?? null;
}

function retreatPosition(world: WorldStateView, target: EntityView, distance: number): { x: number; y: number; z: number } {
  const dx = world.self.position.x - target.position.x;
  const dz = world.self.position.z - target.position.z;
  const length = Math.hypot(dx, dz);
  const nx = length > 0.01 ? dx / length : 1;
  const nz = length > 0.01 ? dz / length : 0;
  return {
    x: world.self.position.x + nx * distance,
    y: world.self.position.y,
    z: world.self.position.z + nz * distance,
  };
}

function failedAction(
  error: string | undefined,
  action: string,
  details: Record<string, unknown>,
): AdaptiveBehaviorResult {
  return {
    ok: false,
    error: `combat_${action}_failed: ${error ?? 'unknown error'}`,
    details,
  };
}
