import type {
  CanonicalLlmCall,
  CanonicalLlmMessage,
  CanonicalLlmResult,
  LlmContentBlock,
} from './types.js';
import { normalizeOpenAIResponsesUsage } from './usage.js';
import {
  LlmApiCodecError,
  type ExactModelRequest,
  type LlmApiCodec,
  type LlmCodecRoute,
} from './apiCodec.js';

type JsonRecord = Record<string, unknown>;

/** Stateless OpenAI Responses codec. Local canonical history remains authoritative. */
export class ResponsesCodec implements LlmApiCodec {
  readonly api = 'openai-responses' as const;

  buildRequest(call: CanonicalLlmCall, route: LlmCodecRoute): ExactModelRequest {
    const instructions = call.messages
      .filter(message => message.role === 'system')
      .flatMap(message => textBlocks(message))
      .join('\n\n');
    const input: JsonRecord[] = [];
    let nativeMessages = 0;
    let rebuiltMessages = 0;
    const replayReasons = new Set<string>();
    for (const message of call.messages) {
      if (message.role === 'system') continue;
      if (message.role === 'assistant' && message.source?.replay) {
        const decision = decideResponsesReplay(message, route);
        input.push(...decision.items);
        if (decision.source === 'native-replay') nativeMessages += 1;
        else {
          rebuiltMessages += 1;
          if (decision.reason) replayReasons.add(decision.reason);
        }
        continue;
      }
      input.push(...rebuildResponsesInput(message));
    }
    const body: Record<string, unknown> = {
      model: route.model,
      input,
      store: false,
      include: ['reasoning.encrypted_content'],
      ...(instructions ? { instructions } : {}),
      ...(call.tools.length ? {
        tools: call.tools.map(tool => ({
          type: 'function',
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        })),
      } : {}),
      ...(call.tools.length && call.toolChoice !== undefined
        ? { tool_choice: toResponsesToolChoice(call.toolChoice) }
        : {}),
      ...(call.tools.length && route.baseUrl.toLowerCase().includes('deepseek')
        ? { reasoning: { effort: 'none' } }
        : {}),
      ...(call.temperature === undefined ? {} : { temperature: call.temperature }),
      ...(call.maxTokens === undefined ? {} : { max_output_tokens: call.maxTokens }),
    };
    return {
      path: '/responses',
      body,
      ...(nativeMessages || rebuiltMessages ? {
        replay: {
          nativeMessages,
          rebuiltMessages,
          reasons: [...replayReasons],
        },
      } : {}),
    };
  }

  parseResponse(raw: unknown, route: LlmCodecRoute): CanonicalLlmResult {
    if (!isRecord(raw)) throw new LlmApiCodecError('Responses payload must be an object');
    const content: LlmContentBlock[] = [];
    const replayBlocks: Array<Record<string, unknown> | null> = [];
    const output = Array.isArray(raw.output) ? raw.output : [];

    for (const item of output) {
      if (!isRecord(item) || typeof item.type !== 'string') continue;
      if (item.type === 'reasoning') {
        const summary = Array.isArray(item.summary)
          ? item.summary
              .filter(isRecord)
              .filter(part => typeof part.text === 'string')
              .map(part => part.text as string)
              .join('\n')
          : '';
        const encrypted = typeof item.encrypted_content === 'string' ? item.encrypted_content : undefined;
        if (!summary && !encrypted) continue;
        content.push({ kind: 'reasoning', text: summary });
        replayBlocks.push(compactMetadata(item, ['id', 'type', 'status', 'encrypted_content', 'summary']));
        continue;
      }

      if (item.type === 'message') {
        const parts = Array.isArray(item.content) ? item.content : [];
        const text = parts
          .filter(isRecord)
          .filter(part => part.type === 'output_text' && typeof part.text === 'string')
          .map(part => part.text as string)
          .join('');
        if (!text) continue;
        content.push({ kind: 'text', text });
        replayBlocks.push({
          ...compactMetadata(item, ['id', 'type', 'status', 'role']),
          content: cloneJson(parts),
        });
        continue;
      }

      if (item.type === 'function_call') {
        if (typeof item.call_id !== 'string' || typeof item.name !== 'string' || typeof item.arguments !== 'string') {
          throw new LlmApiCodecError('Responses function_call is missing call_id, name or arguments');
        }
        let args: unknown;
        try {
          args = JSON.parse(item.arguments) as unknown;
        } catch {
          throw new LlmApiCodecError(`invalid tool arguments for call ${item.call_id}`);
        }
        content.push({ kind: 'tool-call', id: item.call_id, name: item.name, arguments: args });
        replayBlocks.push(compactMetadata(item, ['id', 'type', 'status', 'call_id']));
      }
    }

    const responseMetadata: Record<string, unknown> = compactMetadata(
      raw,
      ['id', 'object', 'status', 'created_at', 'completed_at', 'incomplete_details'],
    );
    return {
      content,
      usage: normalizeOpenAIResponsesUsage(raw.usage),
      finishReason: responseFinishReason(raw),
      replay: {
        kind: 'openai-native',
        version: 1,
        api: 'openai-responses',
        providerRoute: route.routeId,
        model: route.model,
        response: responseMetadata,
        blocks: replayBlocks,
      },
    };
  }
}

export interface ResponsesReplayDecision {
  items: JsonRecord[];
  source: 'native-replay' | 'canonical-rebuild';
  reason?: string;
}

/** All-or-nothing replay validation. Never mixes native and rebuilt blocks. */
export function decideResponsesReplay(
  message: CanonicalLlmMessage,
  route: LlmCodecRoute,
): ResponsesReplayDecision {
  const replay = message.source?.replay;
  if (!replay) return canonicalDecision(message, 'missing-envelope');
  if (replay.kind !== 'openai-native' || replay.version !== 1 || replay.api !== 'openai-responses') {
    return canonicalDecision(message, 'unsupported-envelope');
  }
  if (message.source?.providerRoute !== route.routeId || replay.providerRoute !== route.routeId) {
    return canonicalDecision(message, 'provider-route-mismatch');
  }
  if (message.source?.model !== route.model || replay.model !== route.model) {
    return canonicalDecision(message, 'model-mismatch');
  }
  if (replay.blocks.length !== message.content.length) {
    return canonicalDecision(message, 'block-count-mismatch');
  }

  const items: JsonRecord[] = [];
  for (let index = 0; index < message.content.length; index += 1) {
    const item = nativeItemFromBlock(message.content[index]!, replay.blocks[index]);
    if (!item) return canonicalDecision(message, `block-${index}-mismatch`);
    items.push(item);
  }
  return { items, source: 'native-replay' };
}

function canonicalDecision(message: CanonicalLlmMessage, reason: string): ResponsesReplayDecision {
  return { items: rebuildResponsesInput(message), source: 'canonical-rebuild', reason };
}

function rebuildResponsesInput(message: CanonicalLlmMessage): JsonRecord[] {
  const items: JsonRecord[] = [];
  const text = textBlocks(message).join('');
  if (message.role === 'user') {
    if (text) items.push({ role: 'user', content: [{ type: 'input_text', text }] });
  }

  for (const block of message.content) {
    if (block.kind === 'text' && message.role === 'assistant') {
      items.push({
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: block.text, annotations: [] }],
      });
    } else if (block.kind === 'reasoning') {
      // Reasoning without encrypted_content is not safe/useful to replay.
      continue;
    } else if (block.kind === 'tool-call') {
      items.push({
        type: 'function_call',
        call_id: block.id,
        name: block.name,
        arguments: JSON.stringify(block.arguments ?? {}),
      });
    } else if (block.kind === 'tool-result') {
      items.push({
        type: 'function_call_output',
        call_id: block.callId,
        output: block.output,
      });
    }
  }
  return items;
}

function nativeItemFromBlock(
  block: LlmContentBlock,
  metadata: Record<string, unknown> | null,
): JsonRecord | null {
  if (!metadata || !isRecord(metadata) || typeof metadata.type !== 'string') return null;
  if (block.kind === 'reasoning') {
    if (metadata.type !== 'reasoning') return null;
    const summary = Array.isArray(metadata.summary)
      ? metadata.summary
          .filter(isRecord)
          .filter(part => typeof part.text === 'string')
          .map(part => part.text as string)
          .join('\n')
      : '';
    if (summary !== block.text) return null;
    return cloneRecord(metadata);
  }
  if (block.kind === 'text') {
    if (metadata.type !== 'message' || !Array.isArray(metadata.content)) return null;
    const text = metadata.content
      .filter(isRecord)
      .filter(part => part.type === 'output_text' && typeof part.text === 'string')
      .map(part => part.text as string)
      .join('');
    if (text !== block.text) return null;
    return cloneRecord(metadata);
  }
  if (block.kind === 'tool-call') {
    if (metadata.type !== 'function_call' || metadata.call_id !== block.id) return null;
    return {
      ...cloneRecord(metadata),
      call_id: block.id,
      name: block.name,
      arguments: JSON.stringify(block.arguments ?? {}),
    };
  }
  return null;
}

function textBlocks(message: CanonicalLlmMessage): string[] {
  return message.content
    .filter((block): block is Extract<LlmContentBlock, { kind: 'text' }> => block.kind === 'text')
    .map(block => block.text);
}

function toResponsesToolChoice(choice: NonNullable<CanonicalLlmCall['toolChoice']>): unknown {
  if (typeof choice === 'string') return choice;
  return { type: 'function', name: choice.name };
}

function responseFinishReason(raw: JsonRecord): string {
  if (raw.status === 'incomplete' && isRecord(raw.incomplete_details)
    && typeof raw.incomplete_details.reason === 'string') {
    return raw.incomplete_details.reason;
  }
  return typeof raw.status === 'string' ? raw.status : 'completed';
}

function compactMetadata(value: JsonRecord, keys: string[]): JsonRecord {
  const output: JsonRecord = {};
  for (const key of keys) {
    if (!(key in value)) continue;
    output[key] = cloneJson(value[key]);
  }
  return output;
}

function cloneJson(value: unknown): unknown {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value)) as unknown;
}

function cloneRecord(value: JsonRecord): JsonRecord {
  return cloneJson(value) as JsonRecord;
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
