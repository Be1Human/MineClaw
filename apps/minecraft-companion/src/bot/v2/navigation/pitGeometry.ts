/**
 * 坑体几何判定（BUG-CROSS-04）。
 *
 * Strategy 负责“是否需要起 escape 任务”，Atomic 负责“动作后是否真的脱困”。
 * 两处必须复用同一份空间语义，否则会出现 Strategy 仍认为被困、Atomic 却报成功。
 */
import type { GameAdapter } from '../../adapter/GameAdapter.js';
import type { Vec3 } from '../../adapter/types.js';

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;
const HAZARD = /lava|fire|magma/i;
const DOOR = /(?:^|_)(?:door|trapdoor)$/i;

export type PitExitMode = 'level' | 'drop' | 'step_up';

export interface PitExit {
  dx: number;
  dz: number;
  mode: PitExitMode;
}

export interface PitGeometryOptions {
  safeDrop: number;
}

type BlockReader = Pick<GameAdapter, 'getBlockAt'>;

function passable(block: ReturnType<BlockReader['getBlockAt']>): boolean {
  return !block || block.boundingBox === 'empty' || DOOR.test(block.name);
}

function safeSolid(block: ReturnType<BlockReader['getBlockAt']>): boolean {
  return !!block && block.boundingBox === 'block' && !HAZARD.test(block.name);
}

/** 返回任一可离开坑体的方向；null 表示四向均无安全出口。 */
export function findPitExit(game: BlockReader, pos: Vec3, options: PitGeometryOptions): PitExit | null {
  const fx = Math.floor(pos.x);
  const fy = Math.floor(pos.y);
  const fz = Math.floor(pos.z);

  for (const [dx, dz] of DIRS) {
    const foot = game.getBlockAt({ x: fx + dx, y: fy, z: fz + dz });
    const head = game.getBlockAt({ x: fx + dx, y: fy + 1, z: fz + dz });

    if (passable(foot) && passable(head)) {
      const ground = game.getBlockAt({ x: fx + dx, y: fy - 1, z: fz + dz });
      if (safeSolid(ground)) return { dx, dz, mode: 'level' };

      for (let dy = 2; dy <= options.safeDrop; dy++) {
        const below = game.getBlockAt({ x: fx + dx, y: fy - dy, z: fz + dz });
        if (safeSolid(below)) return { dx, dz, mode: 'drop' };
      }
    }

    // 一格浅坑：邻格脚位是可站立方块，向上两格净空，玩家可原生迈/跳上去。
    const aboveStep = game.getBlockAt({ x: fx + dx, y: fy + 2, z: fz + dz });
    if (safeSolid(foot) && passable(head) && passable(aboveStep)) {
      return { dx, dz, mode: 'step_up' };
    }
  }

  return null;
}

export function isTrappedInPit(game: BlockReader, pos: Vec3, options: PitGeometryOptions): boolean {
  return findPitExit(game, pos, options) === null;
}
