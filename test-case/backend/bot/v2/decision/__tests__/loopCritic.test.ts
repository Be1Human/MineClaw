/**
 * LoopCritic · 单测（FEAT-L7-15 · 决策面自检）
 * 核心：拦"任务类指令但没干活就想 say 收尾"的假完成；闲聊/已干活/ask_master 放行。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MainBrainLoopCritic } from '../../../../../../apps/minecraft-companion/src/bot/v2/decision/loopCritic.js';
import type { ToolCall, ToolResult } from '../../../../../../apps/minecraft-companion/src/bot/v2/decision/tools/types.js';

const ok: ToolResult = { ok: true, result: {} };
const hist = (...tools: string[]) =>
  tools.map((t) => ({ call: { tool: t, input: {} } as ToolCall, result: ok }));

const critic = new MainBrainLoopCritic();

test('T1 · 任务类指令 + 没干活 + 想 say 收尾 → block（假完成）', () => {
  const v = critic.judge({
    call: { tool: 'say', input: { text: '好嘞这就去!' } },
    history: [], userMessage: '帮我采点橡木', isTerminalIntent: true,
  });
  assert.equal(v.action, 'block', v.reason);
  assert.ok(v.hint && v.hint.length > 0);
});

test('T2 · 任务类指令 + 已提交 GoalAgent → pass（合理收尾）', () => {
  const v = critic.judge({
    call: { tool: 'say', input: { text: '采好啦' } },
    history: hist('submit_goal_request'), userMessage: '帮我采点橡木', isTerminalIntent: true,
  });
  assert.equal(v.action, 'pass');
});

test('T3 · 纯闲聊（无任务动作词）+ 想 say → pass（不误拦聊天）', () => {
  const v = critic.judge({
    call: { tool: 'say', input: { text: '我也想你啦~' } },
    history: [], userMessage: '你今天开心吗', isTerminalIntent: true,
  });
  assert.equal(v.action, 'pass');
});

test('T4 · ask_master 终止意图 → pass（负责任收尾，不算假完成）', () => {
  const v = critic.judge({
    call: { tool: 'ask_master', input: { question: '采什么木头?' } },
    history: [], userMessage: '帮我采点东西', isTerminalIntent: true,
  });
  assert.equal(v.action, 'pass');
});

test('T5 · 非终止工具 → pass（只治理收尾动作）', () => {
  const v = critic.judge({
    call: { tool: 'save_memory', input: { text: '喜欢橡木' } },
    history: [], userMessage: '帮我采点橡木', isTerminalIntent: false,
  });
  assert.equal(v.action, 'pass');
});

test('T6b · 咨询/讨论（"帮我想想怎么种田"）+ say → pass（不误拦请教）', () => {
  const v = critic.judge({
    call: { tool: 'say', input: { text: '可以先找块平地…' } },
    history: [], userMessage: 'MineFriend 帮我想想怎么种田', isTerminalIntent: true,
  });
  assert.equal(v.action, 'pass', v.reason);
});

test('T6 · 任务类指令 + 历史只有 ask_master（澄清过）→ pass', () => {
  const v = critic.judge({
    call: { tool: 'say', input: { text: '好的' } },
    history: hist('ask_master'), userMessage: '去把铁矿挖了', isTerminalIntent: true,
  });
  assert.equal(v.action, 'pass');
});

test('V3 · 跟我来只 say → block，并要求走 GoalAgentPort', () => {
  const v = critic.judge({
    call: { tool: 'say', input: { text: '好，我跟着你。' } },
    history: [], userMessage: '跟我来', isTerminalIntent: true,
  });
  assert.equal(v.action, 'block');
  assert.match(v.hint ?? '', /submit_goal_request/);
});

test('V3 · 游戏查询只 say → block', () => {
  const v = critic.judge({
    call: { tool: 'say', input: { text: '我背包里有木头。' } },
    history: [], userMessage: '你背包里有什么', isTerminalIntent: true,
  });
  assert.equal(v.action, 'block');
});

test('BUG-CROSS-73-005 · 别跟了不得用 say 冒充取消', () => {
  const v = critic.judge({
    call: { tool: 'say', input: { text: '好的，那我就不跟着啦。' } },
    history: [], userMessage: '别跟了', isTerminalIntent: true,
  });
  assert.equal(v.action, 'block');
  assert.match(v.reason, /game_cancel/);
  assert.match(v.hint ?? '', /submit_goal_request/);
});

test('V3 · submit_goal_request 是合法委托终止 → pass', () => {
  const v = critic.judge({
    call: { tool: 'submit_goal_request', input: { requestText: '跟随主人', requestKind: 'task' } },
    history: [], userMessage: '跟我来', isTerminalIntent: true,
  });
  assert.equal(v.action, 'pass');
});

test('V3 · 含动作词的讨论与故事请求仍是聊天 → pass', () => {
  for (const message of ['帮我想想怎么种田', '跟我讲个故事']) {
    const v = critic.judge({
      call: { tool: 'say', input: { text: '当然。' } },
      history: [], userMessage: message, isTerminalIntent: true,
    });
    assert.equal(v.action, 'pass', message);
  }
});

test('V3 · IDLE/内部续接不是玩家动作意图，不得被逼出自主目标', () => {
  for (const message of ['[idle] 当前无任务，主动找事做', '[内部状态触发，不是朋友发言] 请根据事实决定', '[内部任务续接，不是朋友的新发言] 请继续处理同一个玩家任务']) {
    const v=critic.judge({call:{tool:'say',input:{text:'先保持空闲。'}},history:[],userMessage:message,isTerminalIntent:true});
    assert.equal(v.action,'pass',message);
  }
});
