/**
 * dialogueSlots · 自然语言 → minecraft item id 提取单测
 * 框架：node:test + node:assert/strict
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractItemFromDialogue } from '../../../../../../apps/minecraft-companion/src/bot/v2/knowledge/dialogueSlots.js';
import { InMemoryGoalKnowledgePort } from '../../../../../../apps/minecraft-companion/src/bot/v2/knowledge/goalTargetKnowledge.js';
import { minecraftGoalContributions } from '../../../../../../apps/minecraft-companion/src/bot/v2/plugins/builtin/minecraft-system/goalTargets.js';

const knowledge = new InMemoryGoalKnowledgePort(minecraftGoalContributions().map(entry => ({
  contribution: { pluginId: 'mineclaw.minecraft-system', pluginVersion: '1.0.0', contributionId: entry.id, contributionVersion: entry.version },
  target: entry.target,
})).map(({ target, contribution }) => ({
  contribution,
  kind: target.goalKind,
  registryId: target.registryId,
  aliases: target.aliases,
  taskFamilies: target.taskFamilies ?? [],
  successCriteria: target.successCriteria as any,
})));
const extract = (text: string | null | undefined) => extractItemFromDialogue(text, knowledge);

describe('extractItemFromDialogue', () => {
  it('木头/橡木 → oak_log', () => {
    assert.equal(extract('去东边采点木头'), 'oak_log');
    assert.equal(extract('帮我砍点橡木'), 'oak_log');
    assert.equal(extract('砍树'), 'oak_log');
  });

  it('石头/圆石 → cobblestone', () => {
    assert.equal(extract('挖点石头'), 'cobblestone');
    assert.equal(extract('要 16 个圆石'), 'cobblestone');
  });

  it('其他常见材料', () => {
    assert.equal(extract('挖泥土'), 'dirt');
    assert.equal(extract('采点沙子'), 'sand');
    assert.equal(extract('挖煤'), 'coal');
    assert.equal(extract('找铁矿'), 'iron_ore');
  });

  it('已是合法 id → 直接采信', () => {
    assert.equal(extract('oak_log'), 'oak_log');
    assert.equal(extract('birch_log'), 'birch_log');
  });

  it('英文关键词', () => {
    assert.equal(extract('gather some wood'), 'oak_log');
    assert.equal(extract('mine stone'), 'cobblestone');
  });

  it('命中不了 → null（上层走 clarify）', () => {
    assert.equal(extract('帮我个忙'), null);
    assert.equal(extract(''), null);
    assert.equal(extract(null), null);
    assert.equal(extract(undefined), null);
  });
});
