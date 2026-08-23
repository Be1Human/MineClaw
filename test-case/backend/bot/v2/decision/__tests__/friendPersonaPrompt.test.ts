import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildMainBrainSystemPrompt,
  formatConversationHistory,
  sanitizeRoleContext,
} from '../../../../../../apps/minecraft-companion/src/bot/v2/decision/systemPrompt.js';

describe('BUG-CROSS-46 · 平等好友角色契约', () => {
  it('角色背景进入最高优先级契约，且禁止主仆与机械待命', () => {
    const prompt = buildMainBrainSystemPrompt({
      botName: '兰依',
      ownerName: 'qxy',
      persona: '喜欢生存建造，有点俏皮，也有自己的主见',
    });

    assert.match(prompt, /你是 兰依/);
    assert.match(prompt, /平等、熟悉的游戏好友/);
    assert.match(prompt, /喜欢生存建造，有点俏皮/);
    assert.match(prompt, /不要称呼对方为“主人”/);
    assert.match(prompt, /唯一对朋友说话、操作游戏并对结果负责的伙伴/);
    assert.match(prompt, /都是你的内部能力/);
    assert.match(prompt, /用第一人称描述为“我在做”/);
    assert.match(prompt, /普通闲聊不查询或汇报游戏位置、背包、血量/);
    assert.doesNotMatch(prompt, /陪伴主人的 AI bot|主人的玩家名|主人\(/);
  });

  it('BUG-CROSS-47 · Prompt 只要求原生工具调用，不再强制旧动作 JSON', () => {
    const prompt = buildMainBrainSystemPrompt({ botName: '兰依', ownerName: 'qxy' });

    assert.match(prompt, /原生工具调用接口/);
    assert.match(prompt, /普通聊天直接调用 say/);
    assert.doesNotMatch(prompt, /每次回复严格用 JSON|"thought"\s*:\s*"你的思考"|"action"\s*:/);
    assert.match(prompt, /唯一对朋友说话、操作游戏并对结果负责的伙伴/);
    assert.match(prompt, /不要复述内部组件名、task ID、running\/paused/);
  });

  it('BUG-CROSS-65 · 历史用户标签保持中性，不把关系词当称呼', () => {
    const history = formatConversationHistory([{
      id: 'c1', turnId: 't1', role: 'owner', content: '晚上一起玩吗', timestamp: 1,
      meta: { source: 'web_ui' },
    }]);

    assert.match(history, /用户\(/);
    assert.doesNotMatch(history, /主人/);
  });

  it('旧版本主仆话术不再进入对话历史和记忆上下文', () => {
    const history = formatConversationHistory([
      { id: 'c1', turnId: 't1', role: 'bot', content: '主人主人，我一直待命等你指令', timestamp: 1 },
      { id: 'c2', turnId: 't2', role: 'owner', content: '晚上一起玩吗', timestamp: 2 },
    ]);
    const memory = sanitizeRoleContext('共同约定：晚上一起挖矿\n旧回复：随时准备听你安排');

    assert.doesNotMatch(history, /主人|待命|指令/);
    assert.match(history, /晚上一起玩吗/);
    assert.equal(memory, '共同约定：晚上一起挖矿');
  });

  it('旧 bot 的身份分裂措辞只在 prompt 视图归一化，用户原话保持不变', () => {
    const history = formatConversationHistory([
      { id: 'c1', turnId: 't1', role: 'bot', content: '系统还在跑合成任务（task-420 running），不是我在操作', timestamp: 1 },
      { id: 'c2', turnId: 't2', role: 'owner', content: '为什么叫系统？', timestamp: 2, meta: { source: 'web_ui' } },
    ]);

    assert.match(history, /你\(.+\): 我还在跑合成任务/);
    assert.match(history, /用户\(.+\): 为什么叫系统/);
    assert.doesNotMatch(history, /task-420|running|不是我在操作/);
  });

  it('BUG-CROSS-65 · 通用 ownerName 不被投影成口头称呼', () => {
    const prompt = buildMainBrainSystemPrompt({ botName: '兰依', ownerName: '朋友' });
    assert.match(prompt, /你和 对方 是平等、熟悉的游戏好友/);
    assert.match(prompt, /不要把“朋友、玩家、用户、对方”等通用关系词作为句首口头称呼/);
    assert.doesNotMatch(prompt, /你和 朋友 是/);
  });

  it('离线时不把旧坐标和生存状态当作当前事实注入', () => {
    const context = [
      '偏好：喜欢晚上挖矿',
      '当前位置：(1216, -60, 0)，还在矿洞里，状态满格',
      '背包：空；满血满食物',
    ].join('\n');

    const offline = sanitizeRoleContext(context, false);
    assert.match(offline, /喜欢晚上挖矿/);
    assert.doesNotMatch(offline, /1216|矿洞里|背包|满血/);
    assert.match(sanitizeRoleContext(context, true), /1216/);
  });
});
