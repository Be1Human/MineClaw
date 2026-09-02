import type { Vec3 } from '../../adapter/types.js';
import type { ActionRequest } from '../types.js';
import type { BehaviorContext, SequenceBehavior } from './types.js';

/** Registered container retrieval behavior: approach an interactable chest, then withdraw. */
export class ChestWithdrawBehavior implements SequenceBehavior {
  readonly kind = 'sequence' as const;
  readonly id = 'withdraw_from_chest';
  private sequence = 0;

  compile(ctx: BehaviorContext): ActionRequest[] {
    const params = ctx.taskParams ?? {};
    const chestPos = params.chestPos as Vec3 | undefined;
    const item = typeof params.item === 'string' ? params.item : '';
    const count = typeof params.count === 'number' && Number.isFinite(params.count)
      ? Math.max(1, Math.floor(params.count))
      : 1;
    if (!chestPos || !isFinitePosition(chestPos) || !item) return [];

    const id = `withdraw-from-chest-${Date.now()}-${++this.sequence}`;
    const distance = Math.hypot(
      chestPos.x - ctx.world.self.position.x,
      chestPos.y - ctx.world.self.position.y,
      chestPos.z - ctx.world.self.position.z,
    );
    const approachTimeout = Math.max(8_000, Math.min(20_000, 6_000 + Math.ceil(distance * 500)));
    return [
      action(`${id}-approach`, 'move_to', { position: chestPos }, ['movement'], approachTimeout),
      action(`${id}-withdraw`, 'withdraw', { position: chestPos, itemName: item, count }, ['inventory'], 8_000),
    ];
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
    source: 'withdraw_from_chest',
    type,
    priority: 30,
    interrupt_level: 'soft',
    resource,
    target,
    preconditions: [],
    timeout_ms: timeoutMs,
  };
}

function isFinitePosition(value: Vec3): boolean {
  return [value.x, value.y, value.z].every(Number.isFinite);
}
