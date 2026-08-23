import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { classifyGoalRequest, classifyOwnerTurn } from '../../../../../../../apps/minecraft-companion/src/bot/v2/decision/goalAgentPort/goalRequestClassifier.js';

describe('GoalAgent request classifier', () => {
  it('BUG-CROSS-62 · 把箱间搬运指令识别为动作', () => {
    const request = '把左边箱子里的八根橡木原木搬到右边箱子';

    assert.equal(classifyOwnerTurn(request), 'game_action');
    assert.equal(classifyGoalRequest(request), 'action');
    assert.equal(classifyOwnerTurn('帮我搬运这些圆石到箱子里'), 'game_action');
  });

  it('BUG-CROSS-62 · 纯箱子询问仍识别为查询', () => {
    assert.equal(classifyOwnerTurn('右边箱子里有什么？'), 'game_query');
    assert.equal(classifyGoalRequest('右边箱子里有什么？'), 'query');
  });

  it('BUG-CROSS-73-005 · 取消安全栅栏与 ingress 共用同一意图', () => {
    for (const request of ['别跟了', '别挖了', '不用跟了', '停止当前任务']) {
      assert.equal(classifyOwnerTurn(request), 'game_cancel', request);
      assert.equal(classifyGoalRequest(request), 'cancel', request);
    }
    assert.notEqual(classifyOwnerTurn('如果失败就别挖了'), 'game_cancel');
    for (const discussion of ['为什么别跟了？', '聊聊别跟了的设计']) {
      assert.equal(classifyOwnerTurn(discussion), 'chat', discussion);
    }
  });
});
