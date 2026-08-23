import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { V2Runtime } from '../../../../../apps/minecraft-companion/src/bot/v2/v2Runtime.js';
import { createMockBot } from './mocks/index.js';

function createRuntime(): { runtime: V2Runtime; bot: ReturnType<typeof createMockBot> } {
  const bot = createMockBot();
  const runtime = new V2Runtime({
    game: bot.game,
    nav: bot.nav,
    embodied: false,
    ownerName: 'TestOwner',
    botName: 'MineFriend',
    tickMs: 20,
    blockingExecute: true,
    dbPath: ':memory:',
    worldMapDbPath: ':memory:',
    chatMemoryDbPath: ':memory:',
  });
  return { runtime, bot };
}

describe('BUG-CROSS-32 · V2Runtime stop', () => {
  it('先终止 MainBrain，再取消任务并关闭异步队列；重复 stop 安全', () => {
    const { runtime, bot } = createRuntime();
    runtime.start();
    const task = runtime.tasks.createTask('guard_request', {}, { label: 'old task' });
    runtime.tasks.start(task.id, runtime.perception.perceive());

    runtime.stop();

    assert.equal(runtime.tasks.getById(task.id)?.state, 'cancelled');
    assert.equal(runtime.asyncQueue.isClosed, true);
    assert.equal((runtime.mainBrain as unknown as { closed: boolean }).closed, true);
    assert.ok(bot.nav.calls.stop >= 1, 'stop 必须兜底停止导航');

    const chatsBefore = bot.game.calls.chat.length;
    runtime.injectOwnerChat('停止后的迟到消息');
    assert.equal(bot.game.calls.chat.length, chatsBefore);
    assert.doesNotThrow(() => runtime.stop());
  });

  it('detach 只卸载身体，不关闭纯聊天大脑与队列', () => {
    const { runtime } = createRuntime();
    runtime.start();
    runtime.detachBody();

    assert.equal((runtime.mainBrain as unknown as { closed: boolean }).closed, false);
    assert.equal(runtime.asyncQueue.isClosed, false);

    runtime.stop();
  });
});
