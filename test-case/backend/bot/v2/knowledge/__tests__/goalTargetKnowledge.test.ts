import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  InMemoryGoalKnowledgePort,
  defaultGoalKnowledge,
} from '../../../../../../apps/minecraft-companion/src/bot/v2/knowledge/goalTargetKnowledge.js';

describe('BUG-CROSS-72 · shared goal target knowledge', () => {
  test('自然语言、英文和规范 id 解析到同一圆石目标并携带证据', () => {
    for (const query of ['石头', '圆石', 'cobblestone']) {
      const candidate = defaultGoalKnowledge.searchTargets({ query, kind: 'item', limit: 1 })[0];
      assert.equal(candidate?.registryId, 'minecraft:cobblestone', query);
      assert.equal(candidate?.evidenceRef, 'goal-target:minecraft:cobblestone', query);
    }
  });

  test('精确长别名优先于被包含的普通目标', () => {
    assert.equal(
      defaultGoalKnowledge.searchTargets({ query: '给我红石火把', kind: 'item', limit: 1 })[0]?.registryId,
      'minecraft:redstone_torch',
    );
    assert.equal(
      defaultGoalKnowledge.searchTargets({ query: '给我灵魂火炬', kind: 'item', limit: 1 })[0]?.registryId,
      'minecraft:soul_torch',
    );
  });

  test('目录外 registryId 和虚构自然语言都不能获得候选', () => {
    assert.equal(defaultGoalKnowledge.getTarget('minecraft:rainbow_drill'), null);
    assert.deepEqual(defaultGoalKnowledge.searchTargets({ query: '不存在的彩虹钻头', kind: 'item' }), []);
  });

  test('自定义目录保持隔离且只返回注册目标', () => {
    const port = new InMemoryGoalKnowledgePort([{
      kind: 'item', registryId: 'minecraft:stick', aliases: ['木棍', 'stick'], taskFamilies: ['crafting'],
    }]);
    assert.equal(port.searchTargets({ query: '给我木棍', kind: 'item' })[0]?.registryId, 'minecraft:stick');
    assert.deepEqual(port.searchTargets({ query: '石头', kind: 'item' }), []);
  });
});
