/**
 * SpeechThinkingCorrelator 单元测试（FEAT-WEBUI-09）
 * 框架：node:test + node:assert/strict
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { SpeechThinkingCorrelator, type ChatMeta } from '../../../../../../apps/minecraft-companion/src/bot/v2/decision/speechThinkingCorrelator.js';

function makeCorrelator() {
  const emitted: Array<{ text: string; meta: ChatMeta }> = [];
  const cor = new SpeechThinkingCorrelator((text, meta) => emitted.push({ text, meta }));
  return { cor, emitted };
}

describe('SpeechThinkingCorrelator', () => {
  it('本轮思考绑到本轮 say（turnId + thinking）', () => {
    const { cor, emitted } = makeCorrelator();
    cor.observe('l7.turn_started', {});
    cor.observe('l7.thought', { thought: '主人不在' });
    cor.observe('l7.thought', { thought: '挖点圆石' });
    cor.observe('speech.committed', { text: '我去挖圆石了', turnId: 'brain-turn-1' });

    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].text, '我去挖圆石了');
    assert.equal(emitted[0].meta.thinking, '主人不在\n挖点圆石');
    assert.equal(emitted[0].meta.turnId, 'brain-turn-1');
  });

  it('无 thought 直接 say → thinking 为 undefined', () => {
    const { cor, emitted } = makeCorrelator();
    cor.observe('l7.turn_started', {});
    cor.observe('speech.committed', { text: '收到' });
    assert.equal(emitted[0].meta.thinking, undefined);
  });

  it('同一轮两次 say 都带本轮思考', () => {
    const { cor, emitted } = makeCorrelator();
    cor.observe('l7.turn_started', {});
    cor.observe('l7.thought', { thought: 'A' });
    cor.observe('speech.committed', { text: '第一句' });
    cor.observe('speech.committed', { text: '第二句' });
    assert.equal(emitted[0].meta.thinking, 'A');
    assert.equal(emitted[1].meta.thinking, 'A');
  });

  it('turn 收尾后清空：turn 外的旁白 say 不带残留思考', () => {
    const { cor, emitted } = makeCorrelator();
    cor.observe('l7.turn_started', {});
    cor.observe('l7.thought', { thought: '上一轮的思考' });
    cor.observe('speech.committed', { text: '回答' });
    cor.observe('l7.turn_finished', {});
    // 旁白/反射 say（无 turn 包裹）
    cor.observe('speech.committed', { text: '附近有怪小心' });
    assert.equal(emitted[1].text, '附近有怪小心');
    assert.equal(emitted[1].meta.thinking, undefined);
    assert.equal(emitted[1].meta.turnId, undefined);
  });

  it('新 turn 重置思考，不串到下一轮', () => {
    const { cor, emitted } = makeCorrelator();
    cor.observe('l7.turn_started', {});
    cor.observe('l7.thought', { thought: '第一轮' });
    cor.observe('speech.committed', { text: 'r1' });
    cor.observe('l7.idle_turn_started', {});
    cor.observe('l7.thought', { thought: '第二轮' });
    cor.observe('speech.committed', { text: 'r2' });
    assert.equal(emitted[1].meta.thinking, '第二轮');
    assert.equal(emitted[1].meta.turnId, 'turn-2');
  });

  it('空白 thought 被忽略', () => {
    const { cor, emitted } = makeCorrelator();
    cor.observe('l7.turn_started', {});
    cor.observe('l7.thought', { thought: '   ' });
    cor.observe('speech.committed', { text: 'x' });
    assert.equal(emitted[0].meta.thinking, undefined);
  });
});
