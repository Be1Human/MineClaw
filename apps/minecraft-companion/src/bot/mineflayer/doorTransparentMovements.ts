/**
 * DoorTransparentMovements —— 让 A* 原生"规划穿门 + 走到自己开门"的 Movements 子类
 *
 * 根因（读 mineflayer-pathfinder 源码 movements.js:94-99）：
 *   库构造 openable 集合时只收「名字含 gate」的块（栅栏门），**门(oak_door 等)永远不进 openable**。
 *   于是即便 canOpenDoors=true，getMoveForward:391 的原生开门分支对门永不触发 → 门被当实心墙
 *   → 含门路径算不出 "No path to the goal"。这是库的「openable 漏门」缺陷。
 *
 * BUG-CROSS-08：物理开门只能有一个执行器。统一交给 DoorMonitor；pathfinder 不生成
 * useOne。关闭门禁止 diagonal，先把 bot 对正门中央，再由 DoorMonitor 点击一次。
 *
 * 铁门不能手开，必须保持实体阻挡，不能被透明规则规划穿越。
 */

import pkg from 'mineflayer-pathfinder';
import type { Bot } from 'mineflayer';
import { isDoorBlock } from '../v2/atomic/openDoor.js';

const { Movements } = pkg;

type MovementsInstance = InstanceType<typeof Movements>;
type GetBlockArgs = Parameters<MovementsInstance['getBlock']>;
type GetBlockRet = ReturnType<MovementsInstance['getBlock']>;
type DiagonalArgs = Parameters<MovementsInstance['getMoveDiagonal']>;

export function isPassThroughDoorName(name: string): boolean {
  return isDoorBlock(name) && !name.includes('iron');
}

export function shouldPathfinderOpenDoor(
  name: string,
  props: Record<string, unknown> | null | undefined,
): boolean {
  return isPassThroughDoorName(name) && props?.open !== true && props?.open !== 'true';
}

export class DoorTransparentMovements extends Movements {
  constructor(bot: Bot) {
    super(bot);
    // DoorMonitor 是唯一物理开门执行器；禁止 pathfinder 生成 useOne 二次点击。
    (this as unknown as { canOpenDoors: boolean }).canOpenDoors = false;
  }

  // A* 规划穿过可手开门；实际物理开门由 DoorMonitor 处理。铁门保持实体阻挡。
  getBlock(...args: GetBlockArgs): GetBlockRet {
    const block = super.getBlock(...args) as (GetBlockRet & {
      name?: string;
      openable?: boolean;
      getProperties?: () => Record<string, unknown>;
    }) | null;
    if (block && block.name && isPassThroughDoorName(block.name)) {
      block.safe = true;
      block.physical = false;
      const props = typeof block.getProperties === 'function' ? block.getProperties() : null;
      block.openable = false;
    }
    return block as GetBlockRet;
  }

  /**
   * 上游库只有 getMoveForward 会把 openable 转为 useOne；斜行分支会把 safe 门当空气。
   * 关闭门参与斜向通道时拒绝该邻居，迫使 A* 选择能够执行开门动作的直行节点。
   */
  getMoveDiagonal(...args: DiagonalArgs): void {
    const [node, dir, neighbors] = args;
    const checks: Array<[number, number, number]> = [
      [dir.x, 0, dir.z],
      [dir.x, 1, dir.z],
      [0, 0, dir.z],
      [0, 1, dir.z],
      [dir.x, 0, 0],
      [dir.x, 1, 0],
    ];
    const hasClosedDoor = checks.some(([dx, dy, dz]) => {
      const block = this.getBlock(node as unknown as GetBlockArgs[0], dx, dy, dz) as GetBlockRet & {
        name?: string;
        openable?: boolean;
      };
      const props = typeof (block as { getProperties?: () => Record<string, unknown> }).getProperties === 'function'
        ? (block as { getProperties: () => Record<string, unknown> }).getProperties()
        : null;
      return !!block?.name && shouldPathfinderOpenDoor(block.name, props);
    });
    if (hasClosedDoor) return;
    super.getMoveDiagonal(node, dir, neighbors);
  }
}
