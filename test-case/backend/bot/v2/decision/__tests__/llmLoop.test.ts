/**
 * L7 · LLMToolLoop 单元测试（FEAT-L7-07 升级版 · function calling 路线）
 * 框架：node:test + node:assert/strict
 *
 * 覆盖：
 *   C-01 · 单轮 say → 正常结束
 *   C-02 · 单轮 ask_master → pendingAskMaster=true，history 含 ask_master
 *   C-03 · LLM 返回 null → 兜底 say 结束
 *   C-04 · 无 tool_calls 但有 content → content 转 say 结束
 *   C-05 · 超过 maxRounds → 兜底 say
 *   C-06 · resume turn：priorHistory 还原为 assistant+tool 消息对
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  LLMToolLoop,
  llmFailureMessage,
  parseLegacyActionJson,
  restoreMainBrainPendingHistory,
  serializeMainBrainPendingHistory,
  stripLeakedActionJson,
  type HistoryEntry,
} from '../../../../../../apps/minecraft-companion/src/bot/v2/decision/llmLoop.js';
import type { ToolRegistry } from '../../../../../../apps/minecraft-companion/src/bot/v2/decision/tools/toolRegistry.js';
import type { ToolCall, ToolResult } from '../../../../../../apps/minecraft-companion/src/bot/v2/decision/tools/types.js';
import type { LLMClient } from '../../../../../../apps/minecraft-companion/src/bot/v2/cognitive/llm/LLMClient.js';
import type { LLMChatMessage, LLMToolCallResult } from '../../../../../../apps/minecraft-companion/src/bot/v2/cognitive/llm/types.js';
import { MainBrainLoopCritic } from '../../../../../../apps/minecraft-companion/src/bot/v2/decision/loopCritic.js';
import type { EventBusV2 } from '../../../../../../apps/minecraft-companion/src/bot/v2/infra/eventBus.js';
import { buildMainBrainSystemPrompt } from '../../../../../../apps/minecraft-companion/src/bot/v2/decision/systemPrompt.js';
import { LlmTraceEventStore } from '../../../../../../apps/minecraft-companion/src/bot/v2/infra/llmTrace/index.js';
import { canonicalizeChatMessages } from '../../../../../../apps/minecraft-companion/src/bot/v2/cognitive/llm/canonical.js';
import {
  ResponsesCodec,
  decideResponsesReplay,
} from '../../../../../../apps/minecraft-companion/src/bot/v2/cognitive/llm/responsesCodec.js';
import { ChatCompletionsCodec } from '../../../../../../apps/minecraft-companion/src/bot/v2/cognitive/llm/chatCompletionsCodec.js';

// ─────────── 测试夹具 ───────────

type CapturedCall = {
  messages: LLMChatMessage[];
  toolChoice?: 'auto' | 'none' | { type: 'function'; function: { name: string } };
};

/** 创建 mock LLMClient.callWithTools，responses 队列依次弹出。超出队列后返回 null。 */
function makeMockLLM(responses: (LLMToolCallResult | null)[]): {
  llm: LLMClient;
  capturedCalls: CapturedCall[];
} {
  const queue = [...responses];
  const capturedCalls: CapturedCall[] = [];
  const llm = {
    callWithTools: async (args: CapturedCall): Promise<LLMToolCallResult | null> => {
      capturedCalls.push({ messages: args.messages, ...(args.toolChoice ? { toolChoice: args.toolChoice } : {}) });
      return queue.shift() ?? null;
    },
  } as unknown as LLMClient;
  return { llm, capturedCalls };
}

function makeMockDispatcher(): {
  dispatcher: ToolRegistry;
  sayCalls: string[];
  askCalls: string[];
  worldStateCalls: number;
} {
  const sayCalls: string[] = [];
  const askCalls: string[] = [];
  let worldStateCalls = 0;

  // FEAT-L7-13 · mock ToolRegistry：call + get（terminal 语义）+ schema 生成
  const TERMINALS: Record<string, 'end_turn' | 'ask_master'> = {
    say: 'end_turn',
    complete_task: 'end_turn',
    ask_master: 'ask_master',
  };
  const dispatcher: ToolRegistry = {
    call: (use: ToolCall): ToolResult => {
      if (use.tool === 'say') {
        sayCalls.push(use.input.text as string);
        return { ok: true, result: { ok: true } };
      }
      if (use.tool === 'ask_master') {
        askCalls.push(use.input.text as string);
        return { ok: true, result: { ok: true, pending: true } };
      }
      if (use.tool === 'get_world_state') {
        worldStateCalls++;
        return {
          ok: true,
          result: {
            tick: 0,
            self: { position: { x: 0, y: 64, z: 0 } },
            inventory: { items: [], held: null, freeSlots: 36 },
            entities: [],
          },
        };
      }
      if (use.tool === 'complete_task') {
        return { ok: true, result: { ok: true } };
      }
      return { ok: false, result: { error: `unknown tool: ${use.tool}` } };
    },
    get: (name: string) => (TERMINALS[name] ? { name, terminal: TERMINALS[name] } : undefined),
    toLLMSchemas: () => [],
    subset: () => [],
    unknownNames: () => [],
  } as unknown as ToolRegistry;

  return { dispatcher, sayCalls, askCalls, worldStateCalls };
}

/** 构造 function calling 返回（toolCalls）的辅助函数 */
function fcResponse(name: string, args: Record<string, unknown>, content = ''): LLMToolCallResult {
  return {
    toolCalls: [{ id: `call_${name}_${Math.random().toString(36).slice(2, 6)}`, name, arguments: args }],
    content,
  };
}

function sayResp(text = '好的！'): LLMToolCallResult { return fcResponse('say', { text }); }
function askResp(text = '要 A 还是 B？'): LLMToolCallResult { return fcResponse('ask_master', { text }); }
function worldResp(): LLMToolCallResult { return fcResponse('get_world_state', {}); }

function responsesAskResp(): LLMToolCallResult {
  const usage = {
    inputTokens: 20, outputTokens: 5, totalTokens: 25,
    cacheStatus: 'reported' as const, source: 'openai-responses',
  };
  return {
    content: '',
    toolCalls: [{ id: 'call-responses-ask', name: 'ask_master', arguments: { text: '要 A 还是 B？' } }],
    usage,
    canonical: {
      content: [
        { kind: 'reasoning', text: '' },
        { kind: 'tool-call', id: 'call-responses-ask', name: 'ask_master', arguments: { text: '要 A 还是 B？' } },
      ],
      usage,
      replay: {
        kind: 'openai-native', version: 1, api: 'openai-responses',
        providerRoute: 'route-responses', model: 'gpt-test',
        blocks: [
          { id: 'rs-main', type: 'reasoning', status: 'completed', encrypted_content: 'opaque-main', summary: [] },
          { id: 'fc-main', type: 'function_call', status: 'completed', call_id: 'call-responses-ask' },
        ],
      },
    },
  };
}

function responsesTextResp(text: string): LLMToolCallResult {
  const usage = {
    inputTokens: 10, outputTokens: 4, totalTokens: 14,
    cacheStatus: 'reported' as const, source: 'openai-responses',
  };
  return {
    content: text,
    toolCalls: [],
    usage,
    canonical: {
      content: [{ kind: 'text', text }],
      usage,
      replay: {
        kind: 'openai-native', version: 1, api: 'openai-responses',
        providerRoute: 'route-responses', model: 'gpt-test',
        blocks: [{
          id: 'msg-rewrite', type: 'message', status: 'completed', role: 'assistant',
          content: [{ type: 'output_text', text, annotations: [] }],
        }],
      },
    },
  };
}

// ─────────── 测试套件 ───────────

describe('LLMToolLoop (function calling)', () => {

  it('FEAT-WEBUI-19 · MainBrain 调用标注完整 Context 并把委托桥写入统一轨迹', async () => {
    let capturedTraceContext: Parameters<LLMClient['callWithTools']>[0]['traceContext'];
    const llm = {
      callWithTools: async (args: Parameters<LLMClient['callWithTools']>[0]): Promise<LLMToolCallResult> => {
        capturedTraceContext = structuredClone(args.traceContext);
        return {
          content: '',
          toolCalls: [{
            id: 'delegate-tool-1',
            name: 'submit_goal_request',
            arguments: { requestText: '给我一块石头', requestKind: 'task' },
          }],
        };
      },
    } as unknown as LLMClient;
    const { dispatcher } = makeMockDispatcher();
    dispatcher.toLLMSchemas = () => [{
      type: 'function',
      function: {
        name: 'submit_goal_request',
        description: 'delegate',
        parameters: { type: 'object', properties: {} },
      },
    }];
    dispatcher.get = name => name === 'submit_goal_request'
      ? { name, terminal: 'end_turn' } as never
      : undefined;
    dispatcher.call = call => call.tool === 'submit_goal_request'
      ? { ok: true, result: { accepted: true, goalSessionId: 'goal-1' } }
      : { ok: false, result: { error: 'unexpected' } };
    const store = new LlmTraceEventStore({ filename: ':memory:', profileId: 'profile-a' });
    try {
      const loop = new LLMToolLoop(llm, dispatcher, {
        systemPrompt: 'system identity',
        maxRounds: 1,
        traceRecorder: store,
      }, () => {});
      await loop.run('给我一块石头', [], undefined, {
        traceContext: {
          correlationId: 'turn-1',
          interactionSessionId: 'turn-1',
          turn: 1,
        },
      });

      assert.equal(capturedTraceContext?.agent, 'mainbrain');
      assert.equal(capturedTraceContext?.interactionSessionId, 'turn-1');
      assert.equal(capturedTraceContext?.modelCallIndex, 1);
      assert.deepEqual(
        capturedTraceContext?.contextSources?.selected.map(source => source.kind),
        ['mainbrain_system', 'current_turn', 'tool_registry'],
      );
      const events = store.listEvents().events;
      assert.deepEqual(events.map(event => event.type), [
        'tool.call',
        'delegation.submitted',
        'tool.result',
        'delegation.accepted',
      ]);
      assert.equal(new Set(events.map(event => event.callId)).size, 1);
      assert.equal(events.every(event => event.interactionSessionId === 'turn-1'), true);
    } finally {
      store.close();
    }
  });

  it('BUG-CROSS-46 · 纯聊天与任务决策使用独立采样温度', async () => {
    const temperatures: number[] = [];
    const llm = {
      callWithTools: async (args: { temperature?: number }): Promise<LLMToolCallResult> => {
        temperatures.push(args.temperature ?? -1);
        return sayResp('行啊，晚上一起玩。');
      },
    } as unknown as LLMClient;
    const { dispatcher } = makeMockDispatcher();
    const chatDispatcher = {
      ...dispatcher,
      toLLMSchemas: () => [
        { type: 'function', function: { name: 'say', description: '', parameters: { type: 'object', properties: {} } } },
        { type: 'function', function: { name: 'save_memory', description: '', parameters: { type: 'object', properties: {} } } },
      ],
    } as unknown as ToolRegistry;
    const taskDispatcher = {
      ...dispatcher,
      toLLMSchemas: () => [
        { type: 'function', function: { name: 'say', description: '', parameters: { type: 'object', properties: {} } } },
        { type: 'function', function: { name: 'get_world_state', description: '', parameters: { type: 'object', properties: {} } } },
      ],
    } as unknown as ToolRegistry;

    await new LLMToolLoop(llm, chatDispatcher, { systemPrompt: 'sys', maxRounds: 1 }, () => {}).run('晚上玩吗');
    await new LLMToolLoop(llm, taskDispatcher, { systemPrompt: 'sys', maxRounds: 1 }, () => {}).run('来找我');

    assert.deepEqual(temperatures, [0.75, 0.2]);
  });

  it('BUG-CROSS-47 · 合法旧动作 JSON 转成统一工具调用并正常回复', async () => {
    const { llm } = makeMockLLM([{
      toolCalls: [],
      content: '{"thought":"自然回应","action":{"tool":"say","input":{"text":"今天挺闲的，刚在想晚上做点什么。"}}}',
    }]);
    const { dispatcher, sayCalls } = makeMockDispatcher();
    const dispatcherWithSay = {
      ...dispatcher,
      toLLMSchemas: () => [{
        type: 'function',
        function: { name: 'say', description: '', parameters: { type: 'object', properties: {} } },
      }],
    } as unknown as ToolRegistry;
    const loop = new LLMToolLoop(llm, dispatcherWithSay, { systemPrompt: 'sys', maxRounds: 1 }, () => {});

    await loop.run('今天过得怎么样');

    assert.deepEqual(sayCalls, ['今天挺闲的，刚在想晚上做点什么。']);
  });

  it('BUG-CROSS-47 · 未许可旧工具不会执行，并要求模型改用原生 tool_calls', async () => {
    const { llm, capturedCalls } = makeMockLLM([
      { toolCalls: [], content: '{"thought":"越权","action":{"tool":"delete_everything","input":{}}}' },
      sayResp('刚才输出格式错了。现在可以正常聊。'),
    ]);
    const { dispatcher, sayCalls } = makeMockDispatcher();
    const dispatcherWithSay = {
      ...dispatcher,
      toLLMSchemas: () => [{
        type: 'function',
        function: { name: 'say', description: '', parameters: { type: 'object', properties: {} } },
      }],
    } as unknown as ToolRegistry;
    const loop = new LLMToolLoop(llm, dispatcherWithSay, { systemPrompt: 'sys', maxRounds: 2 }, () => {});

    await loop.run('在做啥呢');

    assert.deepEqual(sayCalls, ['刚才输出格式错了。现在可以正常聊。']);
    const correction = capturedCalls[1]?.messages.find(message =>
      message.role === 'user' && message.content.includes('原生 tool_calls'));
    assert.ok(correction, '第二轮上下文应包含原生 tool_calls 纠错指令');
  });

  it('BUG-CROSS-48 · 协议无效且无法重试时不得由代码伪造角色回复', async () => {
    const { llm } = makeMockLLM([{
      toolCalls: [],
      content: '{"thought":"x","action":{"tool":123,"input":[]}}',
    }]);
    const { dispatcher, sayCalls } = makeMockDispatcher();
    const loop = new LLMToolLoop(llm, dispatcher, { systemPrompt: 'sys', maxRounds: 1 }, () => {});

    await loop.run('?');

    assert.deepEqual(sayCalls, []);
  });

  it('BUG-CROSS-46 · 隐式回复命中主仆口吻时拦截并重写', async () => {
    const { llm, capturedCalls } = makeMockLLM([
      responsesTextResp('我一直在原地待命等你指令。'),
      { toolCalls: [], content: '我刚在整理背包，晚上一起挖矿？' },
    ]);
    const { dispatcher, sayCalls } = makeMockDispatcher();
    const loop = new LLMToolLoop(llm, dispatcher, { systemPrompt: 'sys', maxRounds: 2 }, () => {});

    await loop.run('你在干嘛');

    assert.deepEqual(sayCalls, ['我刚在整理背包，晚上一起挖矿？']);
    const rewritePrompt = capturedCalls[1]?.messages.at(-1)?.content ?? '';
    assert.match(rewritePrompt, /平等熟人/);
    assert.match(rewritePrompt, /你在干嘛/);
    const rejectedDraft = capturedCalls[1]?.messages.find(message => message.role === 'assistant');
    assert.equal(rejectedDraft?.canonical?.source?.replay?.blocks[0]?.type, 'message');
  });

  it('BUG-CROSS-46 · 显式 say 命中主仆口吻时也不得发送', async () => {
    const { llm } = makeMockLLM([
      sayResp('主人主人，我随时待命。'),
      sayResp('我刚在看晚上的探险路线，你来不来？'),
    ]);
    const { dispatcher, sayCalls } = makeMockDispatcher();
    const loop = new LLMToolLoop(llm, dispatcher, { systemPrompt: 'sys', maxRounds: 2 }, () => {});

    await loop.run('干嘛呢');

    assert.deepEqual(sayCalls, ['我刚在看晚上的探险路线，你来不来？']);
  });

  it('BUG-CROSS-65 · 显式与隐式回复都移除句首通用朋友称呼', async () => {
    const explicit = makeMockLLM([sayResp('朋友，任务完成了')]);
    const explicitDispatcher = makeMockDispatcher();
    await new LLMToolLoop(explicit.llm, explicitDispatcher.dispatcher, {
      systemPrompt: 'sys', maxRounds: 1,
    }, () => {}).run('完成了吗');
    assert.deepEqual(explicitDispatcher.sayCalls, ['任务完成了']);

    const implicit = makeMockLLM([{ toolCalls: [], content: '老朋友，你来啦' }]);
    const implicitDispatcher = makeMockDispatcher();
    await new LLMToolLoop(implicit.llm, implicitDispatcher.dispatcher, {
      systemPrompt: 'sys', maxRounds: 1,
    }, () => {}).run('我来了');
    assert.deepEqual(implicitDispatcher.sayCalls, ['你来啦']);
  });

  it('CROSS-001 · 隐式回复把自有任务写成系统执行时拦截并重写', async () => {
    const { llm, capturedCalls } = makeMockLLM([
      { toolCalls: [], content: '系统还在跑合成铁镐的任务（task-420 running），不是我在操作。' },
      { toolCalls: [], content: '我还在合成铁镐，材料已经齐了，正在处理最后一步。' },
    ]);
    const { dispatcher, sayCalls } = makeMockDispatcher();
    const loop = new LLMToolLoop(llm, dispatcher, { systemPrompt: 'sys', maxRounds: 2 }, () => {});

    await loop.run('现在做到哪了');

    assert.deepEqual(sayCalls, ['我还在合成铁镐，材料已经齐了，正在处理最后一步。']);
    const rewritePrompt = capturedCalls[1]?.messages.at(-1)?.content ?? '';
    assert.match(rewritePrompt, /身份一致性检查未通过/);
    assert.match(rewritePrompt, /都是你的内部能力/);
    assert.match(rewritePrompt, /现在做到哪了/);
  });

  it('BUG-CROSS-48 · 显式 say 连续违反身份边界时静默，不由代码代写', async () => {
    const { llm } = makeMockLLM([
      sayResp('后台程序正在替我挖石头。'),
      sayResp('GoalAgent 还在执行，不是我在操作。'),
    ]);
    const { dispatcher, sayCalls } = makeMockDispatcher();
    const loop = new LLMToolLoop(llm, dispatcher, { systemPrompt: 'sys', maxRounds: 2 }, () => {});

    await loop.run('石头挖好了吗');

    assert.deepEqual(sayCalls, []);
  });

  it('CROSS-001 · 第一人称回复仍含 task ID 与 running 时也必须重写', async () => {
    const { llm } = makeMockLLM([
      sayResp('我还在合成铁镐（task-420 running）。'),
      sayResp('我还在合成铁镐，正在处理最后一步。'),
    ]);
    const { dispatcher, sayCalls } = makeMockDispatcher();
    const loop = new LLMToolLoop(llm, dispatcher, { systemPrompt: 'sys', maxRounds: 2 }, () => {});

    await loop.run('现在做到哪了');

    assert.deepEqual(sayCalls, ['我还在合成铁镐，正在处理最后一步。']);
  });

  it('CROSS-001 · l7.thought 发布前归一化内部执行主体与调试标识', async () => {
    const published: Array<{ type: string; thought?: string }> = [];
    const bus = {
      publish: (type: string, _severity: string, payload: Record<string, unknown>) => {
        published.push({ type, thought: typeof payload.thought === 'string' ? payload.thought : undefined });
      },
    } as unknown as EventBusV2;
    const { llm } = makeMockLLM([
      fcResponse('say', { text: '我还在合成铁镐。' }, '系统还在跑合成任务（task-420 running）'),
    ]);
    const { dispatcher } = makeMockDispatcher();
    const loop = new LLMToolLoop(llm, dispatcher, { systemPrompt: 'sys', maxRounds: 1, bus }, () => {});

    await loop.run('现在做到哪了');

    const thought = published.find(event => event.type === 'l7.thought')?.thought ?? '';
    assert.match(thought, /我还在跑合成任务/);
    assert.doesNotMatch(thought, /系统|task-420|running/);
  });

  it('TC-COMP-08 · 受治理陪伴上下文在每轮 Prompt 热注入', async () => {
    const { llm, capturedCalls } = makeMockLLM([sayResp('收到')]);
    const { dispatcher } = makeMockDispatcher();
    const loop = new LLMToolLoop(llm, dispatcher, {
      systemPrompt: 'sys', maxRounds: 1,
      companionBlock: () => '── 陪伴上下文（辅助判断，不得当作用户事实）──\n核心人格 v1：诚实',
    }, () => {});
    await loop.run('你好');
    const system = String(capturedCalls[0]?.messages[0]?.content);
    assert.match(system, /陪伴上下文/);
    assert.match(system, /不得当作用户事实/);
  });

  // C-01
  it('C-01 · 单轮 say → ended=true, pendingAskMaster=false, rounds=1', async () => {
    const { llm } = makeMockLLM([sayResp()]);
    const { dispatcher, sayCalls } = makeMockDispatcher();
    const loop = new LLMToolLoop(llm, dispatcher, { systemPrompt: 'sys', maxRounds: 8 }, () => {});

    const result = await loop.run('跟着我', []);

    assert.equal(result.ended, true);
    assert.equal(result.pendingAskMaster, false);
    assert.equal(result.rounds, 1);
    assert.equal(sayCalls.length, 1);
    assert.equal(result.history.at(-1)?.call.tool, 'say');
    assert.equal(result.history.at(-1)?.call.input.text, sayCalls[0]);
    assert.equal(sayCalls[0], '好的！');
  });

  // C-02
  it('C-02 · 单轮 ask_master → pendingAskMaster=true, history 含 ask_master', async () => {
    const { llm } = makeMockLLM([askResp()]);
    const { dispatcher, askCalls } = makeMockDispatcher();
    const loop = new LLMToolLoop(llm, dispatcher, { systemPrompt: 'sys', maxRounds: 8 }, () => {});

    const result = await loop.run('帮我种田', []);

    assert.equal(result.pendingAskMaster, true);
    assert.equal(result.ended, false);
    assert.equal(result.rounds, 1);
    assert.equal(askCalls.length, 1);
    assert.ok(result.history.some(h => h.call.tool === 'ask_master'), 'history 应含 ask_master');
  });

  // C-03
  it('C-03 · LLM 返回 null → 无大脑决定，静默结束', async () => {
    const { llm } = makeMockLLM([null]);
    const { dispatcher, sayCalls } = makeMockDispatcher();
    const loop = new LLMToolLoop(llm, dispatcher, { systemPrompt: 'sys', maxRounds: 8 }, () => {});

    const result = await loop.run('你好', []);

    assert.equal(result.ended, true);
    assert.equal(result.pendingAskMaster, false);
    assert.equal(sayCalls.length, 0);
  });

  it('BUG-CROSS-48 · 余额错误只进系统状态，不伪装成角色回复', async () => {
    const llm = {
      callWithTools: async (args: { onError?: (failure: { kind: 'billing'; status: number }) => void }) => {
        args.onError?.({ kind: 'billing', status: 402 });
        return null;
      },
    } as unknown as LLMClient;
    const { dispatcher, sayCalls } = makeMockDispatcher();
    const loop = new LLMToolLoop(llm, dispatcher, { systemPrompt: 'sys', maxRounds: 1 }, () => {});

    await loop.run('你好');

    assert.equal(sayCalls.length, 0);
  });

  it('BUG-CROSS-43 · 各失败类型只输出安全、可恢复提示', () => {
    assert.match(llmFailureMessage({ kind: 'auth', status: 401 }), /检查 API Key/);
    assert.match(llmFailureMessage({ kind: 'rate_limit', status: 429 }), /稍后再试/);
    assert.match(llmFailureMessage({ kind: 'timeout' }), /响应超时/);
    assert.match(llmFailureMessage({ kind: 'unavailable', status: 503 }), /暂时不可用/);
  });

  // C-04 · 替换原"JSON 解析失败"用例 —— function calling 没有 parse 失败的概念
  it('C-04 · 无 tool_calls 但有 content → content 转 say 结束', async () => {
    const llmResp: LLMToolCallResult = { toolCalls: [], content: '我想说点别的' };
    const { llm } = makeMockLLM([llmResp]);
    const { dispatcher, sayCalls } = makeMockDispatcher();
    const loop = new LLMToolLoop(llm, dispatcher, { systemPrompt: 'sys', maxRounds: 8 }, () => {});

    const result = await loop.run('你好', []);

    assert.equal(result.ended, true);
    assert.equal(result.rounds, 1);
    assert.equal(sayCalls.length, 1);
    assert.equal(sayCalls[0], '我想说点别的', 'content 应当作 say 文本');
  });

  it('BUG-CROSS-19 · abort 后 provider 迟到返回也不得派发旧 turn 工具', async () => {
    let resolveCall!: (value: LLMToolCallResult | null) => void;
    const llm = {
      callWithTools: async (): Promise<LLMToolCallResult | null> =>
        new Promise(resolve => { resolveCall = resolve; }),
    } as unknown as LLMClient;
    const { dispatcher, sayCalls } = makeMockDispatcher();
    const loop = new LLMToolLoop(llm, dispatcher, { systemPrompt: 'sys', maxRounds: 1 }, () => {});
    const controller = new AbortController();

    const pending = loop.run('执行旧目标', [], controller.signal);
    await Promise.resolve();
    controller.abort();
    resolveCall(sayResp('旧目标完成'));

    await assert.rejects(pending, (error: unknown) =>
      error instanceof Error && error.name === 'AbortError');
    assert.equal(sayCalls.length, 0, '迟到 tool call 不得执行');
  });

  it('BUG-CROSS-15 · 任务类纯文本假完成先过 LoopCritic，不得直接说出口', async () => {
    const { llm, capturedCalls } = makeMockLLM([
      { toolCalls: [], content: '我已经在金块旁边了。' },
      askResp('请告诉我金块的当前坐标。'),
    ]);
    const { dispatcher, sayCalls, askCalls } = makeMockDispatcher();
    const loop = new LLMToolLoop(llm, dispatcher, {
      systemPrompt: 'sys', maxRounds: 4, loopCritic: new MainBrainLoopCritic(),
    }, () => {});

    const result = await loop.run('走到金块那里', []);

    assert.equal(result.rounds, 2);
    assert.deepEqual(sayCalls, [], '旧记忆产生的纯文本假完成不得发出');
    assert.deepEqual(askCalls, ['请告诉我金块的当前坐标。']);
    assert.equal(capturedCalls[1]?.messages.some(message => /LoopCritic block/.test(String(message.content))), true);
  });

  it('BUG-CROSS-56 · 游戏意图被拦后强制下一轮提交 GoalAgent', async () => {
    const { llm, capturedCalls } = makeMockLLM([
      { toolCalls: [], content: '我已经采到了。' },
      fcResponse('submit_goal_request', { requestText: '采集1个橡木原木', requestKind: 'task' }),
    ]);
    const { dispatcher, sayCalls } = makeMockDispatcher();
    const submissions: ToolCall[] = [];
    dispatcher.toLLMSchemas = () => [{
      type: 'function',
      function: {
        name: 'submit_goal_request', description: 'delegate game intent',
        parameters: { type: 'object', properties: {}, additionalProperties: true },
      },
    }];
    const originalGet = dispatcher.get.bind(dispatcher);
    dispatcher.get = name => name === 'submit_goal_request'
      ? { name, description: 'delegate game intent', schema: {}, terminal: 'end_turn', handler: () => ({ ok: true, result: {} }) } as never
      : originalGet(name);
    const originalCall = dispatcher.call.bind(dispatcher);
    dispatcher.call = call => {
      if (call.tool === 'submit_goal_request') {
        submissions.push(call);
        return { ok: true, result: { accepted: true } };
      }
      return originalCall(call);
    };
    const loop = new LLMToolLoop(llm, dispatcher, {
      systemPrompt: 'sys', maxRounds: 3, loopCritic: new MainBrainLoopCritic(),
    }, () => {});

    const result = await loop.run('采集1个橡木原木', []);

    assert.equal(result.rounds, 2);
    assert.equal(submissions.length, 1);
    assert.deepEqual(sayCalls, []);
    assert.deepEqual(capturedCalls[1]?.toolChoice, {
      type: 'function', function: { name: 'submit_goal_request' },
    });
  });

  it('BUG-CROSS-73-005 · 别跟了的口头假取消被强制改为 cancel 委托', async () => {
    const { llm, capturedCalls } = makeMockLLM([
      { toolCalls: [], content: '好的，那我就不跟着啦。' },
      fcResponse('submit_goal_request', { requestText: '我停下了', requestKind: 'task' }),
    ]);
    const { dispatcher, sayCalls } = makeMockDispatcher();
    const submissions: ToolCall[] = [];
    dispatcher.toLLMSchemas = () => [{
      type: 'function',
      function: {
        name: 'submit_goal_request', description: 'delegate game intent',
        parameters: { type: 'object', properties: {}, additionalProperties: true },
      },
    }];
    const originalGet = dispatcher.get.bind(dispatcher);
    dispatcher.get = name => name === 'submit_goal_request'
      ? { name, description: 'delegate game intent', schema: {}, terminal: 'end_turn', handler: () => ({ ok: true, result: {} }) } as never
      : originalGet(name);
    const originalCall = dispatcher.call.bind(dispatcher);
    dispatcher.call = call => {
      if (call.tool === 'submit_goal_request') {
        submissions.push(call);
        return { ok: true, result: { accepted: true } };
      }
      return originalCall(call);
    };
    const loop = new LLMToolLoop(llm, dispatcher, {
      systemPrompt: 'sys', maxRounds: 3, loopCritic: new MainBrainLoopCritic(),
    }, () => {});

    await loop.run('别跟了', []);

    assert.deepEqual(sayCalls, []);
    assert.deepEqual(submissions, [{
      tool: 'submit_goal_request',
      input: { requestText: '别跟了', requestKind: 'cancel' },
    }]);
    assert.deepEqual(capturedCalls[1]?.toolChoice, {
      type: 'function', function: { name: 'submit_goal_request' },
    });
  });

  it('BUG-CROSS-56 · 强制工具仍连续违约时耗尽路径不放行纯文本', async () => {
    const { llm, capturedCalls } = makeMockLLM([
      { toolCalls: [], content: '已经完成。' },
      { toolCalls: [], content: '真的完成了。' },
      { toolCalls: [], content: '相信我，完成了。' },
    ]);
    const { dispatcher, sayCalls } = makeMockDispatcher();
    const submissions: ToolCall[] = [];
    dispatcher.toLLMSchemas = () => [{
      type: 'function',
      function: {
        name: 'submit_goal_request', description: 'delegate game intent',
        parameters: { type: 'object', properties: {}, additionalProperties: true },
      },
    }];
    const originalCall = dispatcher.call.bind(dispatcher);
    dispatcher.call = call => {
      if (call.tool === 'submit_goal_request') {
        submissions.push(call);
        return { ok: true, result: { accepted: true } };
      }
      return originalCall(call);
    };
    const loop = new LLMToolLoop(llm, dispatcher, {
      systemPrompt: 'sys', maxRounds: 3, loopCritic: new MainBrainLoopCritic(),
    }, () => {});

    const result = await loop.run('采集1个橡木原木', []);

    assert.equal(result.rounds, 3);
    assert.deepEqual(sayCalls, []);
    assert.deepEqual(submissions, [{
      tool: 'submit_goal_request',
      input: { requestText: '采集1个橡木原木', requestKind: 'task' },
    }]);
    assert.deepEqual(capturedCalls[1]?.toolChoice, {
      type: 'function', function: { name: 'submit_goal_request' },
    });
    assert.deepEqual(capturedCalls[2]?.toolChoice, {
      type: 'function', function: { name: 'submit_goal_request' },
    });
  });

  it('BUG-CROSS-56 · MainBrain 提交 GoalAgent 时保留玩家完整高层原文', async () => {
    const original = '请创建10个不可合并的有序任务，让背包最终有10个橡木原木';
    const { llm } = makeMockLLM([
      fcResponse('submit_goal_request', { requestText: '背包有1个原木', requestKind: 'query' }),
    ]);
    const { dispatcher } = makeMockDispatcher();
    const submissions: ToolCall[] = [];
    dispatcher.toLLMSchemas = () => [{
      type: 'function',
      function: {
        name: 'submit_goal_request', description: 'delegate game intent',
        parameters: { type: 'object', properties: {}, additionalProperties: true },
      },
    }];
    const originalGet = dispatcher.get.bind(dispatcher);
    dispatcher.get = name => name === 'submit_goal_request'
      ? { name, description: 'delegate game intent', schema: {}, terminal: 'end_turn', handler: () => ({ ok: true, result: {} }) } as never
      : originalGet(name);
    const originalCall = dispatcher.call.bind(dispatcher);
    dispatcher.call = call => {
      if (call.tool === 'submit_goal_request') {
        submissions.push(call);
        return { ok: true, result: { accepted: true } };
      }
      return originalCall(call);
    };
    const loop = new LLMToolLoop(llm, dispatcher, {
      systemPrompt: 'sys', maxRounds: 2, loopCritic: new MainBrainLoopCritic(),
    }, () => {});

    await loop.run(original, []);

    assert.deepEqual(submissions, [{
      tool: 'submit_goal_request',
      input: { requestText: original, requestKind: 'task' },
    }]);
  });

  it('BUG-CROSS-62 · MainBrain 将误报为 query 的箱间搬运请求纠正为 task', async () => {
    const original = '把左边箱子里的八根橡木原木搬到右边箱子';
    const { llm } = makeMockLLM([
      fcResponse('submit_goal_request', { requestText: '右边箱子里有什么', requestKind: 'query' }),
    ]);
    const { dispatcher } = makeMockDispatcher();
    const submissions: ToolCall[] = [];
    dispatcher.toLLMSchemas = () => [{
      type: 'function',
      function: {
        name: 'submit_goal_request', description: 'delegate game intent',
        parameters: { type: 'object', properties: {}, additionalProperties: true },
      },
    }];
    const originalGet = dispatcher.get.bind(dispatcher);
    dispatcher.get = name => name === 'submit_goal_request'
      ? { name, description: 'delegate game intent', schema: {}, terminal: 'end_turn', handler: () => ({ ok: true, result: {} }) } as never
      : originalGet(name);
    const originalCall = dispatcher.call.bind(dispatcher);
    dispatcher.call = call => {
      if (call.tool === 'submit_goal_request') {
        submissions.push(call);
        return { ok: true, result: { accepted: true } };
      }
      return originalCall(call);
    };
    const loop = new LLMToolLoop(llm, dispatcher, {
      systemPrompt: 'sys', maxRounds: 2, loopCritic: new MainBrainLoopCritic(),
    }, () => {});

    await loop.run(original, []);

    assert.deepEqual(submissions, [{
      tool: 'submit_goal_request',
      input: { requestText: original, requestKind: 'task' },
    }]);
  });

  // C-05
  it('C-05 · 超过 maxRounds → 静默结束, rounds=maxRounds', async () => {
    const responses = [worldResp(), worldResp(), worldResp()];
    const { llm } = makeMockLLM(responses);
    const { dispatcher, sayCalls } = makeMockDispatcher();
    const loop = new LLMToolLoop(llm, dispatcher, { systemPrompt: 'sys', maxRounds: 3 }, () => {});

    const result = await loop.run('你好', []);

    assert.equal(result.ended, true);
    assert.equal(result.pendingAskMaster, false);
    assert.equal(result.rounds, 3, 'rounds 应等于 maxRounds');
    assert.equal(sayCalls.length, 0);
  });

  // C-06
  it('C-06 · resume turn：priorHistory 还原为 assistant+tool 消息对', async () => {
    const { llm, capturedCalls } = makeMockLLM([sayResp()]);
    const { dispatcher } = makeMockDispatcher();
    const loop = new LLMToolLoop(llm, dispatcher, { systemPrompt: 'sys', maxRounds: 8 }, () => {});

    const priorHistory: HistoryEntry[] = [
      {
        call: { tool: 'ask_master', input: { text: '要 A 还是 B？' } },
        result: { ok: true, result: { ok: true, pending: true } },
        toolCallId: 'call_prior_ask',
      },
    ];

    await loop.run('选 A 吧', priorHistory);

    assert.ok(capturedCalls.length >= 1, '应有至少 1 次 callWithTools 调用');
    const msgs = capturedCalls[0]!.messages;
    // system + assistant(prior ask_master) + tool(prior result) + user(本轮答复) = 4 条
    assert.ok(msgs.length >= 4, `resume 后 messages 应至少 4 条，实际 ${msgs.length}`);
    assert.equal(msgs[0]!.role, 'system');
    assert.ok(msgs[0]!.content.includes('ask_master 后的恢复') || msgs[0]!.content.includes('恢复'),
      'system 段应有 resume 提示');
    // 找到 prior ask_master 的 assistant 消息
    const assistantIdx = msgs.findIndex(m => m.role === 'assistant' && (m.tool_calls?.[0]?.function.name === 'ask_master'));
    assert.ok(assistantIdx >= 0, 'priorHistory 应还原成 assistant tool_call 消息');
    // BUG-L7 根治断言：本轮主人答复必须排在「问题之后」（时序正确），
    //   否则 LLM 看不到答案、逐字重发同一句澄清（死循环）。
    //   注：messages 数组在 run 结束后会被 say 终结轮追加污染，故按内容定位而非取末位。
    const userIdx = msgs.findIndex(m => m.role === 'user' && m.content === '选 A 吧');
    assert.ok(userIdx >= 0, '本轮主人答复应作为 user 消息进入上下文');
    assert.ok(userIdx > assistantIdx, '主人答复必须排在 ask_master 提问之后（时序正确）');
  });

  it('FEAT-CROSS-22 · ask-master continuation preserves native replay and does not rerun history tools', async () => {
    const firstLLM = makeMockLLM([responsesAskResp()]);
    const tools = makeMockDispatcher();
    const firstLoop = new LLMToolLoop(firstLLM.llm, tools.dispatcher, { systemPrompt: 'sys', maxRounds: 2 }, () => {});
    const pending = await firstLoop.run('帮我选方案', []);
    assert.equal(pending.pendingAskMaster, true);
    assert.equal(tools.askCalls.length, 1);
    assert.equal(pending.history[0]?.assistant?.canonical?.source?.replay?.blocks[0]?.encrypted_content, 'opaque-main');

    const restored = restoreMainBrainPendingHistory(serializeMainBrainPendingHistory(pending.history));
    assert.ok(restored);
    const resumedLLM = makeMockLLM([sayResp('选 A 就好')]);
    const resumedLoop = new LLMToolLoop(resumedLLM.llm, tools.dispatcher, { systemPrompt: 'sys', maxRounds: 2 }, () => {});
    await resumedLoop.run('选 A', restored!);

    assert.equal(tools.askCalls.length, 1, 'historical ask_master must not execute during replay');
    const messages = resumedLLM.capturedCalls[0]!.messages;
    const exact = new ResponsesCodec().buildRequest({
      messages: canonicalizeChatMessages(messages.slice(0, 4)),
      tools: [],
    }, { routeId: 'route-responses', baseUrl: 'https://api.openai.com/v1', model: 'gpt-test' });
    const input = exact.body.input as Array<Record<string, unknown>>;
    assert.ok(input.some(item => item.type === 'reasoning' && item.encrypted_content === 'opaque-main'));
    assert.equal(input.filter(item => item.type === 'function_call').length, 1);
    assert.equal(input.filter(item => item.type === 'function_call_output').length, 1);
  });

  it('FEAT-CROSS-22 · mismatched pending replay degrades as a whole to canonical history', async () => {
    const firstLLM = makeMockLLM([responsesAskResp()]);
    const tools = makeMockDispatcher();
    const firstLoop = new LLMToolLoop(firstLLM.llm, tools.dispatcher, { systemPrompt: 'sys', maxRounds: 2 }, () => {});
    const pending = await firstLoop.run('帮我选方案', []);
    const restored = restoreMainBrainPendingHistory(serializeMainBrainPendingHistory(pending.history))!;
    restored[0]!.assistant!.canonical!.source!.replay!.model = 'stale-model';

    const resumedLLM = makeMockLLM([sayResp('选 A 就好')]);
    await new LLMToolLoop(resumedLLM.llm, tools.dispatcher, { systemPrompt: 'sys', maxRounds: 2 }, () => {})
      .run('选 A', restored);
    const assistant = canonicalizeChatMessages(resumedLLM.capturedCalls[0]!.messages)
      .find(message => message.source?.replay);
    assert.ok(assistant);
    const decision = decideResponsesReplay(
      assistant!,
      { routeId: 'route-responses', baseUrl: 'https://api.openai.com/v1', model: 'gpt-test' },
    );
    assert.equal(decision.source, 'canonical-rebuild');
    assert.equal(decision.reason, 'model-mismatch');
    assert.equal(tools.askCalls.length, 1);

    const chat = new ChatCompletionsCodec().buildRequest({
      messages: canonicalizeChatMessages(resumedLLM.capturedCalls[0]!.messages.slice(0, 4)),
      tools: [],
    }, { routeId: 'route-chat', baseUrl: 'https://api.openai.com/v1', model: 'gpt-chat' });
    const chatMessages = chat.body.messages as Array<Record<string, unknown>>;
    assert.ok(chatMessages.some(message => Array.isArray(message.tool_calls)));
    assert.equal(chatMessages.filter(message => message.role === 'tool').length, 1);
    assert.doesNotMatch(JSON.stringify(chat.body), /opaque-main/);
  });

  it('FEAT-CROSS-13 · memoryBlock receives the current user message', async () => {
    const { llm, capturedCalls } = makeMockLLM([sayResp('我也记得。')]);
    const { dispatcher } = makeMockDispatcher();
    const seenQueries: string[] = [];
    const loop = new LLMToolLoop(llm, dispatcher, {
      systemPrompt: 'sys',
      maxRounds: 2,
      memoryBlock: query => {
        seenQueries.push(query);
        return `与“${query}”匹配的情景记忆：村庄北门击退僵尸`;
      },
      conversationBlock: () => '── 最近对话记录 ──\n用户：刚才只提到局部信息',
    }, () => {});

    await loop.run('上次打僵尸好惊险呀');

    assert.deepEqual(seenQueries, ['上次打僵尸好惊险呀']);
    const system = capturedCalls[0]!.messages[0]!.content;
    assert.match(system, /村庄北门击退僵尸/);
    assert.ok(system.indexOf('村庄北门击退僵尸') > system.indexOf('刚才只提到局部信息'));
  });

  // FEAT-L3-13 R3 · 拦截 LLM 把动作 JSON 当文字吐进聊天
  describe('stripLeakedActionJson', () => {
    it('整体就是动作块 → 返回空（走兜底文案）', () => {
      assert.equal(stripLeakedActionJson('{"thought":"x","action":{"tool":"get_world_state","input":{}}}'), '');
    });
    it('自然语言 + 尾部动作块 → 只保留自然语言', () => {
      const out = stripLeakedActionJson('主人就在我旁边，直接给他就行！ {"thought":"x","action":{"tool":"get_world_state","input":{}}}');
      assert.equal(out, '主人就在我旁边，直接给他就行！');
    });
    it('正常自然语言（含花括号但非动作块）不误杀', () => {
      assert.equal(stripLeakedActionJson('好的，我去做{这件事}'), '好的，我去做{这件事}');
    });
  });

  describe('parseLegacyActionJson', () => {
    it('接受完整旧动作及单层 JSON 代码围栏', () => {
      assert.deepEqual(
        parseLegacyActionJson('```json\n{"thought":"回应","action":{"tool":"say","input":{"text":"你好"}}}\n```'),
        { thought: '回应', call: { tool: 'say', input: { text: '你好' } } },
      );
    });

    it('拒绝混合自然语言、额外字段和非对象 input', () => {
      assert.equal(parseLegacyActionJson('先回应 {"thought":"x","action":{"tool":"say","input":{}}}'), null);
      assert.equal(parseLegacyActionJson('{"thought":"x","action":{"tool":"say","input":{}},"extra":true}'), null);
      assert.equal(parseLegacyActionJson('{"action":{"tool":"say","input":[]}}'), null);
    });
  });

  describe('BUG-CROSS-47 · 脱敏协议分类与 Prompt 快照', () => {
    function chatRegistry(): { registry: ToolRegistry; sayCalls: string[] } {
      const mock = makeMockDispatcher();
      const base = mock.dispatcher;
      const registry = {
        ...base,
        toLLMSchemas: () => [{ type: 'function', function: { name: 'say', description: '', parameters: {} } }],
        only: (names: readonly string[]) => ({
          ...base,
          toLLMSchemas: () => names.map(name => ({ type: 'function', function: { name, description: '', parameters: {} } })),
        }),
      } as unknown as ToolRegistry;
      return { registry, sayCalls: mock.sayCalls };
    }

    it('TC-47-01 · 生产 Prompt 不含旧 JSON 动作合同，仍含角色边界与原生工具规则', () => {
      const prompts = [buildMainBrainSystemPrompt({ ownerName: '朋友', botName: 'LanYi' })];
      for (const p of prompts) {
        assert.doesNotMatch(p, /"thought"|"action"\s*:\s*\{/);
        assert.doesNotMatch(p, /以 JSON (格式|形式|字符串) (输出|返回)/);
        assert.match(p, /原生工具调用接口|原生 tool call/);
        assert.match(p, /平等/);
      }
    });

    it('TC-47-02/03/04/05/06 · 五类响应产生脱敏分类日志，且不记录原始响应体', async () => {
      const logs: string[] = [];
      const events: string[] = [];
      const bus = {
        publish: (type: string, _severity: string, _payload: Record<string, unknown>) => { events.push(type); },
      } as unknown as EventBusV2;

      // 标准 tool_call
      {
        const { llm } = makeMockLLM([fcResponse('say', { text: '好呀' })]);
        const loop = new LLMToolLoop(llm, chatRegistry().registry, { systemPrompt: 'sys', maxRounds: 2, bus }, m => logs.push(m));
        await loop.run('一起玩吗');
        assert.ok(logs.some(l => l.includes('[protocol:standard_tool_call]') && l.includes('say')));
      }

      // 普通文本 → 隐式 say
      {
        const { llm } = makeMockLLM([{ toolCalls: [], content: '在呢，刚把院子围好了。' }]);
        const loop = new LLMToolLoop(llm, chatRegistry().registry, { systemPrompt: 'sys', maxRounds: 2, bus }, m => logs.push(m));
        await loop.run('在干嘛');
        assert.ok(logs.some(l => l.includes('[protocol:plain_content]')));
      }

      // 合法 legacy action → 白名单转换
      {
        const { llm } = makeMockLLM([{ toolCalls: [], content: '{"thought":"回一句","action":{"tool":"say","input":{"text":"你好呀"}}}' }]);
        const loop = new LLMToolLoop(llm, chatRegistry().registry, { systemPrompt: 'sys', maxRounds: 2, bus }, m => logs.push(m));
        await loop.run('你好');
        assert.ok(logs.some(l => l.includes('[protocol:legacy_action_adapted]') && l.includes('say')));
      }

      // 非法 legacy action → 一次纠正后 protocol_invalid，无通用兜底，无原始体泄漏
      {
        const raw = '{"thought":"x","action":{"tool":"hack","input":{}}}';
        const { llm } = makeMockLLM([{ toolCalls: [], content: raw }, { toolCalls: [], content: raw }]);
        const loop = new LLMToolLoop(llm, chatRegistry().registry, { systemPrompt: 'sys', maxRounds: 8, bus }, m => logs.push(m));
        const result = await loop.run('你好');
        assert.equal(result.ended, true);
        assert.ok(logs.some(l => l.includes('[protocol:protocol_retry]')));
        assert.ok(logs.some(l => l.includes('[protocol:protocol_invalid]')));
        assert.ok(events.includes('brain.turn_no_decision'));
      }

      // 空 message → 纠正一次后 protocol_invalid，不显示“我没太接住”
      {
        const { llm } = makeMockLLM([{ toolCalls: [], content: '' }, { toolCalls: [], content: '' }]);
        const { registry, sayCalls } = chatRegistry();
        const loop = new LLMToolLoop(llm, registry, { systemPrompt: 'sys', maxRounds: 8, bus }, m => logs.push(m));
        await loop.run('你好');
        assert.ok(logs.some(l => l.includes('[protocol:protocol_invalid]')));
        assert.ok(sayCalls.length === 0, '空 message 不得转成 say');
      }

      // 脱敏：任何分类日志都不得包含原始 JSON 响应体
      assert.ok(!logs.some(l => l.includes('{"thought"')));
      assert.ok(!logs.some(l => l.includes('"action"')));
    });
  });

});
