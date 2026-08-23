/**
 * sanitizeSpeech 单元测试（FEAT-WEBUI-09）
 * 框架：node:test + node:assert/strict
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { sanitizeSpeech } from '../../../../../../apps/minecraft-companion/src/bot/v2/infra/sanitizeSpeech.js';

describe('sanitizeSpeech', () => {
  it('剥成对 <think>…</think>', () => {
    assert.equal(sanitizeSpeech('<think>盘算一下</think>主人我来了'), '主人我来了');
  });

  it('剥跨行 + 大小写不敏感的 think 标签', () => {
    assert.equal(sanitizeSpeech('<THINK>\n第一行\n第二行\n</THINK>好的'), '好的');
  });

  it('剥只开不闭的 <think> 残段', () => {
    assert.equal(sanitizeSpeech('主人稍等<think>我还在想没说完'), '主人稍等');
  });

  it('剥 LLM 误把动作当文字吐的 JSON 段', () => {
    assert.equal(sanitizeSpeech('{"thought":"x","action":{"tool":"say"}}好的'), '好的');
  });

  it('不误伤正常含尖括号的文本', () => {
    assert.equal(sanitizeSpeech('血量 <5 很危险'), '血量 <5 很危险');
  });

  it('整段都是思考 → 返回空串（调用方走兜底/跳过）', () => {
    assert.equal(sanitizeSpeech('<think>纯思考没有回答</think>'), '');
  });

  it('空输入安全', () => {
    assert.equal(sanitizeSpeech(''), '');
    assert.equal(sanitizeSpeech(null), '');
    assert.equal(sanitizeSpeech(undefined), '');
  });

  it('收敛多余空白', () => {
    assert.equal(sanitizeSpeech('  你好  \n\n\n\n世界  '), '你好\n\n世界');
  });
});
