/**
 * FEAT-L7-16 · 任务终态闭环推送（task_feedback 通道）单元测试
 *
 * 钉死两条核心不变量：
 *   ① 角色通道正确：task_feedback 回执进【system 段】、user 位是中性占位（不冒充主人）
 *   ② 不污染对话历史：idle / task_feedback turn 不写 conversation 的 role:'owner'（修复 P3）
 *   ③ 入队去抖 + busy 让位：占用中不抢、队列不丢
 *   ④ 主人抢占反馈：立即 abort，主人先执行，被抢占批次重新入队
 *
 * Run: npm run test:v2
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { MainBrain, type MainBrainConfig, type MainBrainDeps } from '../../../../../../apps/minecraft-companion/src/bot/v2/decision/mainBrain.js';
import { EventBusV2 } from '../../../../../../apps/minecraft-companion/src/bot/v2/infra/eventBus.js';
import { TaskRuntime } from '../../../../../../apps/minecraft-companion/src/bot/v2/task/taskRuntime.js';
import { ResourceResolver } from '../../../../../../apps/minecraft-companion/src/bot/v2/task/resourceResolver.js';
import { InventoryProvider } from '../../../../../../apps/minecraft-companion/src/bot/v2/task/resourceProvider.js';
import { DecisionPolicy } from '../../../../../../apps/minecraft-companion/src/bot/v2/task/decisionPolicy.js';
import type { PerceptionPipeline } from '../../../../../../apps/minecraft-companion/src/bot/v2/perception/pipeline.js';
import type { GameAdapter } from '../../../../../../apps/minecraft-companion/src/bot/adapter/GameAdapter.js';
import type { WorldStateView } from '../../../../../../apps/minecraft-companion/src/bot/v2/types.js';
import type { LLMClient } from '../../../../../../apps/minecraft-companion/src/bot/v2/cognitive/llm/LLMClient.js';
import type { LLMToolCallResult } from '../../../../../../apps/minecraft-companion/src/bot/v2/cognitive/llm/types.js';
import type { MemoryV2 } from '../../../../../../apps/minecraft-companion/src/bot/v2/infra/memory.js';

async function flush(): Promise<void> {
  for (let i = 0; i < 12; i++) await new Promise<void>(r => setImmediate(r));
}

function makeWorld(): WorldStateView {
  return {
    tick: 1, timestamp: Date.now(),
    self: { position: { x: 0, y: 64, z: 0 }, yaw: 0, pitch: 0, health: 20, maxHealth: 20, food: 20, isOnGround: true },
    owner: { username: 'TestOwner', position: { x: 5, y: 64, z: 5 }, distance: 8, entityId: 1, isVisible: true },
    environment: { dimension: 'overworld', timeOfDay: 6000, isDay: true, isRaining: false },
    entities: [],
    inventory: { items: [], held: null, freeSlots: 36 },
    taskContext: null,
  };
}

/** 捕获 record 调用的 memory stub */
function makeCapturingMemory(records: Array<{ role: string; content: string }>): MemoryV2 {
  return {
    scheduleCommit: () => {}, commitTick: () => 0,
    record: (_t: string, e: unknown) => { const r = e as { role?: string; content?: string }; if (r.role) records.push({ role: r.role, content: r.content ?? '' }); },
    query: () => [], setRuntime: () => {}, getRuntime: () => undefined, clearRuntime: () => {},
    snapshot: () => ({}), inspect: () => ({}), close: () => {},
  } as unknown as MemoryV2;
}

function makeStubGame(): GameAdapter {
  return {
    username: 'MineFriend', getPosition: () => ({ x: 0, y: 64, z: 0 }), getDimension: () => 'overworld',
    findBlocks: () => [], chat: () => {}, getInventoryItems: () => [],
  } as unknown as GameAdapter;
}

function makeStubPerception(world: WorldStateView): PerceptionPipeline {
  return { getWorldState: () => world, perceive: () => world } as unknown as PerceptionPipeline;
}

/** mock LLM：始终回一个 say（结束 turn）；记录每次 callWithTools 的 messages */
function makeMockLLM(capture: { calls: Array<Array<{ role: string; content: string }>> }): LLMClient {
  return {
    call: async () => null,
    callWithTools: async (args: { messages: Array<{ role: string; content: string }> }): Promise<LLMToolCallResult | null> => {
      capture.calls.push(args.messages.map(m => ({ role: m.role, content: String(m.content ?? '') })));
      return { toolCalls: [{ id: 'c1', name: 'say', arguments: { text: '收到' } }], content: '' };
    },
  } as unknown as LLMClient;
}

function build(
  records: Array<{ role: string; content: string }>,
  capture: { calls: Array<Array<{ role: string; content: string }>> },
  opts: { taskFeedbackEnabled?: boolean; llm?: LLMClient } = {},
) {
  const bus = new EventBusV2();
  const memory = makeCapturingMemory(records);
  const tasks = new TaskRuntime(memory, bus);
  const resolver = new ResourceResolver(); resolver.register(new InventoryProvider());
  const cfg: MainBrainConfig = {
    ownerName: 'TestOwner', botName: 'MineFriend', idleEnabled: false,
    taskFeedbackEnabled: opts.taskFeedbackEnabled,
  };
  const deps: MainBrainDeps = {
    bus, game: makeStubGame(), ownerName: 'TestOwner', llm: opts.llm ?? makeMockLLM(capture), memory,
  };
  const brain = new MainBrain(deps, cfg);
  return { brain, bus, tasks };
}

describe('FEAT-L7-16 · task_feedback 通道', () => {
  it('BUG-CROSS-51 · GoalAgent 同一终态只入队一次', () => {
    const { brain, bus } = build([], { calls: [] });
    const b = brain as unknown as {
      taskFeedbackQueue: unknown[];
      taskFeedbackTimer: ReturnType<typeof setTimeout> | null;
    };
    const payload={requestId:'goal-1',status:'completed',summary:'已到达',evidence:[{type:'root_verdict',ref:'v1'}]};
    bus.publish('goalagent.report','info',payload);
    bus.publish('goalagent.report','info',payload);
    assert.equal(b.taskFeedbackQueue.length, 1);
    if (b.taskFeedbackTimer) clearTimeout(b.taskFeedbackTimer);
    brain.shutdown('test_done');
  });

  it('BUG-CROSS-48 · task_feedback 只暴露说、问、静默和读记忆', async () => {
    const toolsSeen: string[][] = [];
    const llm = {
      callWithTools: async (args: { tools: Array<{ function: { name: string } }> }) => {
        toolsSeen.push(args.tools.map(tool => tool.function.name).sort());
        return { toolCalls: [{ id: 'silent', name: 'stay_silent', arguments: {} }], content: '' };
      },
    } as unknown as LLMClient;
    const { brain } = build([], { calls: [] }, { llm });
    const rt = brain as unknown as { runTurn: (m: string, k: string) => Promise<unknown> };
    await rt.runTurn.call(brain, '内部事实', 'task_feedback');
    assert.deepEqual(toolsSeen[0], ['ask_master', 'say', 'stay_silent']);
    brain.shutdown('test_done');
  });

  it('BUG-CROSS-51 · 旧 TaskRuntime 终态不再进入 MainBrain 反馈队列', () => {
    const enabled = build([], { calls: [] });
    const disabled = build([], { calls: [] }, { taskFeedbackEnabled: false });
    const enabledBrain = enabled.brain as unknown as {
      taskFeedbackQueue: unknown[];
      taskFeedbackTimer: ReturnType<typeof setTimeout> | null;
    };
    const disabledBrain = disabled.brain as unknown as {
      taskFeedbackQueue: unknown[];
      taskFeedbackTimer: ReturnType<typeof setTimeout> | null;
    };

    const enabledTask = enabled.tasks.createTask('guard_request', {}, { feedbackPolicy: 'user_visible' });
    const disabledTask = disabled.tasks.createTask('guard_request', {}, {});
    enabled.bus.publish('task.completed', 'info', {
      taskId: enabledTask.id,
      feedbackPolicy: 'user_visible',
      feedbackRootId: enabledTask.id,
      feedbackGeneration: 0,
    });
    disabled.bus.publish('task.completed', 'info', { taskId: disabledTask.id, detail: 'done' });
    disabled.bus.publish('task.failed', 'recoverable', { taskId: disabledTask.id, reason: 'failed' });
    disabled.bus.publish('task.cancelled', 'info', { taskId: disabledTask.id, reason: 'eval_reset' });

    assert.equal(enabledBrain.taskFeedbackQueue.length, 0, '旧 task.completed 不得绕过 GoalAgentPort');
    assert.equal(disabledBrain.taskFeedbackQueue.length, 0, '旧任务终态不得进入反馈队列');
    assert.equal(disabledBrain.taskFeedbackTimer, null, '旧任务终态不得创建反馈 timer');

    if (enabledBrain.taskFeedbackTimer) clearTimeout(enabledBrain.taskFeedbackTimer);
    enabledBrain.taskFeedbackTimer = null;
    enabledBrain.taskFeedbackQueue.length = 0;
  });

  it('① owner turn 记 role:owner；task_feedback turn 不记 owner（system 通道）', async () => {
    const records: Array<{ role: string; content: string }> = [];
    const capture = { calls: [] as Array<Array<{ role: string; content: string }>> };
    const { brain } = build(records, capture);
    const rt = brain as unknown as { runTurn: (m: string, k: string) => Promise<unknown> };

    // owner turn → 应有 owner 记录
    await rt.runTurn.call(brain, '主人说的话', 'owner');
    await flush();
    assert.ok(records.some(r => r.role === 'owner' && r.content === '主人说的话'), 'owner turn 应记 role:owner');

    // task_feedback turn → 绝不应有 owner 记录含回执内容
    const before = records.length;
    await rt.runTurn.call(brain, '· 「走到金块」✅ 成功', 'task_feedback');
    await flush();
    const newOwner = records.slice(before).filter(r => r.role === 'owner');
    assert.equal(newOwner.length, 0, 'task_feedback turn 不得写任何 owner 记录');
  });

  it('② task_feedback：回执进 system 段、user 位是中性占位（不冒充主人）', async () => {
    const records: Array<{ role: string; content: string }> = [];
    const capture = { calls: [] as Array<Array<{ role: string; content: string }>> };
    const { brain } = build(records, capture);
    const rt = brain as unknown as { runTurn: (m: string, k: string) => Promise<unknown> };

    await rt.runTurn.call(brain, '· 「走到金块」✅ 成功', 'task_feedback');
    await flush();

    assert.ok(capture.calls.length >= 1, 'LLM 应被调用');
    const msgs = capture.calls[0];
    // FEAT-CROSS-28: 回执走受控 context 消息（标注内部来源），不再进 system。
    const context = msgs.find(m => m.role === 'user' && m.content.includes('执行进展'))?.content ?? '';
    const user = msgs.find(m => m.role === 'user' && m.content.includes('[内部状态触发'))?.content ?? '';
    assert.ok(context.includes('· 「走到金块」✅ 成功'), '回执内容应在 context 消息');
    assert.ok(context.includes('不是朋友说的话'), 'context 应标注非朋友发言');
    assert.ok(context.includes('这些事都是你在做'), 'context 应明确回执属于伙伴自身执行');
    assert.ok(!context.includes('系统反馈'), '模型可见标题不得制造外部系统主体');
    assert.ok(!user.includes('走到金块'), 'user 位不得含回执内容');
    assert.ok(user.includes('[内部状态触发，不是朋友发言]'), 'user 位应是中性占位');
  });

  it('③ 顶层任务终态入队；busy 时 spawn 让位不丢队列', async () => {
    const records: Array<{ role: string; content: string }> = [];
    const capture = { calls: [] as Array<Array<{ role: string; content: string }>> };
    const { brain, bus } = build(records, capture);
    const b = brain as unknown as {
      spawnTaskFeedbackTurn: () => Promise<void>;
      taskFeedbackQueue: unknown[];
      busyBy: string | null;
      taskFeedbackTimer: ReturnType<typeof setTimeout> | null;
    };

    bus.publish('goalagent.report','info',{requestId:'goal-busy',status:'completed',summary:'已到达',evidence:[]});
    assert.equal(b.taskFeedbackQueue.length, 1, '顶层任务终态应入队');

    // 模拟占用中 → spawn 应让位、不消费队列
    b.busyBy = 'owner';
    await b.spawnTaskFeedbackTurn.call(brain);
    assert.equal(b.taskFeedbackQueue.length, 1, 'busy 时队列不应被消费（让位重试）');

    // 清理：去抖/重试定时器会吊住事件循环，测完显式清掉
    if (b.taskFeedbackTimer) clearTimeout(b.taskFeedbackTimer);
    b.taskFeedbackTimer = null;
    b.taskFeedbackQueue.length = 0;
    b.busyBy = null;
  });

  it('④ SubAgent 进展进入 system feedback 队列，不伪装成主人消息', () => {
    const records: Array<{ role: string; content: string }> = [];
    const capture = { calls: [] as Array<Array<{ role: string; content: string }>> };
    const { brain, bus } = build(records, capture);
    const b = brain as unknown as {
      taskFeedbackQueue: Array<{ status: string; detail: string }>;
      taskFeedbackTimer: ReturnType<typeof setTimeout> | null;
      buildTaskFeedbackBlock: () => string;
    };

    bus.publish('goalagent.report', 'info', { summary: '正在重新规划采集路线' });
    assert.equal(b.taskFeedbackQueue.length, 1);
    assert.equal(b.taskFeedbackQueue[0]?.status, 'progress');
    assert.equal(b.taskFeedbackQueue[0]?.detail, '正在重新规划采集路线');
    assert.match(b.buildTaskFeedbackBlock(), /进行中.*重新规划采集路线/);
    assert.doesNotMatch(b.buildTaskFeedbackBlock(), /SubAgent/);

    if (b.taskFeedbackTimer) clearTimeout(b.taskFeedbackTimer);
    b.taskFeedbackTimer = null;
  });

  it('⑤ 去抖窗口内多条终态合并为一个 feedback turn', async () => {
    const records: Array<{ role: string; content: string }> = [];
    const capture = { calls: [] as Array<Array<{ role: string; content: string }>> };
    const { brain, bus } = build(records, capture);
    const b = brain as unknown as {
      spawnTaskFeedbackTurn: () => Promise<void>;
      taskFeedbackTimer: ReturnType<typeof setTimeout> | null;
    };

    bus.publish('goalagent.report','info',{requestId:'goal-first',status:'completed',summary:'先到金块旁：已到达',evidence:[]});
    bus.publish('goalagent.report','recoverable',{requestId:'goal-second',status:'failed',summary:'再原地待命：已取消',evidence:[]});
    if (b.taskFeedbackTimer) clearTimeout(b.taskFeedbackTimer);
    b.taskFeedbackTimer = null;

    await b.spawnTaskFeedbackTurn.call(brain);
    await flush();

    assert.equal(capture.calls.length, 1, '同一批回执只应触发一个 LLM turn');
    const context = capture.calls[0]?.find(m => m.role === 'user' && m.content.includes('执行进展'))?.content ?? '';
    assert.match(context, /先到金块旁.*已到达/s);
    assert.match(context, /再原地待命.*已取消/s);
    brain.shutdown('test_done');
  });

  it('⑥ 主人立即抢占 task_feedback，且被中止的反馈批次不丢失', async () => {
    const records: Array<{ role: string; content: string }> = [];
    const capture = { calls: [] as Array<Array<{ role: string; content: string }>> };
    let feedbackSignal: AbortSignal | undefined;
    const llm = {
      call: async () => null,
      callWithTools: async (args: {
        messages: Array<{ role: string; content: string }>;
        signal?: AbortSignal;
      }): Promise<LLMToolCallResult | null> => {
        capture.calls.push(args.messages.map(m => ({ role: m.role, content: String(m.content ?? '') })));
        if (capture.calls.length === 1) {
          feedbackSignal = args.signal;
          await new Promise<void>(resolve => {
            if (args.signal?.aborted) resolve();
            else args.signal?.addEventListener('abort', () => resolve(), { once: true });
          });
          return null;
        }
        return { toolCalls: [{ id: 'owner-say', name: 'say', arguments: { text: '主人消息已优先处理' } }], content: '' };
      },
    } as unknown as LLMClient;
    const { brain, bus } = build(records, capture, { llm });
    const b = brain as unknown as {
      spawnTaskFeedbackTurn: () => Promise<void>;
      taskFeedbackQueue: unknown[];
      taskFeedbackTimer: ReturnType<typeof setTimeout> | null;
      busyBy: string | null;
    };

    bus.publish('goalagent.report','info',{requestId:'goal-preempt',status:'completed',summary:'走到金块：已到达',evidence:[]});
    if (b.taskFeedbackTimer) clearTimeout(b.taskFeedbackTimer);
    b.taskFeedbackTimer = null;

    const feedbackTurn = b.spawnTaskFeedbackTurn.call(brain);
    await flush();
    assert.equal(b.busyBy, 'task_feedback');

    brain.handleDirectMessage('先回答我这句话');
    await feedbackTurn;
    await flush();

    assert.equal(feedbackSignal?.aborted, true, '主人消息应立即 abort 在途 feedback 请求');
    assert.ok(capture.calls.length >= 2, 'feedback 结束后应立即执行排队的主人 turn');
    const ownerUser = capture.calls[1]?.filter(m => m.role === 'user').map(m => m.content).join('\n') ?? '';
    assert.ok(ownerUser.includes('先回答我这句话'), '主人消息必须先于回放的 feedback 执行');
    assert.equal(b.taskFeedbackQueue.length, 0, '被抢占的反馈应合并进紧随其后的主人回合，不再重复唤醒');
    const ownerContext = capture.calls[1]?.filter(m => m.role === 'user').map(m => m.content).join('\n') ?? '';
    assert.match(ownerContext, /走到金块.*已到达/s, '主人回合必须收到被抢占的内部事实');

    brain.shutdown('test_done');
  });

  it('BUG-CROSS-48 · 取消屏障清空旧批次并拒绝迟到模型发言', async () => {
    const llm = {
      callWithTools: async (args: { signal?: AbortSignal }): Promise<LLMToolCallResult | null> => {
        await new Promise<void>(resolve => {
          if (args.signal?.aborted) resolve();
          else args.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        return { toolCalls: [{ id: 'late', name: 'say', arguments: { text: '旧任务迟到输出' } }], content: '' };
      },
    } as unknown as LLMClient;
    const { brain, bus } = build([], { calls: [] }, { llm });
    const committed: string[] = [];
    bus.on('speech.committed', ev => committed.push(String((ev.payload as { text?: string }).text ?? '')));
    const b = brain as unknown as {
      spawnTaskFeedbackTurn: () => Promise<void>;
      taskFeedbackQueue: unknown[];
      taskFeedbackTimer: ReturnType<typeof setTimeout> | null;
      busyBy: string | null;
    };
    bus.publish('goalagent.report','info',{requestId:'goal-old',status:'completed',summary:'旧进度',evidence:[]});
    if (b.taskFeedbackTimer) clearTimeout(b.taskFeedbackTimer);
    b.taskFeedbackTimer = null;

    const running = b.spawnTaskFeedbackTurn.call(brain);
    await flush();
    assert.equal(b.busyBy, 'task_feedback');
    brain.cancelTaskContext('owner_cancel');
    await running;
    await flush();

    assert.deepEqual(committed, []);
    assert.equal(b.taskFeedbackQueue.length, 0);
    assert.equal(b.busyBy, null);
    brain.shutdown('test_done');
  });
});
