/**
 * L4 FleeBehavior · 逃跑技能（FEAT-L3-01）
 *
 * id: 'flee'
 *
 * compile() 序列：
 *   1. move_to → 反向质心 × 20 格（全速跑远 hostile 群）
 *
 * sprint 由调用方（ReflexStrategy / Supervisor）在 ActionRequest 外
 * 通过 game.setControlState 控制；本 skill 只负责寻路目标计算。
 *
 * params:
 *   fleeDistance?: number — 逃跑距离（默认 20 格）
 */

import type { SequenceBehavior, BehaviorContext } from './types.js';
import type { ActionRequest, EntityView } from '../types.js';
import type { Vec3 } from '../../adapter/types.js';

const SOURCE = 'flee_skill';
const DEFAULT_FLEE_DISTANCE = 20;
const HOSTILE_RANGE = 16;

/**
 * 计算逃跑目标点：所有 hostile 质心的反向 × fleeDistance
 */
export function calcFleeTarget(
  self: Vec3,
  hostiles: EntityView[],
  fleeDistance = DEFAULT_FLEE_DISTANCE,
): Vec3 {
  const nearby = hostiles.filter(h => h.distance <= HOSTILE_RANGE);
  if (nearby.length === 0) return self;

  let cx = 0;
  let cz = 0;
  for (const h of nearby) {
    cx += h.position.x;
    cz += h.position.z;
  }
  cx /= nearby.length;
  cz /= nearby.length;

  // 反向向量（自身远离质心）
  const dx = self.x - cx;
  const dz = self.z - cz;
  const len = Math.sqrt(dx * dx + dz * dz) || 1;

  return {
    x: Math.floor(self.x + (dx / len) * fleeDistance),
    y: self.y,
    z: Math.floor(self.z + (dz / len) * fleeDistance),
  };
}

export class FleeBehavior implements SequenceBehavior {
  readonly kind = 'sequence' as const;
  readonly id = 'flee';

  compile(ctx: BehaviorContext): ActionRequest[] {
    const hostiles = ctx.world.entities.filter(
      e => e.category === 'hostile' && e.distance <= HOSTILE_RANGE,
    );
    if (hostiles.length === 0) return [];

    const fleeDistance = (ctx.taskParams?.fleeDistance as number | undefined) ?? DEFAULT_FLEE_DISTANCE;
    const target = calcFleeTarget(ctx.world.self.position, hostiles, fleeDistance);
    const ts = Date.now();

    return [
      {
        id: `${SOURCE}-moveto-${ts}`,
        source: SOURCE,
        type: 'move_to',
        priority: 97,
        interrupt_level: 'hard',
        resource: ['movement'],
        target: { position: target },
        preconditions: [],
        expected_effect: ['safe_distance'],
        timeout_ms: 8000,
      },
    ];
  }
}
