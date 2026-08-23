/**
 * dialogueSlots · 自然语言 → minecraft item id 提取单测
 * 框架：node:test + node:assert/strict
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractItemFromDialogue } from '../../../../../../apps/minecraft-companion/src/bot/v2/knowledge/dialogueSlots.js';

describe('extractItemFromDialogue', () => {
  it('木头/橡木 → oak_log', () => {
    assert.equal(extractItemFromDialogue('去东边采点木头'), 'oak_log');
    assert.equal(extractItemFromDialogue('帮我砍点橡木'), 'oak_log');
    assert.equal(extractItemFromDialogue('砍树'), 'oak_log');
  });

  it('石头/圆石 → cobblestone', () => {
    assert.equal(extractItemFromDialogue('挖点石头'), 'cobblestone');
    assert.equal(extractItemFromDialogue('要 16 个圆石'), 'cobblestone');
  });

  it('其他常见材料', () => {
    assert.equal(extractItemFromDialogue('挖泥土'), 'dirt');
    assert.equal(extractItemFromDialogue('采点沙子'), 'sand');
    assert.equal(extractItemFromDialogue('挖煤'), 'coal');
    assert.equal(extractItemFromDialogue('找铁矿'), 'iron_ore');
  });

  it('已是合法 id → 直接采信', () => {
    assert.equal(extractItemFromDialogue('oak_log'), 'oak_log');
    assert.equal(extractItemFromDialogue('birch_log'), 'birch_log');
  });

  it('英文关键词', () => {
    assert.equal(extractItemFromDialogue('gather some wood'), 'oak_log');
    assert.equal(extractItemFromDialogue('mine stone'), 'cobblestone');
  });

  it('命中不了 → null（上层走 clarify）', () => {
    assert.equal(extractItemFromDialogue('帮我个忙'), null);
    assert.equal(extractItemFromDialogue(''), null);
    assert.equal(extractItemFromDialogue(null), null);
    assert.equal(extractItemFromDialogue(undefined), null);
  });
});
