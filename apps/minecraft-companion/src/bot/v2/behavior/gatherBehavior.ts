/**
 * L4 GatherBehavior · 采集一个方块（含拾取）
 *
 * id: 'gather_block'
 *
 * 由 GatherStrategy 每个采集周期调用一次。taskParams 提供目标方块坐标与可接受产物。
 * 这是自适应 Behavior：挖掘后等待 Minecraft 拾取延迟，并用新鲜背包快照验真；
 * 若掉落物仍在地面，只做短距拾取重试。库存没有真实增加时必须失败，不能让上层误入远距探索。
 */

import type { AdaptiveBehaviorContext, AdaptiveBehavior, BehaviorContext } from './types.js';
import type { ActionRequest } from '../types.js';
import type { Vec3 } from '../../adapter/types.js';
import { bestToolForBlock } from '../knowledge/recipeResolver.js';

export class GatherBehavior implements AdaptiveBehavior {
  readonly kind = 'adaptive' as const;
  readonly id = 'gather_block';
  private seq = 0;


  async run(ctx: AdaptiveBehaviorContext) {
    const params = ctx.taskParams ?? {};
    const pos = params.pos as Vec3 | undefined;
    if (!pos || typeof pos.x !== 'number' || typeof pos.y !== 'number' || typeof pos.z !== 'number') {
      return { ok: false, error: 'gather_target_missing' };
    }
    const blockName = typeof params.blockName === 'string' ? params.blockName : '';
    const acceptedItems = normalizeAcceptedItems(params.acceptedItems, blockName);
    if (acceptedItems.length === 0) return { ok: false, error: 'gather_expected_item_missing' };

    const initial = ctx.getWorld();
    const before = inventoryCount(initial, acceptedItems);
    const requiredTool = normalizeToolName(params.toolName);
    const best = requiredTool || bestToolForBlock(blockName, initial.inventory);
    const id = `gather-block-${Date.now()}-${++this.seq}`;
    if (best) {
      const equipped = await ctx.execute(action(`${id}-equip`, 'equip', { itemName: best }, 3_000));
      if (!equipped.ok) return { ok: false, error: equipped.error ?? 'gather_equip_failed' };
    }

    const self = initial.self.position;
    const distance = Math.hypot(pos.x - self.x, pos.y - self.y, pos.z - self.z);
    const approached = await ctx.execute(action(
      `${id}-approach`,
      'move_to',
      { position: pos },
      Math.max(9_000, Math.min(20_000, 6_000 + Math.ceil(distance * 400))),
    ));
    if (!approached.ok) return { ok: false, error: approached.error ?? 'gather_approach_failed' };

    const dug = await ctx.execute(action(`${id}-dig`, 'dig', { position: pos }, 12_000));
    if (!dug.ok) return { ok: false, error: dug.error ?? 'gather_dig_failed' };

    // Vanilla 掉落物有短暂 pickup delay。先留在原地等它可拾取，避免同毫秒离开现场。
    await ctx.wait(650);
    for (let attempt = 0; attempt < 3; attempt++) {
      const world = ctx.getWorld();
      const after = inventoryCount(world, acceptedItems);
      if (after > before) {
        ctx.publish('behavior.gather_block.success', 'info', {
          blockName, acceptedItems, before, after, attempts: attempt,
        });
        return { ok: true, details: { blockName, acceptedItems, before, after } };
      }
      const drop = nearestMatchingDrop(world, acceptedItems);
      if (drop) {
        const pickup = await ctx.execute(action(
          `${id}-pickup-${attempt + 1}`,
          'move_to',
          { position: drop.position, range: 0.5 },
          4_000,
          'gather_block_pickup',
        ));
        if (!pickup.ok) {
          ctx.publish('behavior.gather_block.pickup_retry', 'recoverable', {
            blockName, attempt: attempt + 1, error: pickup.error ?? 'pickup_move_failed',
          });
        }
      }
      await ctx.wait(350);
    }

    const after = inventoryCount(ctx.getWorld(), acceptedItems);
    ctx.publish('behavior.gather_block.fail', 'recoverable', {
      blockName, acceptedItems, before, after, reason: 'pickup_unverified',
    });
    return {
      ok: false,
      error: `gather_pickup_unverified:${acceptedItems.join('|')}`,
      details: { blockName, acceptedItems, before, after },
    };
  }
}

function normalizeAcceptedItems(value: unknown, blockName: string): string[] {
  const raw = Array.isArray(value) ? value : [blockName];
  return [...new Set(raw.filter((item): item is string => typeof item === 'string' && item.length > 0))];
}

function inventoryCount(world: ReturnType<AdaptiveBehaviorContext['getWorld']>, acceptedItems: string[]): number {
  const accepted = new Set(acceptedItems);
  return world.inventory.items.reduce((sum, item) => sum + (accepted.has(item.name) ? item.count : 0), 0);
}

function nearestMatchingDrop(
  world: ReturnType<AdaptiveBehaviorContext['getWorld']>,
  acceptedItems: string[],
) {
  const accepted = new Set(acceptedItems);
  return world.entities
    .filter(entity => entity.category === 'item' && entity.droppedItem && accepted.has(entity.droppedItem.name))
    .sort((a, b) => a.distance - b.distance)[0];
}

const EMPTY_HAND_ALIASES = new Set([
  'hand', 'empty_hand', 'bare_hand', 'none', 'no_tool', 'air',
  '空手', '徒手', '无工具',
]);

function normalizeToolName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  return normalized && !EMPTY_HAND_ALIASES.has(normalized) ? normalized : undefined;
}

function action(
  id: string,
  type: ActionRequest['type'],
  target: NonNullable<ActionRequest['target']>,
  timeoutMs: number,
  source = 'gather_block',
): ActionRequest {
  return {
    id, source, type, priority: 30, interrupt_level: 'soft',
    resource: ['movement', 'inventory'], target, preconditions: [], timeout_ms: timeoutMs,
  };
}
