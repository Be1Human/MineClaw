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
    assert.equal(runtime.body.busy(),false,'无身体的会话不应残留执行租约');
    assert.equal(bot.nav.calls.stop,0,'没有受控动作时，不再裸写导航停止接口');

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

  it('配置 LLM 时周期记忆默认开启并可热停恢复，基础记忆关闭时不创建调度器', () => {
    const bot = createMockBot();
    const runtime = new V2Runtime({
      game: bot.game,
      nav: bot.nav,
      embodied: false,
      ownerName: 'TestOwner',
      botName: 'MemoryScheduler',
      dbPath: ':memory:',
      worldMapDbPath: ':memory:',
      chatMemoryDbPath: ':memory:',
      llm: { apiKey: 'test-key', baseUrl: 'http://127.0.0.1:1', model: 'test-model' },
    });
    try {
      assert.ok(runtime.memoryConsolidationScheduler);
      assert.equal(runtime.getMemoryConsolidationCapability().enabled, true);
      runtime.start();
      assert.equal(runtime.memoryConsolidationScheduler?.status().running, true);
      assert.equal(runtime.setMemoryConsolidationEnabled(false).state, 'disabled');
      assert.equal(runtime.memoryConsolidationScheduler?.status().running, false);
      runtime.chatMemory.recordMessage({
        id: 'memory-toggle-explicit', sessionId: 'toggle', role: 'owner', content: '请记住我喜欢吃鱼', timestamp: 1,
      });
      assert.equal(runtime.chatMemory.recentMessages(5)[0]?.id, 'memory-toggle-explicit');
      assert.ok(runtime.chatMemory.getMemorySlotValues({ status: 'active' })
        .some(value => String(value.value).includes('鱼')));
      assert.equal(runtime.setMemoryConsolidationEnabled(true).enabled, true);
      assert.equal(runtime.memoryConsolidationScheduler?.status().running, true);
    } finally {
      runtime.stop();
    }
    assert.equal(runtime.memoryConsolidationScheduler?.status().running, false);

    const preferenceDisabled = new V2Runtime({
      game: bot.game,
      nav: bot.nav,
      embodied: false,
      ownerName: 'TestOwner',
      botName: 'MemoryConsolidationDisabled',
      dbPath: ':memory:',
      worldMapDbPath: ':memory:',
      chatMemoryDbPath: ':memory:',
      chatMemoryConsolidationEnabled: false,
      llm: { apiKey: 'test-key', baseUrl: 'http://127.0.0.1:1', model: 'test-model' },
    });
    assert.ok(preferenceDisabled.memoryConsolidationScheduler);
    preferenceDisabled.start();
    assert.equal(preferenceDisabled.memoryConsolidationScheduler?.status().running, false);
    preferenceDisabled.setMemoryConsolidationEnabled(true);
    assert.equal(preferenceDisabled.memoryConsolidationScheduler?.status().running, true);
    preferenceDisabled.stop();

    const disabled = new V2Runtime({
      game: bot.game,
      nav: bot.nav,
      embodied: false,
      ownerName: 'TestOwner',
      botName: 'MemoryDisabled',
      dbPath: ':memory:',
      worldMapDbPath: ':memory:',
      chatMemoryDbPath: ':memory:',
      chatMemoryAutoCapture: false,
      llm: { apiKey: 'test-key', baseUrl: 'http://127.0.0.1:1', model: 'test-model' },
    });
    assert.equal(disabled.memoryConsolidationScheduler, null);
    disabled.start();
    disabled.stop();
  });
});
