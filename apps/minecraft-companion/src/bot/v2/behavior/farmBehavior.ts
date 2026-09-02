/**
 * L4 FarmBehavior · 种地单地块技能
 *
 * id: 'farm_one_plot'
 *
 * compile() 序列：
 *   1. equip hoe
 *   2. look_at targetPos (bot 前方 -1y 格)
 *   3. use_tool (till 耕地)
 *   4. look_at targetPos (再对准一次，准备撒种)
 *   5. place_block seeds (在已耕地上放种子)
 *
 * 注：compile() 只有 WorldStateView，无法调 GameAdapter.findBlocks；
 *     目标位置取 bot 当前位置正前方脚下一格（z+1, y-1）做近似。
 */

import type { SequenceBehavior, BehaviorContext } from './types.js';
import type { ActionRequest } from '../types.js';

const SOURCE = 'farm_one_plot';

export class FarmBehavior implements SequenceBehavior {
  readonly kind = 'sequence' as const;
  readonly id = 'farm_one_plot';

  compile(ctx: BehaviorContext): ActionRequest[] {
    const { world, taskParams } = ctx;
    const seedName = (taskParams?.seedName as string) ?? 'wheat_seeds';
    const hoeName = (taskParams?.hoeName as string) ?? 'wooden_hoe';

    const pos = world.self.position;
    // 目标耕地格：正前方 z+1，脚下 y-1
    const targetPos = {
      x: Math.round(pos.x),
      y: Math.round(pos.y) - 1,
      z: Math.round(pos.z) + 1,
    };

    const ts = Date.now();
    const seq: ActionRequest[] = [];

    // 1. equip hoe
    seq.push({
      id: `${SOURCE}-equip-${ts}`,
      source: SOURCE,
      type: 'equip',
      priority: 30,
      interrupt_level: 'soft',
      resource: ['inventory'],
      target: { itemName: hoeName },
      preconditions: [],
      expected_effect: ['hoe_equipped'],
      timeout_ms: 3000,
    });

    // 2. look_at target (耕地前对准)
    seq.push({
      id: `${SOURCE}-look1-${ts}`,
      source: SOURCE,
      type: 'look_at',
      priority: 30,
      interrupt_level: 'soft',
      resource: ['vision'],
      target: { position: targetPos },
      preconditions: [],
      expected_effect: ['facing_target'],
      timeout_ms: 2000,
    });

    // 3. use_tool (till 耕地)
    seq.push({
      id: `${SOURCE}-till-${ts}`,
      source: SOURCE,
      type: 'use_tool',
      priority: 30,
      interrupt_level: 'soft',
      resource: ['inventory', 'vision'],
      target: { itemName: hoeName, position: targetPos },
      preconditions: [],
      expected_effect: ['dirt_tilled'],
      timeout_ms: 4000,
    });

    // 4. look_at target (撒种前再对准)
    seq.push({
      id: `${SOURCE}-look2-${ts}`,
      source: SOURCE,
      type: 'look_at',
      priority: 30,
      interrupt_level: 'soft',
      resource: ['vision'],
      target: { position: targetPos },
      preconditions: [],
      expected_effect: ['facing_target'],
      timeout_ms: 2000,
    });

    // 5. place_block seeds (放种子)
    seq.push({
      id: `${SOURCE}-seed-${ts}`,
      source: SOURCE,
      type: 'place_block',
      priority: 30,
      interrupt_level: 'soft',
      resource: ['inventory', 'vision'],
      target: {
        itemName: seedName,
        position: targetPos,
        referencePosition: targetPos,
        faceVector: { x: 0, y: 1, z: 0 },
      },
      preconditions: [],
      expected_effect: ['seeds_planted'],
      timeout_ms: 4000,
    });

    return seq;
  }
}
