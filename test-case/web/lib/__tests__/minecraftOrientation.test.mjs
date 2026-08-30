import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  mineflayerYawBasis,
  mineflayerYawToThreeRotation,
} from '../../../../apps/minecraft-companion/web/src/lib/minecraftOrientation.js';

const EPSILON = 1e-12;

function assertVector(actual, expected) {
  assert.ok(Math.abs(actual.x - expected.x) < EPSILON, `expected x=${expected.x}, received ${actual.x}`);
  assert.ok(Math.abs(actual.z - expected.z) < EPSILON, `expected z=${expected.z}, received ${actual.z}`);
}

test('Mineflayer 四个基准 yaw 生成正确的世界前方和右方', () => {
  const cases = [
    { yaw: 0, forward: { x: 0, z: -1 }, right: { x: 1, z: 0 } },
    { yaw: Math.PI / 2, forward: { x: -1, z: 0 }, right: { x: 0, z: -1 } },
    { yaw: Math.PI, forward: { x: 0, z: 1 }, right: { x: -1, z: 0 } },
    { yaw: 3 * Math.PI / 2, forward: { x: 1, z: 0 }, right: { x: 0, z: 1 } },
  ];

  for (const current of cases) {
    const basis = mineflayerYawBasis(current.yaw);
    assertVector(basis.forward, current.forward);
    assertVector(basis.right, current.right);
  }
});

test('+Z 和 -Z 本地正面模型转换到相同的 Mineflayer 世界朝向', () => {
  for (const yaw of [0, Math.PI / 2, Math.PI, 3 * Math.PI / 2]) {
    assert.ok(Math.abs(mineflayerYawToThreeRotation(yaw, '+z') - (Math.PI + yaw)) < EPSILON);
    assert.ok(Math.abs(mineflayerYawToThreeRotation(yaw, '-z') - yaw) < EPSILON);
  }
});

test('非法 yaw 安全回退到北向，非法模型正面轴明确报错', () => {
  assertVector(mineflayerYawBasis(Number.NaN).forward, { x: 0, z: -1 });
  assert.equal(mineflayerYawToThreeRotation(undefined, '+z'), Math.PI);
  assert.throws(() => mineflayerYawToThreeRotation(0, 'x'), /Unsupported model forward axis/);
});
