import type { ActionRequest } from '../types.js';
import type { BehaviorContext, SequenceBehavior } from './types.js';

/** Approach one grounded item entity; Minecraft performs the actual pickup. */
export class PickupGroundItemBehavior implements SequenceBehavior {
  readonly kind = 'sequence' as const;
  readonly id = 'pickup_ground_item';
  private sequence = 0;

  compile(ctx: BehaviorContext): ActionRequest[] {
    const params = ctx.taskParams ?? {};
    const position = finitePosition(params.position);
    const item = typeof params.item === 'string' ? params.item.trim() : '';
    const entityId = typeof params.itemEntityId === 'number' && Number.isFinite(params.itemEntityId)
      ? params.itemEntityId
      : null;
    if (!position || !item || entityId === null) return [];

    const distance = Math.hypot(
      position.x - ctx.world.self.position.x,
      position.y - ctx.world.self.position.y,
      position.z - ctx.world.self.position.z,
    );
    return [{
      id: `pickup-ground-item-${Date.now()}-${++this.sequence}`,
      source: this.id,
      type: 'move_to',
      priority: 30,
      interrupt_level: 'soft',
      resource: ['movement', 'inventory'],
      target: { position },
      preconditions: [],
      expected_effect: [`inventory_gained:${item}`],
      timeout_ms: Math.max(8_000, Math.min(20_000, 6_000 + Math.ceil(distance * 500))),
    }];
  }
}

function finitePosition(value: unknown): { x: number; y: number; z: number } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (![candidate.x, candidate.y, candidate.z].every(part => typeof part === 'number' && Number.isFinite(part))) {
    return null;
  }
  return { x: candidate.x as number, y: candidate.y as number, z: candidate.z as number };
}
