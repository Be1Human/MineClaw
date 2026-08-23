import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { MainBrain, type MainBrainDeps } from '../../../../../../apps/minecraft-companion/src/bot/v2/decision/mainBrain.js';
import { EventBusV2 } from '../../../../../../apps/minecraft-companion/src/bot/v2/infra/eventBus.js';
import { AsyncTaskQueue } from '../../../../../../apps/minecraft-companion/src/bot/v2/infra/asyncTaskQueue.js';
import { TaskRuntime } from '../../../../../../apps/minecraft-companion/src/bot/v2/task/taskRuntime.js';
import { ResourceResolver } from '../../../../../../apps/minecraft-companion/src/bot/v2/task/resourceResolver.js';
import { DecisionPolicy } from '../../../../../../apps/minecraft-companion/src/bot/v2/task/decisionPolicy.js';
import type { MemoryV2 } from '../../../../../../apps/minecraft-companion/src/bot/v2/infra/memory.js';
import type { LLMClient } from '../../../../../../apps/minecraft-companion/src/bot/v2/cognitive/llm/LLMClient.js';
import type { LLMToolCallResult } from '../../../../../../apps/minecraft-companion/src/bot/v2/cognitive/llm/types.js';
import type { GameAdapter } from '../../../../../../apps/minecraft-companion/src/bot/adapter/GameAdapter.js';
import type { PerceptionPipeline } from '../../../../../../apps/minecraft-companion/src/bot/v2/perception/pipeline.js';
import type { WorldStateView } from '../../../../../../apps/minecraft-companion/src/bot/v2/types.js';

async function flush(): Promise<void> {
  for (let i = 0; i < 12; i++) await new Promise<void>(resolve => setImmediate(resolve));
}

function world(): WorldStateView {
  return {
    tick: 1,
    timestamp: Date.now(),
    self: { position: { x: 0, y: 64, z: 0 }, yaw: 0, pitch: 0, health: 20, maxHealth: 20, food: 20, isOnGround: true },
    owner: { username: 'TestOwner', position: { x: 1, y: 64, z: 1 }, distance: 2, entityId: 1, isVisible: true },
    environment: { dimension: 'overworld', timeOfDay: 6000, isDay: true, isRaining: false },
    entities: [],
    inventory: { items: [], held: null, freeSlots: 36 },
    taskContext: null,
  };
}

function memory(records: unknown[]): MemoryV2 {
  return {
    scheduleCommit: () => {}, commitTick: () => 0,
    record: (_type: string, entry: unknown) => { records.push(entry); },
    query: () => [], setRuntime: () => {}, getRuntime: () => undefined, clearRuntime: () => {},
    snapshot: () => ({}), inspect: () => ({}), close: () => {},
  } as unknown as MemoryV2;
}

function build() {
  const bus = new EventBusV2();
  const records: unknown[] = [];
  const chats: string[] = [];
  const mem = memory(records);
  const tasks = new TaskRuntime(mem, bus);
  const asyncQueue = new AsyncTaskQueue(1);
  let resolveLlm!: (value: LLMToolCallResult | null) => void;
  let llmCalls = 0;
  let observedSignal: AbortSignal | undefined;
  const deferred = new Promise<LLMToolCallResult | null>(resolve => { resolveLlm = resolve; });
  const llm = {
    call: async () => null,
    callWithTools: async (args: { signal?: AbortSignal }) => {
      llmCalls += 1;
      observedSignal = args.signal;
      return deferred;
    },
  } as unknown as LLMClient;
  const game = { username: 'MineFriend', chat: (text: string) => chats.push(text), findBlocks: () => [], getInventoryItems: () => [] } as unknown as GameAdapter;
  const perception = { getWorldState: () => world(), perceive: () => world() } as unknown as PerceptionPipeline;
  const deps: MainBrainDeps = {
    bus, asyncQueue, llm, game, ownerName: 'TestOwner', memory: mem,
  };
  const brain = new MainBrain(deps, { ownerName: 'TestOwner', botName: 'MineFriend', idleEnabled: false });
  return { brain, bus, tasks, asyncQueue, records, chats, resolveLlm, getLlmCalls: () => llmCalls, getSignal: () => observedSignal };
}

describe('BUG-CROSS-32 · MainBrain shutdown', () => {
  it('stop 后迟到 LLM 不调用工具、不发布完成事件、不写记忆', async () => {
    const ctx = build();
    const events: string[] = [];
    ctx.bus.onAny(event => events.push(event.type));

    ctx.brain.handleDirectMessage('你好');
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(ctx.getLlmCalls(), 1);
    assert.equal(ctx.getSignal()?.aborted, false);

    const eventBoundary = events.length;
    ctx.brain.shutdown('test_stop');
    ctx.brain.shutdown('test_stop_again');
    assert.equal(ctx.getSignal()?.aborted, true);

    ctx.resolveLlm({ toolCalls: [{ id: 'late', name: 'say', arguments: { text: '迟到回复' } }], content: '' });
    await flush();

    assert.deepEqual(ctx.chats, []);
    assert.deepEqual(ctx.records, []);
    assert.deepEqual(events.slice(eventBoundary), ['brain.speech_epoch_changed']);
    assert.equal(ctx.asyncQueue.activeCount, 0);

    ctx.brain.handleDirectMessage('停止后新消息');
    ctx.bus.publish('chat.from_owner', 'suggestion', { sender: 'TestOwner', message: '总线迟到消息' });
    await flush();
    assert.equal(ctx.getLlmCalls(), 1);
  });

  it('shutdown 清理 GoalAgent 通知 timer/queue 并解除订阅', () => {
    const ctx = build();
    ctx.bus.publish('goalagent.notification', 'critical', {
      eventType:'danger',urgency:'critical',episodeKey:'danger-test',state:'opened',summary:'正在受到攻击',
    });
    const internals = ctx.brain as unknown as {
      taskFeedbackQueue: unknown[];
      taskFeedbackTimer: ReturnType<typeof setTimeout> | null;
      closed: boolean;
    };
    assert.equal(internals.taskFeedbackQueue.length, 1);
    assert.notEqual(internals.taskFeedbackTimer, null);

    ctx.brain.shutdown();
    assert.equal(internals.closed, true);
    assert.equal(internals.taskFeedbackQueue.length, 0);
    assert.equal(internals.taskFeedbackTimer, null);

    ctx.bus.publish('goalagent.notification', 'critical', { eventType:'danger',urgency:'critical',episodeKey:'danger-late',state:'opened',summary:'迟到攻击' });
    assert.equal(internals.taskFeedbackQueue.length, 0);
    assert.equal(internals.taskFeedbackTimer, null);
  });
});
