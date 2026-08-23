import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { NullGameAdapter } from '../../../../../apps/minecraft-companion/src/bot/adapter/NullGameAdapter.js';
import { NullNavAdapter } from '../../../../../apps/minecraft-companion/src/bot/adapter/NullNavAdapter.js';

describe('FEAT-CROSS-08 · Null adapters', () => {
  it('NullGameAdapter 返回空世界和安全自身状态', () => {
    const game = new NullGameAdapter('LanYi');
    assert.equal(game.username, 'LanYi');
    assert.deepEqual(game.getPosition(), { x: 0, y: 64, z: 0 });
    assert.equal(game.getHealth(), 20);
    assert.equal(game.getFood(), 20);
    assert.deepEqual(game.getEntities(), []);
    assert.deepEqual(game.getInventoryItems(), []);
    assert.doesNotThrow(() => game.chat('hello'));
  });

  it('NullGameAdapter 动作类能力显式失败', async () => {
    const game = new NullGameAdapter();
    await assert.rejects(() => game.dig({ x: 0, y: 64, z: 0 }), /game_body_unavailable/);
    const chest = await game.depositToChest({ x: 0, y: 64, z: 0 }, 'dirt', 1);
    assert.deepEqual(chest, { ok: false, moved: 0, reason: 'game_body_unavailable' });
  });

  it('NullNavAdapter 不移动并返回 game_body_unavailable', async () => {
    const nav = new NullNavAdapter();
    const r = await nav.goto({ type: 'block', position: { x: 1, y: 64, z: 1 } });
    assert.deepEqual(r, { ok: false, reason: 'game_body_unavailable' });
    assert.equal(nav.isMoving(), false);
    assert.equal(nav.getCurrentGoal(), null);
    assert.deepEqual(nav.startFollow(1, 3), { ok: false, reason: 'game_body_unavailable' });
  });
});
