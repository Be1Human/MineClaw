import type {
  CanonicalLlmCall,
  CanonicalLlmMessage,
  CanonicalLlmResult,
  LLMChatMessage,
  LLMToolCallResult,
  LlmContentBlock,
} from './types.js';
import { normalizeOpenAICompatibleUsage } from './usage.js';
import {
  LlmApiCodecError,
  type ExactModelRequest,
  type LlmApiCodec,
  type LlmCodecRoute,
} from './apiCodec.js';

type JsonRecord = Record<string, unknown>;

/** OpenAI Chat Completions wire codec; it has no credential or transport logic. */
export class ChatCompletionsCodec implements LlmApiCodec {
  readonly api = 'openai-completions' as const;

  buildRequest(call: CanonicalLlmCall, route: LlmCodecRoute): ExactModelRequest {
    const body: Record<string, unknown> = {
      model: route.model,
      messages: toChatMessages(call.messages),
      ...(call.tools.length ? { tools: call.tools.map(tool => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      })) } : {}),
      ...(call.tools.length || call.toolChoice !== undefined
        ? { tool_choice: toChatToolChoice(call.toolChoice ?? 'auto') }
        : {}),
      temperature: call.temperature ?? (call.tools.length ? 0.1 : 0.7),
      max_tokens: call.maxTokens ?? (call.tools.length ? 512 : 1_500),
    };

    if (call.tools.length && route.baseUrl.toLowerCase().includes('deepseek')) {
      body.thinking = { type: 'disabled' };
    }

    const replayMessages = call.messages.filter(message => message.role === 'assistant' && message.source?.replay);
    return {
      path: '/chat/completions',
      body,
      ...(replayMessages.length ? {
        replay: {
          nativeMessages: 0,
          rebuiltMessages: replayMessages.length,
          reasons: ['api-mismatch'],
        },
      } : {}),
    };
  }

  parseResponse(raw: unknown, _route: LlmCodecRoute): CanonicalLlmResult {
    if (!isRecord(raw)) throw new LlmApiCodecError('Chat Completions response must be an object');
    const choices = Array.isArray(raw.choices) ? raw.choices : [];
    const choice = isRecord(choices[0]) ? choices[0] : undefined;
    const message = choice && isRecord(choice.message) ? choice.message : undefined;
    const content: LlmContentBlock[] = [];

    const reasoning = message && typeof message.reasoning_content === 'string'
      ? stripThink(message.reasoning_content)
      : '';
    if (reasoning) content.push({ kind: 'reasoning', text: reasoning });

    const text = message && typeof message.content === 'string' ? stripThink(message.content) : '';
    if (text) content.push({ kind: 'text', text });

    const toolCalls = message && Array.isArray(message.tool_calls) ? message.tool_calls : [];
    for (const candidate of toolCalls) {
      if (!isRecord(candidate) || typeof candidate.id !== 'string' || !isRecord(candidate.function)) continue;
      const name = candidate.function.name;
      const rawArguments = candidate.function.arguments;
      if (typeof name !== 'string' || typeof rawArguments !== 'string') continue;
      let args: unknown;
      try {
        args = JSON.parse(rawArguments) as unknown;
      } catch {
        throw new LlmApiCodecError(`invalid tool arguments for call ${candidate.id}`);
      }
      content.push({ kind: 'tool-call', id: candidate.id, name, arguments: args });
    }

    return {
      content,
      usage: normalizeOpenAICompatibleUsage(raw.usage),
      ...(choice && typeof choice.finish_reason === 'string' ? { finishReason: choice.finish_reason } : {}),
    };
  }
}

export function canonicalResultToLegacyToolResult(result: CanonicalLlmResult): LLMToolCallResult {
  return {
    content: result.content
      .filter((block): block is Extract<LlmContentBlock, { kind: 'text' }> => block.kind === 'text')
      .map(block => block.text)
      .join('\n'),
    toolCalls: result.content
      .filter((block): block is Extract<LlmContentBlock, { kind: 'tool-call' }> => block.kind === 'tool-call')
      .map(block => ({
        id: block.id,
        name: block.name,
        arguments: isRecord(block.arguments) ? block.arguments : {},
      })),
  };
}

export function canonicalResultToLegacyText(result: CanonicalLlmResult): string | null {
  const text = result.content
    .filter((block): block is Extract<LlmContentBlock, { kind: 'text' }> => block.kind === 'text')
    .map(block => block.text)
    .join('\n');
  if (text) return text;
  const reasoning = result.content
    .filter((block): block is Extract<LlmContentBlock, { kind: 'reasoning' }> => block.kind === 'reasoning')
    .map(block => block.text)
    .join('\n');
  return reasoning || null;
}

function toChatMessages(messages: readonly CanonicalLlmMessage[]): LLMChatMessage[] {
  const output: LLMChatMessage[] = [];
  for (const message of messages) {
    const text = message.content
      .filter((block): block is Extract<LlmContentBlock, { kind: 'text' }> => block.kind === 'text')
      .map(block => block.text)
      .join('\n');
    const toolCalls = message.content
      .filter((block): block is Extract<LlmContentBlock, { kind: 'tool-call' }> => block.kind === 'tool-call');

    if (message.role !== 'assistant') {
      output.push({ role: message.role, content: text });
    } else if (text || toolCalls.length) {
      output.push({
        role: 'assistant',
        content: text,
        ...(toolCalls.length ? {
          tool_calls: toolCalls.map(block => ({
            id: block.id,
            type: 'function' as const,
            function: { name: block.name, arguments: JSON.stringify(block.arguments ?? {}) },
          })),
        } : {}),
      });
    }

    for (const block of message.content) {
      if (block.kind !== 'tool-result') continue;
      output.push({ role: 'tool', content: block.output, tool_call_id: block.callId });
    }
  }
  return output;
}

function toChatToolChoice(choice: NonNullable<CanonicalLlmCall['toolChoice']>): unknown {
  if (typeof choice === 'string') return choice;
  return { type: 'function', function: { name: choice.name } };
}

function stripThink(value: string): string {
  return value
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<think>[\s\S]*$/i, '')
    .trim();
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
