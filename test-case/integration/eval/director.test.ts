import test from 'node:test';
import assert from 'node:assert/strict';
import { Director, isPermissionDeniedMessage, normalizeMinecraftCommand } from '../../../benchmark/engineering/core/director.js';

test('BUG-CROSS-05 · tp alias 统一为 minecraft:teleport', () => {
  assert.equal(normalizeMinecraftCommand('/tp EvalSubject 1 2 3'), '/minecraft:teleport EvalSubject 1 2 3');
  assert.equal(normalizeMinecraftCommand('tp EvalSubject 1 2 3'), '/minecraft:teleport EvalSubject 1 2 3');
});

test('BUG-CROSS-05 · 已 namespaced 命令保持，其他命令只规范首词', () => {
  assert.equal(normalizeMinecraftCommand('/minecraft:teleport A 1 2 3'), '/minecraft:teleport A 1 2 3');
  assert.equal(normalizeMinecraftCommand('/fill 0 0 0 1 1 1 air'), '/minecraft:fill 0 0 0 1 1 1 air');
  assert.equal(normalizeMinecraftCommand('gamerule doMobSpawning false'), '/minecraft:gamerule doMobSpawning false');
});

test('BUG-CROSS-05 · Paper 隐藏无权限命令时仍能自检判负', () => {
  assert.equal(isPermissionDeniedMessage('Unknown or incomplete command, see below for error'), true);
  assert.equal(isPermissionDeniedMessage('You do not have permission'), true);
  assert.equal(isPermissionDeniedMessage('The time is 6000'), false);
});

test('BUG-CROSS-05 · 远端竞技场摆场前临时加载完整区块并在结束后释放', async () => {
  const director = new Director({
    host: '127.0.0.1', port: 25565, username: 'EvalDirector',
    anchor: { x: 1000, y: 120, z: 1000 },
  });
  const commands: string[] = [];
  director.cmd = async (command: string) => { commands.push(command); };

  await director.prepareArena(16, 2);

  assert.deepEqual(commands, [
    '/forceload add 1000 1000 1015 1015',
    '/fill 1000 119 1000 1015 119 1015 minecraft:stone',
    '/fill 1000 120 1000 1015 121 1015 minecraft:air',
    '/forceload remove 1000 1000 1015 1015',
  ]);
});
