import type { DoorPassageRequest } from '../adapter/NavigationAdapter.js';
import type { Vec3 } from '../adapter/types.js';

type Facing = 'north' | 'south' | 'east' | 'west';
type Hinge = 'left' | 'right';

/** 普通双格门；trapdoor/fence gate 的碰撞语义不同，不走本辅助。 */
export function isOrdinaryDoor(blockName: string): boolean {
  return blockName.endsWith('_door') && !blockName.includes('iron');
}

/**
 * 计算越过打开门板的安全目标。
 * 0.35/0.65 会让 0.6 格宽的玩家碰撞箱避开门洞侧边 3/16 格厚的旋转门板。
 */
export function computeDoorPassageTarget(
  request: DoorPassageRequest,
  from: Vec3,
): Vec3 | null {
  if (!isOrdinaryDoor(request.blockName)) return null;
  const facing = request.properties.facing as Facing | undefined;
  const hinge = request.properties.hinge as Hinge | undefined;
  if (!facing || !hinge) return null;

  const centerX = request.position.x + 0.5;
  const centerZ = request.position.z + 0.5;
  const y = from.y + 1;

  if (facing === 'north' || facing === 'south') {
    const towardPositiveZ = from.z <= centerZ;
    return {
      x: request.position.x + safeLateralOffset(facing, hinge),
      y,
      z: centerZ + (towardPositiveZ ? 1.6 : -1.6),
    };
  }

  if (facing === 'east' || facing === 'west') {
    const towardPositiveX = from.x <= centerX;
    return {
      x: centerX + (towardPositiveX ? 1.6 : -1.6),
      y,
      z: request.position.z + safeLateralOffset(facing, hinge),
    };
  }

  return null;
}

/** 先在门外横向移动到安全通道，再沿穿越轴前进，避免斜线起步仍撞上门板。 */
export function computeDoorAlignmentTarget(
  request: DoorPassageRequest,
  from: Vec3,
): Vec3 | null {
  const exit = computeDoorPassageTarget(request, from);
  if (!exit) return null;
  const facing = request.properties.facing as Facing | undefined;
  if (facing === 'north' || facing === 'south') {
    return { x: exit.x, y: exit.y, z: from.z };
  }
  if (facing === 'east' || facing === 'west') {
    return { x: from.x, y: exit.y, z: exit.z };
  }
  return null;
}

/** 中心越过门平面 0.15 格即确认进入另一侧；横向安全偏移负责避开旋转门板。 */
export function hasCrossedDoorPlane(
  request: DoorPassageRequest,
  from: Vec3,
  to: Vec3,
): boolean {
  const facing = request.properties.facing as Facing | undefined;
  if (facing === 'north' || facing === 'south') {
    return crossed(request.position.z + 0.5, from.z, to.z);
  }
  if (facing === 'east' || facing === 'west') {
    return crossed(request.position.x + 0.5, from.x, to.x);
  }
  return false;
}

function crossed(center: number, from: number, to: number): boolean {
  if (from <= center) return to >= center + 0.15;
  return to <= center - 0.15;
}

/** 返回门洞局部横向坐标，远离门打开后所在的侧边。 */
function safeLateralOffset(facing: Facing, hinge: Hinge): number {
  const lowSideDoor =
    (facing === 'north' && hinge === 'left')
    || (facing === 'south' && hinge === 'right')
    || (facing === 'west' && hinge === 'right')
    || (facing === 'east' && hinge === 'left');
  return lowSideDoor ? 0.65 : 0.35;
}
