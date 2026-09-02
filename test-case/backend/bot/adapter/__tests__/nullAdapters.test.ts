import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { NullGameAdapter } from '../../../../../apps/minecraft-companion/src/bot/adapter/NullGameAdapter.js';
import { NullNavAdapter } from '../../../../../apps/minecraft-companion/src/bot/adapter/NullNavAdapter.js';
import { withinBody } from '../../v2/__tests__/mocks/withinBody.js';
import { createMockBot } from '../../v2/__tests__/mocks/index.js';

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
    await withinBody(async scope => {
      assert.throws(() => game.bind(scope), /game_body_unavailable/);
      assert.equal('dig' in game, false);
      assert.equal('depositToChest' in game, false);
    });
  });

  it('NullNavAdapter 拒绝绑定导航会话，不提供裸动作入口', async () => {
    const nav = new NullNavAdapter();
    await withinBody(async scope => {
      const game = createMockBot().game.bind(scope);
      try {
        assert.throws(() => nav.bind({ scope, game, maintain: async () => {} }), /navigation_body_unavailable/);
      } finally { await game.stop('test_finished'); }
    });
    assert.equal(nav.isMoving(), false);
    assert.equal(nav.getCurrentGoal(), null);
    assert.equal('goto' in nav, false);
    assert.equal('startFollow' in nav, false);
  });
});
