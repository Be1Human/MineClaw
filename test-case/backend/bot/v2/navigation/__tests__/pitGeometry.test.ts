import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { findPitExit, isTrappedInPit } from '../../../../../../apps/minecraft-companion/src/bot/v2/navigation/pitGeometry.js';

type Block = { name: string; boundingBox: 'block' | 'empty' } | null;
const AIR: Block = { name: 'air', boundingBox: 'empty' };
const STONE: Block = { name: 'stone', boundingBox: 'block' };
const LAVA: Block = { name: 'lava', boundingBox: 'block' };

function game(blocks: Record<string, Block>) {
  return {
    getBlockAt: (p: { x: number; y: number; z: number }) => blocks[`${p.x},${p.y},${p.z}`] ?? AIR,
  } as never;
}

describe('pitGeometry · BUG-CROSS-04', () => {
  it('一格浅坑存在 step_up 出口，不判真坑', () => {
    const blocks: Record<string, Block> = {
      '1,0,0': STONE,
      '1,1,0': AIR,
      '1,2,0': AIR,
      '-1,0,0': STONE,
      '0,0,1': STONE,
      '0,0,-1': STONE,
    };
    const exit = findPitExit(game(blocks), { x: 0, y: 0, z: 0 }, { safeDrop: 6 });
    assert.deepEqual(exit, { dx: 1, dz: 0, mode: 'step_up' });
    assert.equal(isTrappedInPit(game(blocks), { x: 0, y: 0, z: 0 }, { safeDrop: 6 }), false);
  });

  it('四向脚位与头位封死且无安全落点，判真坑', () => {
    const blocks: Record<string, Block> = {};
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      blocks[`${dx},0,${dz}`] = STONE;
      blocks[`${dx},1,${dz}`] = STONE;
    }
    assert.equal(isTrappedInPit(game(blocks), { x: 0, y: 0, z: 0 }, { safeDrop: 6 }), true);
  });

  it('落脚点是岩浆时不视为安全出口', () => {
    const blocks: Record<string, Block> = {
      '1,0,0': AIR,
      '1,1,0': AIR,
      '1,-1,0': LAVA,
      '-1,0,0': STONE,
      '-1,1,0': STONE,
      '0,0,1': STONE,
      '0,1,1': STONE,
      '0,0,-1': STONE,
      '0,1,-1': STONE,
    };
    assert.equal(isTrappedInPit(game(blocks), { x: 0, y: 0, z: 0 }, { safeDrop: 1 }), true);
  });
});
