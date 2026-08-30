import type {
  CanonicalLlmMessage,
  CanonicalLlmTool,
  LLMChatMessage,
  LLMToolSchema,
  LlmContentBlock,
} from './types.js';

/** Marks malformed legacy wire-shaped history before any tool can execute. */
export class LlmCanonicalizationError extends Error {
  readonly name = 'LlmCanonicalizationError';
}

/** Controlled compatibility entrance for existing Chat Completions callers. */
export function canonicalizeChatMessages(messages: readonly LLMChatMessage[]): CanonicalLlmMessage[] {
  return messages.map((message, messageIndex) => {
    const durable = cloneCanonicalMessage(message.canonical);
    if (durable && compatibleRole(message.role, durable.role)) return durable;

    const content: LlmContentBlock[] = [];
    if (message.role === 'tool') {
      if (!message.tool_call_id) {
        throw new LlmCanonicalizationError(`tool message ${messageIndex} is missing tool_call_id`);
      }
      content.push({ kind: 'tool-result', callId: message.tool_call_id, output: message.content });
      return { role: 'assistant', content };
    }

    if (message.content) content.push({ kind: 'text', text: message.content });
    for (const toolCall of message.tool_calls ?? []) {
      content.push({
        kind: 'tool-call',
        id: toolCall.id,
        name: toolCall.function.name,
        arguments: parseToolArguments(toolCall.function.arguments, messageIndex, toolCall.id),
      });
    }
    return { role: message.role, content };
  });
}

function cloneCanonicalMessage(value: unknown): CanonicalLlmMessage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Partial<CanonicalLlmMessage>;
  if (!['system', 'user', 'assistant'].includes(candidate.role ?? '')) return null;
  if (!Array.isArray(candidate.content) || !candidate.content.every(isContentBlock)) return null;
  if (candidate.source !== undefined) {
    if (!candidate.source || typeof candidate.source !== 'object') return null;
    if (typeof candidate.source.providerRoute !== 'string' || typeof candidate.source.model !== 'string') return null;
  }
  return JSON.parse(JSON.stringify(candidate)) as CanonicalLlmMessage;
}

function isContentBlock(value: unknown): value is LlmContentBlock {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const block = value as Partial<LlmContentBlock> & Record<string, unknown>;
  if (block.kind === 'text' || block.kind === 'reasoning') return typeof block.text === 'string';
  if (block.kind === 'tool-call') {
    return typeof block.id === 'string' && typeof block.name === 'string' && 'arguments' in block;
  }
  if (block.kind === 'tool-result') {
    return typeof block.callId === 'string' && typeof block.output === 'string';
  }
  return false;
}

function compatibleRole(
  legacy: LLMChatMessage['role'],
  canonical: CanonicalLlmMessage['role'],
): boolean {
  return legacy === 'tool' ? canonical === 'assistant' : legacy === canonical;
}

/** Removes the Chat-specific nested `function` wrapper from tool definitions. */
export function canonicalizeChatTools(tools: readonly LLMToolSchema[]): CanonicalLlmTool[] {
  return tools.map(tool => ({
    name: tool.function.name,
    description: tool.function.description,
    parameters: cloneRecord(tool.function.parameters),
  }));
}

function parseToolArguments(raw: string, messageIndex: number, callId: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new LlmCanonicalizationError(
      `assistant message ${messageIndex} has invalid JSON arguments for tool call ${callId}`,
    );
  }
}

function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}
