/**
 * L4 CraftBehavior · 合成一次
 *
 * id: 'craft_one'
 *
 * 由 ProvisionStrategy 调用。taskParams: { item, count, tablePos? }
 * compile() 展开为：
 *   (若需工作台) move_to(tablePos) → 靠近工作台
 *   craft(item, count, tablePos)
 */

import type { SequenceBehavior, BehaviorContext } from './types.js';
import type { ActionRequest } from '../types.js';
import type { Vec3 } from '../../adapter/types.js';

export class CraftBehavior implements SequenceBehavior {
  readonly kind = 'sequence' as const;
  readonly id = 'craft_one';
  private seq = 0;

  compile(ctx: BehaviorContext): ActionRequest[] {
    const p = ctx.taskParams ?? {};
    const item = p.item as string | undefined;
    if (!item) return [];
    const count = (p.count as number) ?? 1;
    const inventoryTargetCount = p.inventoryTargetCount as number | undefined;
    const tablePos = p.tablePos as Vec3 | undefined;

    const base = `craft_one-${Date.now()}-${++this.seq}`;
    const out: ActionRequest[] = [];

    if (tablePos && typeof tablePos.x === 'number') {
      out.push({
        id: `${base}-approach`,
        source: 'craft_one',
        type: 'move_to',
        priority: 30,
        interrupt_level: 'soft',
        resource: ['movement'],
        target: { position: tablePos },
        preconditions: [],
        timeout_ms: 12000,
      });
    }

    out.push({
      id: `${base}-craft`,
      source: 'craft_one',
      type: 'craft',
      priority: 30,
      interrupt_level: 'soft',
      resource: ['inventory'],
      target: { itemName: item, count, inventoryTargetCount, tablePos },
      preconditions: [],
      timeout_ms: 8000,
    });

    return out;
  }
}
