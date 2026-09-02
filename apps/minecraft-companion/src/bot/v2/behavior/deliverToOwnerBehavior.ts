import type { ActionRequest } from '../types.js';
import type { BehaviorContext, SequenceBehavior } from './types.js';

/** Registered physical handoff: approach the owner, then toss toward their pickup radius. */
export class DeliverToOwnerBehavior implements SequenceBehavior {
  readonly kind = 'sequence' as const;
  readonly id = 'deliver_to_owner';
  private sequence = 0;

  compile(ctx: BehaviorContext): ActionRequest[] {
    const owner = ctx.world.owner;
    const params = ctx.taskParams ?? {};
    const item = typeof params.item === 'string' ? params.item : '';
    const count = typeof params.count === 'number' && Number.isFinite(params.count)
      ? Math.max(1, Math.floor(params.count))
      : 1;
    if (!owner?.position || !isFinitePosition(owner.position) || !item) return [];

    const id = `deliver-to-owner-${Date.now()}-${++this.sequence}`;
    const dx = owner.position.x - ctx.world.self.position.x;
    const dz = owner.position.z - ctx.world.self.position.z;
    const horizontalDistance = Math.hypot(dx, dz);
    const throwDistance = 3.2;
    const unit = horizontalDistance > 0.001
      ? { x: dx / horizontalDistance, z: dz / horizontalDistance }
      : { x: 0, z: 1 };
    const staging = {
      x: owner.position.x - unit.x * throwDistance,
      y: owner.position.y,
      z: owner.position.z - unit.z * throwDistance,
    };
    const stagingDistance = Math.hypot(
      staging.x - ctx.world.self.position.x,
      staging.y - ctx.world.self.position.y,
      staging.z - ctx.world.self.position.z,
    );
    const actions: ActionRequest[] = [];
    if (stagingDistance > 0.25) {
      actions.push(action(
        `${id}-approach`,
        'move_to',
        { position: staging, range: 0 },
        ['movement'],
        Math.max(8_000, Math.min(20_000, 6_000 + Math.ceil(stagingDistance * 500))),
      ));
    }
    actions.push(action(
      `${id}-toss`,
      'toss_item',
      {
        itemName: item,
        count,
        ...(owner.entityId != null ? { entityId: owner.entityId } : {}),
        // Aim at the feet. A horizontal torso throw passes through the player
        // while the vanilla pickup delay is active and lands beyond them.
        position: structuredClone(owner.position),
      },
      ['inventory'],
      8_000,
    ));
    return actions;
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
    id,
    source: 'deliver_to_owner',
    type,
    priority: 30,
    interrupt_level: 'soft',
    resource,
    target,
    preconditions: [],
    timeout_ms: timeoutMs,
  };
}

function isFinitePosition(value: { x: number; y: number; z: number }): boolean {
  return [value.x, value.y, value.z].every(Number.isFinite);
}
