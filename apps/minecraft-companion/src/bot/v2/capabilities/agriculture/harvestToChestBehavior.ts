import type { Vec3 } from '../../../adapter/types.js';
import type { AdaptiveBehaviorContext, AdaptiveBehavior } from '../../behavior/types.js';
import type { ActionRequest, Resource } from '../../types.js';
import type { HarvestWorldFactProvider } from './harvestWorldFactProvider.js';

const SOURCE = 'agriculture.harvest';

/** One idempotent capability action: harvest all mature crops, collect all drops, then deposit all harvest. */
export class HarvestMatureCropsToChestBehavior implements AdaptiveBehavior {
  readonly kind = 'adaptive' as const;
  readonly id = 'harvest_mature_crops_to_chest';
  private sequence = 0;

  constructor(
    private readonly facts: HarvestWorldFactProvider,
  ) {}

  async run(ctx: AdaptiveBehaviorContext) {
    const chestPos = finitePosition(ctx.taskParams?.chestPos);
    if (!chestPos) return { ok: false, error: 'harvest_chest_position_missing' };
    const params = {
      radius: boundedCount(ctx.taskParams?.radius, 32, 4, 64),
      limit: boundedCount(ctx.taskParams?.cropLimit, 128, 1, 256),
      dropLimit: boundedCount(ctx.taskParams?.dropLimit, 128, 1, 256),
    };
    const maxHarvestActions = boundedCount(ctx.taskParams?.maxHarvestActions, 256, 1, 512);
    const maxPickupActions = boundedCount(ctx.taskParams?.maxPickupActions, 256, 1, 512);
    let harvested = 0;
    let pickups = 0;

    for (; harvested < maxHarvestActions; harvested++) {
      const fact = this.observe(ctx, params);
      if ('error' in fact) return { ok: false, error: fact.error, details: { harvested, pickups } };
      const crop = fact.value.matureCrops[0];
      if (!crop) break;
      const id = this.actionId('crop');
      const approached = await ctx.execute(action(
        `${id}-approach`, 'move_to', { position: crop.position, range: 0.1 }, ['movement'], 15_000,
      ));
      if (!approached.ok) return failed(approached.error ?? 'harvest_approach_failed', harvested, pickups);
      const dug = await ctx.execute(action(
        `${id}-dig`, 'dig', { position: crop.position }, ['movement', 'vision'], 8_000,
      ));
      if (!dug.ok) return failed(dug.error ?? 'harvest_dig_failed', harvested, pickups);
      // Move between the crop and the owner immediately, before Minecraft's
      // pickup delay expires. Seeds can scatter toward a nearby player even
      // when the Bot dug from the crop center; this interception step keeps
      // the Bot closer to task-owned drops throughout the delay window.
      const claimed = await ctx.execute(action(
        `${id}-claim-drops`, 'move_to', {
          position: interceptionPosition(crop.position, ctx.getWorld().owner?.position),
          range: 0.1,
        }, ['movement', 'inventory'], 8_000,
      ));
      if (!claimed.ok) return failed(claimed.error ?? 'harvest_drop_claim_failed', harvested + 1, pickups);
      await ctx.wait(550);
      const collected = await this.collectVisibleDrops(ctx, params, pickups, maxPickupActions);
      if (!collected.ok) return failed(collected.error, harvested + 1, collected.pickups, collected.details);
      pickups = collected.pickups;
    }

    const afterHarvest = this.observe(ctx, params);
    if ('error' in afterHarvest) return { ok: false, error: afterHarvest.error, details: { harvested, pickups } };
    if (afterHarvest.value.matureCrops.length > 0) {
      return failed('harvest_action_limit_exhausted', harvested, pickups, {
        remainingMature: afterHarvest.value.matureCrops.length, maxHarvestActions,
      });
    }
    if (harvested < 1) return failed('no_mature_crops_observed', harvested, pickups);

    await ctx.wait(650);
    const swept = await this.collectVisibleDrops(ctx, params, pickups, maxPickupActions);
    if (!swept.ok) return failed(swept.error, harvested, swept.pickups, swept.details);
    pickups = swept.pickups;

    const beforeDeposit = this.observe(ctx, params);
    if ('error' in beforeDeposit) return { ok: false, error: beforeDeposit.error, details: { harvested, pickups } };
    if (beforeDeposit.value.groundDrops.length > 0) {
      return failed('harvest_pickup_limit_exhausted', harvested, pickups, {
        remainingDrops: beforeDeposit.value.groundDrops.length, maxPickupActions,
      });
    }
    const items = harvestItems(beforeDeposit.value.inventory);
    if (items.length === 0) return failed('harvest_inventory_empty', harvested, pickups);

    const storeId = this.actionId('store');
    const approachedChest = await ctx.execute(action(
      `${storeId}-approach`, 'move_to', { position: chestPos, range: 2 }, ['movement'], 15_000,
    ));
    if (!approachedChest.ok) return failed(approachedChest.error ?? 'harvest_chest_approach_failed', harvested, pickups);
    let deposited = 0;
    for (const item of items) {
      const receipt = await ctx.execute(action(
        `${storeId}-deposit-${item.item}`, 'deposit',
        { position: chestPos, itemName: item.item, count: item.count }, ['inventory'], 8_000,
      ));
      if (!receipt.ok) return failed(receipt.error ?? `harvest_deposit_failed:${item.item}`, harvested, pickups, { deposited });
      deposited += item.count;
    }

    ctx.publish('behavior.harvest_mature_crops_to_chest.success', 'info', {
      harvested, pickups, deposited, chestPos, items,
    });
    return { ok: true, details: { harvested, pickups, deposited, chestPos, items } };
  }

  private observe(ctx: AdaptiveBehaviorContext, params: Record<string, unknown>) {
    const fact = this.facts.observe({ world: ctx.getWorld(), params });
    return fact.complete && !fact.truncated ? fact : { error: 'harvest_world_fact_truncated' as const };
  }

  private async collectVisibleDrops(
    ctx: AdaptiveBehaviorContext,
    params: Record<string, unknown>,
    initialPickups: number,
    maxPickupActions: number,
  ): Promise<{ ok: true; pickups: number } | {
    ok: false; error: string; pickups: number; details?: Record<string, unknown>;
  }> {
    let pickups = initialPickups;
    while (pickups < maxPickupActions) {
      const fact = this.observe(ctx, params);
      if ('error' in fact) return { ok: false, error: fact.error, pickups };
      const drop = fact.value.groundDrops[0];
      if (!drop) return { ok: true, pickups };
      const moved = await ctx.execute(action(
        this.actionId('pickup'), 'move_to', { position: drop.position, range: 0.25 }, ['movement', 'inventory'], 8_000,
      ));
      pickups += 1;
      if (!moved.ok) return { ok: false, error: moved.error ?? 'harvest_pickup_failed', pickups };
      await ctx.wait(250);
    }
    const remaining = this.observe(ctx, params);
    if ('error' in remaining) return { ok: false, error: remaining.error, pickups };
    return remaining.value.groundDrops.length === 0
      ? { ok: true, pickups }
      : {
          ok: false,
          error: 'harvest_pickup_limit_exhausted',
          pickups,
          details: { remainingDrops: remaining.value.groundDrops.length, maxPickupActions },
        };
  }

  private actionId(stage: string): string {
    return `${SOURCE}-${stage}-${Date.now()}-${++this.sequence}`;
  }
}

function action(
  id: string,
  type: ActionRequest['type'],
  target: NonNullable<ActionRequest['target']>,
  resource: Resource[],
  timeoutMs: number,
): ActionRequest {
  return {
    id, source: SOURCE, type, priority: 34, interrupt_level: 'soft', resource,
    target, preconditions: [], timeout_ms: timeoutMs,
  };
}

function harvestItems(inventory: Readonly<Record<'wheat' | 'wheat_seeds', number>>): Array<{
  item: 'wheat' | 'wheat_seeds'; count: number;
}> {
  return (['wheat', 'wheat_seeds'] as const)
    .map(item => ({ item, count: Math.floor(inventory[item]) }))
    .filter(item => item.count > 0);
}

function finitePosition(value: unknown): Vec3 | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (![record.x, record.y, record.z].every(part => typeof part === 'number' && Number.isFinite(part))) return null;
  return { x: record.x as number, y: record.y as number, z: record.z as number };
}

function interceptionPosition(crop: Vec3, owner: Vec3 | null | undefined): Vec3 {
  if (!owner) return crop;
  const dx = owner.x - crop.x;
  const dz = owner.z - crop.z;
  const horizontal = Math.sqrt(dx * dx + dz * dz);
  if (!Number.isFinite(horizontal) || horizontal < 0.001) return crop;
  const offset = Math.min(0.75, horizontal / 2);
  return {
    x: crop.x + (dx / horizontal) * offset,
    y: crop.y,
    z: crop.z + (dz / horizontal) * offset,
  };
}

function boundedCount(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(min, Math.min(max, Math.floor(value)))
    : fallback;
}

function failed(error: string, harvested: number, pickups: number, details: Record<string, unknown> = {}) {
  return { ok: false, error, details: { harvested, pickups, ...details } };
}
