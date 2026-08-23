import type { Vec3 } from '../../adapter/types.js';
import type { ActionRequest } from '../types.js';
import type { AdaptiveBehaviorContext, IBehavior } from './types.js';

export type PlacementRelation = 'near' | 'right' | 'front' | 'at';
export type PlacementSurface = 'ground' | 'top';
export type PlacementReference = 'owner' | 'self';

/** Place one inventory block at a deterministic cell relative to the requested actor. */
export class PlaceRelativeBehavior implements IBehavior {
  readonly id = 'place_relative';
  private sequence = 0;

  plan(): ActionRequest[] { return []; }

  async run(ctx: AdaptiveBehaviorContext) {
    const world = ctx.getWorld();
    const params = ctx.taskParams ?? {};
    const item = typeof params.item === 'string' ? params.item : '';
    const relativeTo: PlacementReference = params.relativeTo === 'self' ? 'self' : 'owner';
    const relation = isRelation(params.relation) ? params.relation : 'near';
    const surface: PlacementSurface = params.surface === 'top' ? 'top' : 'ground';
    const reference = relativeTo === 'self'
      ? { position: world.self.position, yaw: world.self.yaw }
      : world.owner;
    if (!item || !reference?.position || !finite(reference.position)) {
      return { ok: false, error: `placement_${relativeTo}_or_item_missing` };
    }
    const inventoryCount = world.inventory.items
      .filter(value => value.name === item)
      .reduce((sum, value) => sum + value.count, 0);
    if (inventoryCount < 1) return { ok: false, error: `placement_item_missing:${item}` };

    const referencePosition = structuredClone(reference.position);
    const referenceYaw = reference.yaw;
    const direction = relationDirection(relation, referenceYaw);
    const base = {
      x: Math.floor(referencePosition.x),
      y: Math.floor(referencePosition.y),
      z: Math.floor(referencePosition.z),
    };
    const supportPosition = { x: base.x + direction.x, y: base.y, z: base.z + direction.z };
    const position = {
      x: supportPosition.x,
      y: supportPosition.y + (surface === 'top' ? 1 : 0),
      z: supportPosition.z,
    };
    const stand = { x: base.x - direction.x, y: base.y, z: base.z - direction.z };
    const id = `place-relative-${Date.now()}-${++this.sequence}`;
    const distance = Math.hypot(
      stand.x - world.self.position.x,
      stand.y - world.self.position.y,
      stand.z - world.self.position.z,
    );
    const approach = await ctx.execute(action(
      `${id}-approach`,
      'move_to',
      { position: stand },
      ['movement'],
      Math.max(8_000, Math.min(20_000, 6_000 + Math.ceil(distance * 500))),
    ));
    if (!approach.ok) return { ok: false, error: approach.error ?? 'placement_approach_failed' };

    const placed = await ctx.execute(action(
      `${id}-place`,
      'place_block',
      {
        itemName: item,
        position,
        referencePosition: surface === 'top'
          ? supportPosition
          : { x: position.x, y: position.y - 1, z: position.z },
        faceVector: { x: 0, y: 1, z: 0 },
      },
      ['inventory'],
      8_000,
    ));
    if (!placed.ok) return { ok: false, error: placed.error ?? 'placement_failed' };

    ctx.publish('behavior.place_relative.success', 'info', {
      item,
      count: 1,
      position,
      relativeTo,
      referencePosition,
      ...(typeof referenceYaw === 'number' && Number.isFinite(referenceYaw) ? { referenceYaw } : {}),
      relation,
      surface,
    });
    return { ok: true, details: { item, count: 1, position, relativeTo, relation, surface } };
  }
}

function action(
  id: string,
  type: ActionRequest['type'],
  target: NonNullable<ActionRequest['target']>,
  resource: ActionRequest['resource'],
  timeoutMs: number,
): ActionRequest {
  return {
    id, source: 'place_relative', type, priority: 30, interrupt_level: 'soft',
    resource, target, preconditions: [], timeout_ms: timeoutMs,
  };
}

function relationDirection(relation: PlacementRelation, yaw?: number): { x: number; z: number } {
  if (typeof yaw !== 'number' || !Number.isFinite(yaw)) return { x: 1, z: 0 };
  const forward = cardinal(-Math.sin(yaw), Math.cos(yaw));
  if (relation === 'front' || relation === 'at') return forward;
  return { x: -forward.z, z: forward.x };
}

function cardinal(x: number, z: number): { x: number; z: number } {
  return Math.abs(x) >= Math.abs(z)
    ? { x: x >= 0 ? 1 : -1, z: 0 }
    : { x: 0, z: z >= 0 ? 1 : -1 };
}

function isRelation(value: unknown): value is PlacementRelation {
  return value === 'near' || value === 'right' || value === 'front' || value === 'at';
}

function finite(value: Vec3): boolean {
  return [value.x, value.y, value.z].every(Number.isFinite);
}
