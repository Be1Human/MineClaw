/**
 * L4 FollowBehavior · 跟随 owner 技能
 *
 * id: 'follow_owner'
 *
 * plan() 逻辑（按距离三段）：
 *   dist ≤ 3   → [] （已到位，无需移动）
 *   dist > 50  → move_to（pathfinder 单次规划，远距离开路）
 *   否则       → follow_entity（持续跟随）
 */

import type { IBehavior, BehaviorContext } from './types.js';
import type { ActionRequest } from '../types.js';

export class FollowBehavior implements IBehavior {
  readonly id = 'follow_owner';

  plan(ctx: BehaviorContext): ActionRequest[] {
    const owner = ctx.world.owner;
    if (!owner) return [];

    // 已到位 —— 静默
    if (owner.distance <= 3) return [];

    // 远距离：pathfinder 单次规划
    if (owner.distance > 50) {
      if (!owner.position) return [];
      return [
        {
          id: `follow_owner-moveto-${Date.now()}`,
          source: 'follow_skill',
          type: 'move_to',
          priority: 40,
          interrupt_level: 'soft',
          resource: ['movement'],
          target: {
            position: {
              x: owner.position.x,
              y: owner.position.y,
              z: owner.position.z,
            },
          },
          preconditions: [],
          expected_effect: ['closer_to_owner'],
          timeout_ms: 20000,
        },
      ];
    }

    // 普通距离：持续跟随实体
    return [
      {
        id: `follow_owner-follow-${Date.now()}`,
        source: 'follow_skill',
        type: 'follow_entity',
        priority: 40,
        interrupt_level: 'soft',
        resource: ['movement'],
        target: { entityId: owner.entityId ?? 0 },
        preconditions: [],
        expected_effect: ['closer_to_owner'],
        timeout_ms: 5000,
      },
    ];
  }
}
