import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { BrainSpeechGateway } from '../../../../../../apps/minecraft-companion/src/bot/v2/decision/brainSpeechGateway.js';
import { isTaskCancellationRequest, stripTaskCancellationPrefix } from '../../../../../../apps/minecraft-companion/src/bot/v2/decision/mainBrain.js';
import { EventBusV2 } from '../../../../../../apps/minecraft-companion/src/bot/v2/infra/eventBus.js';
import type { GameAdapter } from '../../../../../../apps/minecraft-companion/src/bot/adapter/GameAdapter.js';

describe('BUG-CROSS-48 · BrainSpeechGateway', () => {
  it('只有当前 MainBrain 回合能同时提交 Minecraft 与 UI 发言', () => {
    const bus = new EventBusV2();
    const gameChat: string[] = [];
    const committed: Array<Record<string, unknown>> = [];
    bus.on('speech.committed', ev => committed.push(ev.payload as Record<string, unknown>));
    const game = { chat: (text: string) => gameChat.push(text) } as unknown as GameAdapter;
    const gateway = new BrainSpeechGateway(bus, game, () => true);

    assert.equal(gateway.commit('旁路文本'), false);
    gateway.beginTurn('turn-a');
    assert.equal(gateway.commit('大脑决定的文本', 'say'), true);

    assert.deepEqual(gameChat, ['大脑决定的文本']);
    assert.equal(committed.length, 1);
    assert.equal(committed[0]?.text, '大脑决定的文本');
    assert.equal(committed[0]?.turnId, 'turn-a');
    assert.equal(typeof committed[0]?.decisionId, 'string');
  });

  it('取消递增 epoch 后拒绝旧回合迟到发言', () => {
    const bus = new EventBusV2();
    const gameChat: string[] = [];
    const game = { chat: (text: string) => gameChat.push(text) } as unknown as GameAdapter;
    const gateway = new BrainSpeechGateway(bus, game, () => true);

    gateway.beginTurn('stale-turn');
    gateway.invalidate('owner_cancel');
    assert.equal(gateway.commit('迟到输出'), false);
    assert.deepEqual(gameChat, []);
  });

  it('无身体时仍提交同一决策事件，但不写 Minecraft', () => {
    const bus = new EventBusV2();
    const committed: string[] = [];
    bus.on('speech.committed', ev => committed.push(String((ev.payload as { text?: string }).text ?? '')));
    const game = { chat: () => { throw new Error('must not chat'); } } as unknown as GameAdapter;
    const gateway = new BrainSpeechGateway(bus, game, () => false);
    gateway.beginTurn('companion-turn');

    assert.equal(gateway.commit('只显示在 UI'), true);
    assert.deepEqual(committed, ['只显示在 UI']);
  });
});

describe('BUG-CROSS-48 · cancellation command parsing', () => {
  it('纯停止不生成新指令，复合停止只保留新目标', () => {
    assert.equal(isTaskCancellationRequest('停止当前任务'), true);
    assert.equal(stripTaskCancellationPrefix('停止当前任务'), null);
    assert.equal(stripTaskCancellationPrefix('停止当前任务，然后改成跟着我'), '跟着我');
    assert.equal(isTaskCancellationRequest('如果失败就停止'), false);
  });
});
