/**
 * 工具定义 · 对话域
 *   say · ask_master · propose_chat（内部通路 · 不暴露给 LLM）
 */

import type { ToolDefinition } from '../types.js';

export const speechTools: ToolDefinition[] = [
  {
    name: 'say',
    description: '自然回应朋友（结束本轮）',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
    terminal: 'end_turn',
    execute(input, ctx) {
      const text = input.text as string;
      ctx.speak(text, 'say');
      return { ok: true };
    },
  },
  {
    name: 'ask_master',
    description: '需要关键信息时向朋友澄清（结束本轮 · 对方答复后自动恢复）',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
    terminal: 'ask_master',
    execute(input, ctx) {
      const text = input.text as string;
      ctx.speak(text, 'ask_master');
      return { ok: true, pending: true };
    },
  },
  {
    name: 'stay_silent',
    description: '已了解内部状态，但判断现在不需要打扰朋友（静默结束本轮）',
    parameters: { type: 'object', properties: {} },
    terminal: 'end_turn',
    execute() {
      return { ok: true, silent: true };
    },
  },
  {
    name: 'propose_chat',
    description: '（内部）主动闲聊通路 · 不暴露给 LLM schema',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
    hidden: true,
    execute(input, ctx) {
      const text = input.text as string;
      ctx.speak(text, 'say');
      return { ok: true };
    },
  },
];
