/**
 * DoorTransparentMovements · 决定性单测：pathfinder 只规划，DoorMonitor 独占物理开门。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import registryLoader from 'prismarine-registry';
import {
  DoorTransparentMovements,
  isPassThroughDoorName,
  shouldPathfinderOpenDoor,
} from '../../../../../apps/minecraft-companion/src/bot/mineflayer/doorTransparentMovements.ts';

const registry = registryLoader('1.21.1');
const fakeBot = { registry, version: '1.21.1' };

test('BUG-CROSS-08 · DoorMonitor 独占开门，Pathfinder 不生成 useOne', () => {
  const mvs = new DoorTransparentMovements(fakeBot);

  assert.equal(mvs.canOpenDoors, false, '物理开门必须只归 DoorMonitor');

  const oakDoor = registry.blocksByName.oak_door;
  assert.ok(oakDoor, 'registry 应有 oak_door');
  assert.ok(!mvs.openable.has(oakDoor.id), 'oak_door 不应生成 pathfinder useOne');
  assert.equal(isPassThroughDoorName('oak_door'), true);
  assert.equal(shouldPathfinderOpenDoor('oak_door', { open: false }), true);
  assert.equal(shouldPathfinderOpenDoor('oak_door', { open: 'false' }), true);
  assert.equal(shouldPathfinderOpenDoor('oak_door', { open: true }), false);
  assert.equal(shouldPathfinderOpenDoor('oak_door', { open: 'true' }), false);

  // 木活板门同样交给 DoorMonitor
  const oakTrap = registry.blocksByName.oak_trapdoor;
  if (oakTrap) assert.ok(!mvs.openable.has(oakTrap.id), 'oak_trapdoor 不应生成 pathfinder useOne');
  assert.equal(isPassThroughDoorName('oak_trapdoor'), true);

  // 铁门既不交互也不透明
  const ironDoor = registry.blocksByName.iron_door;
  if (ironDoor) assert.ok(!mvs.openable.has(ironDoor.id), 'iron_door 不该进 openable（推不开）');
  assert.equal(isPassThroughDoorName('iron_door'), false);

  // 对照：原生 fence gate 仍在 openable。
  const fenceGate = registry.blocksByName.oak_fence_gate;
  if (fenceGate) assert.ok(mvs.openable.has(fenceGate.id), '栅栏门本来就在 openable');
});

test('BUG-CROSS-08 · 关闭门不得斜向绕过 useOne', () => {
  const mvs = new DoorTransparentMovements(fakeBot);
  mvs.getBlock = () => ({ name: 'oak_door', openable: true });
  const neighbors = [];

  mvs.getMoveDiagonal({ x: 0, y: 64, z: 0 }, { x: 1, z: 1 }, neighbors);

  assert.equal(neighbors.length, 0, '含关闭门的 diagonal neighbor 必须被拒绝');
});
