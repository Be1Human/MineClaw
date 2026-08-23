import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { DoorPassageRequest } from '../../../../../apps/minecraft-companion/src/bot/adapter/NavigationAdapter.js';
import {
  computeDoorAlignmentTarget,
  computeDoorPassageTarget,
  hasCrossedDoorPlane,
  isOrdinaryDoor,
} from '../../../../../apps/minecraft-companion/src/bot/mineflayer/doorPassageGeometry.js';

function request(facing: string, hinge: string): DoorPassageRequest {
  return {
    position: { x: 10, y: 64, z: 20 },
    blockName: 'oak_door',
    properties: { facing, hinge, half: 'lower', open: 'true' },
  };
}

describe('BUG-CROSS-08 · 门通行几何', () => {
  const cases: Array<[string, string, 'x' | 'z', number]> = [
    ['north', 'left', 'x', 10.65],
    ['north', 'right', 'x', 10.35],
    ['south', 'left', 'x', 10.35],
    ['south', 'right', 'x', 10.65],
    ['west', 'left', 'z', 20.35],
    ['west', 'right', 'z', 20.65],
    ['east', 'left', 'z', 20.65],
    ['east', 'right', 'z', 20.35],
  ];

  for (const [facing, hinge, axis, expected] of cases) {
    it(`${facing}/${hinge} 远离旋转门板`, () => {
      const from = facing === 'north' || facing === 'south'
        ? { x: 10.5, y: 64, z: 19.4 }
        : { x: 9.4, y: 64, z: 20.5 };
      const target = computeDoorPassageTarget(request(facing, hinge), from);
      assert.ok(target);
      assert.equal(target[axis], expected);
    });
  }

  it('按接近方向选择门平面另一侧', () => {
    const northToSouth = computeDoorPassageTarget(request('north', 'left'), { x: 10.5, y: 64, z: 19.2 });
    const southToNorth = computeDoorPassageTarget(request('north', 'left'), { x: 10.5, y: 64, z: 21.8 });
    assert.ok(northToSouth && northToSouth.z > 20.5);
    assert.ok(southToNorth && southToNorth.z < 20.5);
  });

  it('门外对齐点只改变横向安全轴', () => {
    const from = { x: 10.72, y: 64, z: 19.4 };
    assert.deepEqual(computeDoorAlignmentTarget(request('north', 'left'), from), {
      x: 10.65, y: 65, z: 19.4,
    });
    const fromWest = { x: 9.4, y: 64, z: 20.72 };
    assert.deepEqual(computeDoorAlignmentTarget(request('west', 'left'), fromWest), {
      x: 9.4, y: 65, z: 20.35,
    });
  });

  it('中心越过门面 0.15 格算成功，0.10 格仍拒绝', () => {
    const r = request('north', 'left');
    assert.equal(hasCrossedDoorPlane(r, { x: 10.5, y: 64, z: 19.5 }, { x: 10.5, y: 64, z: 20.7 }), true);
    assert.equal(hasCrossedDoorPlane(r, { x: 10.5, y: 64, z: 19.5 }, { x: 10.5, y: 64, z: 20.6 }), false);
  });

  it('铁门、活板门和属性缺失保守拒绝', () => {
    assert.equal(isOrdinaryDoor('iron_door'), false);
    assert.equal(isOrdinaryDoor('oak_trapdoor'), false);
    assert.equal(computeDoorPassageTarget({ ...request('north', 'left'), properties: {} }, { x: 10, y: 64, z: 19 }), null);
  });
});
